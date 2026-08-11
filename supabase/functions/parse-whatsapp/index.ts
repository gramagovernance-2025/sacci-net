// Takes a batch of WhatsApp messages (already parsed out of a chat export by
// the portal — sender, timestamp, body, attached filenames) and groups them
// into proposed log entries: patient updates, camps, saathi joinings, meetings,
// whatever the live log_types table currently contains. Staff reviews every
// proposed entry before anything saves; this function never writes to the
// database. Dedup against previously-imported messages happens client-side
// via the whatsapp_messages ledger, so this function only ever sees new
// messages.
import Anthropic from "npm:@anthropic-ai/sdk@0.112.1";
import { z } from "npm:zod@4.4.3";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk@0.112.1/helpers/zod";
import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { CORS_HEADERS, jsonResponse } from "../_shared/cors.ts";
import { PURPOSE_VALUES, STATUS_VALUES } from "../_shared/patient-fields.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const MATCH_CONFIDENCE_VALUES = ["high", "medium", "low", "none"] as const;

// The entry schema is built per-request because log_type is a dynamic enum —
// whatever names are active in log_types right now. 'Patient Update' entries
// carry the patient_* fields (same conventions as parse-bulk-update); every
// other type carries title/description/participants. source_message_indexes
// replaces parse-bulk-update's verbatim segment_text: the portal reconstructs
// source_text and attached media deterministically from the referenced
// messages, so the model never has to echo text back.
function buildSchema(logTypeNames: [string, ...string[]]) {
  const EntrySchema = z.object({
    log_type: z.enum(logTypeNames),
    occurred_on: z.string(),
    source_message_indexes: z.array(z.number()),
    title: z.string(),
    description: z.string(),
    participants: z.string(),
    matched_patient_code: z.string(),
    match_confidence: z.enum(MATCH_CONFIDENCE_VALUES),
    match_notes: z.string(),
    visit_notes: z.string(),
    status: z.enum(STATUS_VALUES),
    next_visit_date: z.string(),
    treatment: z.string(),
    medication: z.string(),
    next_test: z.string(),
    test_date: z.string(),
    med_date: z.string(),
    diagnosis: z.string(),
    committed_amount: z.string(),
    payment_amount: z.string(),
    payment_purpose: z.enum(PURPOSE_VALUES),
    payment_notes: z.string(),
  });
  return z.object({ entries: z.array(EntrySchema) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
    if (!profile || profile.role !== "staff") {
      return jsonResponse({ error: "Not authorized" }, 403);
    }

    const { messages } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return jsonResponse({ error: "messages is required" }, 400);
    }

    const { data: roster } = await admin
      .from("patients")
      .select("patient_code, name, village, block, status");
    if (!roster) return jsonResponse({ error: "Could not load the patient roster" }, 500);

    const { data: logTypes } = await admin
      .from("log_types")
      .select("name")
      .eq("active", true)
      .order("sort_order");
    if (!logTypes || logTypes.length === 0) {
      return jsonResponse({ error: "Could not load log types" }, 500);
    }
    const typeNames = logTypes.map((t: any) => t.name) as [string, ...string[]];

    const rosterText = roster
      .map((p: any) => `${p.patient_code} | ${p.name} | ${p.village ?? "—"}, ${p.block ?? "—"} | ${p.status ?? "—"}`)
      .join("\n");

    // Each message rendered with its own index and timestamp — the timestamps
    // are what let the model resolve "kal"/"aaj"/"mangalwar" per message
    // rather than against a single today's-date.
    const messagesText = messages
      .map((m: any, i: number) => {
        const attached = Array.isArray(m.media) && m.media.length
          ? ` [attached: ${m.media.join(", ")}]`
          : "";
        return `[${i}] ${m.sent_at} — ${m.sender}: ${m.body}${attached}`;
      })
      .join("\n");

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await anthropic.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      system:
        "You are a records assistant for SACCI, a cancer-care nonprofit in Muzaffarpur, Bihar. You are " +
        "reading messages from the staff's WhatsApp coordination group — field coordinators and program staff " +
        "arranging patient care, health camps, and other organizational work, mostly in Hinglish (Hindi written " +
        "in Latin script, mixed with English).\n\n" +
        "Each message is given as: [index] timestamp — sender: body, with attached filenames noted. Export " +
        "quirks to expect: a reply often begins with an echoed copy of the earlier message it quotes — ignore " +
        "the echoed part and read only the new text. Placeholders like \"12 photos\" or \"<Media omitted>\" " +
        "mean media was sent without loggable text.\n\n" +
        "Your job: group these messages into distinct loggable entries. A back-and-forth conversation about one " +
        "thing (e.g. arranging one patient's hospital visit across several messages and days) is ONE entry, not " +
        "several. Messages that are pure chatter or logistics supporting no entry produce nothing. For each " +
        "entry, source_message_indexes must list every message that contributed to it, including brief replies " +
        "like \"Ok\" that belong to that thread — these indexes are how staff traces the entry back to the raw " +
        "messages, so be complete.\n\n" +
        "Classify each entry's log_type from this list (the organization's current categories): " +
        typeNames.join(", ") + ". Use 'Patient Update' for anything about one specific patient's " +
        "care.\n\n" +
        "Roster (patient_code | name | village, block | status on file):\n" + rosterText + "\n\n" +
        "Dates: resolve every relative phrase against the timestamp of the message that says it — \"aaj\" means " +
        "that message's date, \"kal\" the day after it, a weekday name (\"mangalwar\", \"Tuesday\") the next such " +
        "day after it. When a plan is later superseded by a factual report (e.g. \"kal bhejenge\" followed two " +
        "days later by \"aaj bhej rahe hai\"), the facts win: occurred_on is the date it actually happened. Dates " +
        "are YYYY-MM-DD. occurred_on is required on every entry — best guess from the message dates if not " +
        "stated.\n\n" +
        "For 'Patient Update' entries: matched_patient_code must be a code from the roster above, or \"\" if you " +
        "cannot confidently tell which roster patient it refers to — explain why in match_notes so staff can pick " +
        "manually. Set match_confidence honestly: \"none\" whenever matched_patient_code is empty, \"low\" for an " +
        "unsure guess, \"high\"/\"medium\" otherwise. Leave a field as empty string when the messages don't " +
        "mention it (read as \"no change\", never zero/false), never invent facts, and write visit_notes as a " +
        "light cleanup of the thread that preserves non-clinical detail near-verbatim — who accompanied the " +
        "patient, family hesitations, hospital choices, money worries, and similar social/logistical color " +
        "matter as much as the medical facts; this record feeds the nonprofit's own storytelling later. Extract " +
        "payment_amount/payment_purpose/payment_notes only when a concrete amount of money is mentioned, and " +
        "committed_amount only for a total estimated/committed cost of care. Leave title and participants empty " +
        "for these entries.\n\n" +
        "For every other log_type: leave all patient fields empty. Fill title (a short label, e.g. \"Health camp " +
        "in Motipur panchayat\"), participants (who was involved, as named), and description — same " +
        "near-verbatim, don't-sanitize principle as visit_notes.",
      messages: [
        { role: "user", content: `WhatsApp messages:\n${messagesText}` },
      ],
      // medium effort: extraction doesn't need deep reasoning, and the edge
      // runtime enforces a wall-clock limit — the portal additionally chunks
      // large exports (~45 messages per call) to stay under it.
      output_config: { effort: "medium", format: zodOutputFormat(buildSchema(typeNames)) },
    });

    const parsed = response.parsed_output;
    if (!parsed) return jsonResponse({ error: "Could not parse the messages" }, 502);

    return jsonResponse(parsed, 200);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
