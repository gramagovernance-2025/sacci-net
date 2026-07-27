// Takes one free-text note that may cover several different patients (no
// patientId given up front — that's the point) and splits it into one
// structured segment per patient, matched against the live roster. Staff
// reviews every segment (including the matched patient itself) before
// anything saves; this function never writes to the database.
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

// Same "empty = not mentioned" convention as parse-update. matched_patient_code
// is intentionally a patient_code (short, unique, unambiguous) rather than a
// name or id the model would have to invent — "" means it couldn't confidently
// match anyone in the roster, and match_notes explains why so staff can
// resolve it by hand via the patient dropdown.
const SegmentSchema = z.object({
  matched_patient_code: z.string(),
  match_confidence: z.enum(MATCH_CONFIDENCE_VALUES),
  match_notes: z.string(),
  segment_text: z.string(),
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

const BulkSchema = z.object({
  segments: z.array(SegmentSchema),
});

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

    const { text } = await req.json();
    if (!text || !text.trim()) return jsonResponse({ error: "text is required" }, 400);

    const { data: roster } = await admin
      .from("patients")
      .select("patient_code, name, village, block, status");
    if (!roster) return jsonResponse({ error: "Could not load the patient roster" }, 500);

    const rosterText = roster
      .map((p: any) => `${p.patient_code} | ${p.name} | ${p.village ?? "—"}, ${p.block ?? "—"} | ${p.status ?? "—"}`)
      .join("\n");

    const todayIso = new Date().toISOString().slice(0, 10);

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await anthropic.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      system:
        "You are a medical-records assistant helping a cancer-care nonprofit's staff turn one free-form note " +
        "into structured updates for the specific patients it discusses. The note may cover one patient or " +
        "several, in any order, mixed together. Your job: split it into one segment per patient it actually " +
        `discusses, and match each segment to a patient in the roster below by name/village/block. Today's date ` +
        `is ${todayIso} — resolve relative phrasing ("next visit in 3 weeks") into absolute YYYY-MM-DD dates.\n\n` +
        "Roster (patient_code | name | village, block | status on file):\n" + rosterText + "\n\n" +
        "For each segment: matched_patient_code must be a code from the roster above, or \"\" if you cannot " +
        "confidently tell which roster patient it refers to (e.g. an ambiguous first name with no other " +
        "identifying detail, or someone not in the roster at all) — in that case explain why in match_notes so " +
        "staff can pick manually. Set match_confidence honestly: \"none\" whenever matched_patient_code is empty, " +
        "\"low\" for a guess you're not sure of even though you returned a code, \"high\"/\"medium\" otherwise. " +
        "segment_text must be the verbatim substring of the original note that this segment came from — do not " +
        "paraphrase it, staff needs to cross-check your split against the source. For the rest of each segment's " +
        "fields, follow the same rules as filling in a single patient's visit update: leave a field empty string " +
        "when the segment doesn't mention it (this is read as \"no change\", not zero/false), never invent facts, " +
        "and write visit_notes as a light cleanup of the segment that preserves non-clinical detail near-verbatim " +
        "— patient/family preferences, hesitations, refusals, hospital choices, financial worries, and similar " +
        "social/logistical color matter as much as the medical facts here, this record is used for the " +
        "nonprofit's own storytelling later. Extract payment_amount/payment_purpose/payment_notes only when a " +
        "concrete amount of money is mentioned for that patient, and committed_amount only when a total " +
        "estimated/committed cost of care is mentioned (distinct from a single payment) — leave these empty " +
        "rather than estimating.",
      messages: [
        { role: "user", content: `Free-text note:\n${text}` },
      ],
      output_config: { format: zodOutputFormat(BulkSchema) },
    });

    const parsed = response.parsed_output;
    if (!parsed) return jsonResponse({ error: "Could not parse the update" }, 502);

    return jsonResponse(parsed, 200);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
