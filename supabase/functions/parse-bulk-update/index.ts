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

// "" is a legal value everywhere the model is told to "leave the field
// empty" for the other segment kind — an activity segment fills
// match_confidence with "", a patient segment fills activity_type with "".
// Omitting "" from these enums is exactly the contradiction that produced
// "Failed to parse structured output" on pure-activity notes.
const MATCH_CONFIDENCE_VALUES = ["", "high", "medium", "low", "none"] as const;
const SEGMENT_KIND_VALUES = ["patient_update", "activity"] as const;

// Same "empty = not mentioned" convention as parse-update. matched_patient_code
// is intentionally a patient_code (short, unique, unambiguous) rather than a
// name or id the model would have to invent — "" means it couldn't confidently
// match anyone in the roster, and match_notes explains why so staff can
// resolve it by hand via the patient dropdown. segment_kind splits a segment
// into either a specific patient's care (the patient_* fields below) or an
// organizational activity (the activity_* fields) — only the relevant set
// gets filled in either case. activity_type is a dynamic enum of whatever
// categories are active in log_types right now, so the schema is built per
// request (same pattern as parse-whatsapp).
function buildSchema(activityTypeNames: [string, ...string[]]) {
  const SegmentSchema = z.object({
    segment_kind: z.enum(SEGMENT_KIND_VALUES),
    segment_text: z.string(),
    matched_patient_code: z.string(),
    match_confidence: z.enum(MATCH_CONFIDENCE_VALUES),
    match_notes: z.string(),
    new_patient_name: z.string(),
    new_patient_age: z.string(),
    new_patient_gender: z.enum(["", "Male", "Female", "Other"]),
    new_patient_phone: z.string(),
    new_patient_village: z.string(),
    new_patient_block: z.string(),
    new_patient_diagnosis: z.string(),
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
    activity_date: z.string(),
    activity_type: z.enum(activityTypeNames),
    activity_title: z.string(),
    activity_description: z.string(),
    activity_participants: z.string(),
    quantity: z.string(),
  });
  return z.object({ segments: z.array(SegmentSchema) });
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

    const { text } = await req.json();
    if (!text || !text.trim()) return jsonResponse({ error: "text is required" }, 400);

    const { data: roster } = await admin
      .from("patients")
      .select("patient_code, name, village, block, status");
    if (!roster) return jsonResponse({ error: "Could not load the patient roster" }, 500);

    const rosterText = roster
      .map((p: any) => `${p.patient_code} | ${p.name} | ${p.village ?? "—"}, ${p.block ?? "—"} | ${p.status ?? "—"}`)
      .join("\n");

    // Live categories for activity segments — 'Patient Update' is excluded
    // because patient care goes through segment_kind, not activity_type.
    const { data: logTypes } = await admin
      .from("log_types")
      .select("name")
      .eq("active", true)
      .neq("name", "Patient Update")
      .order("sort_order");
    if (!logTypes || logTypes.length === 0) {
      return jsonResponse({ error: "Could not load log types" }, 500);
    }
    const activityNames = logTypes.map((t: any) => t.name);
    const activityTypeNames = ["", ...activityNames] as [string, ...string[]];

    const todayIso = new Date().toISOString().slice(0, 10);

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await anthropic.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      system:
        "You are a records assistant helping a cancer-care nonprofit's staff turn one free-form note into " +
        "structured entries. Who's who at SACCI: \"Appa\" is Dr. Vidyasagar, the funder and main doctor behind " +
        "the initiative — always refer to him as Dr. Vidyasagar in your output; \"Munish RM\" is Munish, the " +
        "program manager; \"Sanjay sahni\" is Sanjay Sahni, the field coordinator in Muzaffarpur; \"M R Sharan\" " +
        "is Sharan. Write everything you produce in clear, plain English — translate Hindi/Hinglish content " +
        "rather than copying it; names of people, places, hospitals, and amounts stay exactly as they are. One " +
        "exception: an original Hindi phrase may be kept, in quotes, when it is particularly memorable or the " +
        "exact words matter — give its English meaning alongside. Use this sparingly.\n\n" +
        "The note may mix together several different things: updates about specific " +
        "patients' care, AND organizational activity that isn't about any one patient — a meeting between staff/" +
        "advisors (e.g. \"Dr. Vidyasagar met Dr. Ravikant to discuss X\"), a health camp (e.g. \"health camp in " +
        "Motipur panchayat on 29 May 2026\"), a training, or similar program activity. Split the note into one " +
        "segment per distinct thing it discusses, and classify each segment's segment_kind: \"patient_update\" " +
        "for anything about one specific patient's diagnosis/treatment/visit, or \"activity\" for organizational " +
        `activity not tied to a specific patient. Today's date is ${todayIso} — resolve relative phrasing ` +
        "(\"next visit in 3 weeks\", \"on the 29th\") into absolute YYYY-MM-DD dates.\n\n" +
        "Roster (patient_code | name | village, block | status on file):\n" + rosterText + "\n\n" +
        "segment_text must always be the verbatim substring of the original note that this segment came from — " +
        "do not paraphrase it, staff needs to cross-check your split against the source.\n\n" +
        "For patient_update segments: matched_patient_code must be a code from the roster above, or \"\" if you " +
        "cannot confidently tell which roster patient it refers to (e.g. an ambiguous first name with no other " +
        "identifying detail, or someone not in the roster at all) — in that case explain why in match_notes so " +
        "staff can pick manually. Set match_confidence honestly: \"none\" whenever matched_patient_code is empty, " +
        "\"low\" for a guess you're not sure of even though you returned a code, \"high\"/\"medium\" otherwise. " +
        "When the person is clearly a specific patient who is NOT in the roster (rather than merely ambiguous), " +
        "also fill the new_patient_* fields from what the note states about them, so staff can register them in " +
        "one click: new_patient_name (as written, properly capitalized), and age/gender/phone/village/block/" +
        "diagnosis only where actually stated — never guessed. Leave all new_patient_* fields empty when the " +
        "segment matches a roster patient. " +
        "Follow the same rules as filling in a single patient's visit update: leave a field empty string when " +
        "the segment doesn't mention it (this is read as \"no change\", not zero/false), never invent facts, and " +
        "write visit_notes as a clear English retelling of the segment that preserves ALL the concrete detail — " +
        "patient/family preferences, hesitations, refusals, hospital choices, financial worries, and similar " +
        "social/logistical color matter as much as the medical facts here, this record is used for the " +
        "nonprofit's own storytelling later. Extract payment_amount/payment_purpose/payment_notes only when a " +
        "concrete amount of money is mentioned for that patient, and committed_amount only when a total " +
        "estimated/committed cost of care is mentioned (distinct from a single payment) — leave these empty " +
        "rather than estimating. Leave all activity_* fields empty for these segments.\n\n" +
        "For activity segments: leave matched_patient_code/match_confidence/match_notes and all patient_update " +
        "fields empty. Fill activity_date (best guess if not stated, otherwise today), activity_type — one of: " +
        activityNames.join(", ") + " (closest match, \"Other\" if unclear) — activity_title (a short label, " +
        "e.g. \"Dr. Vidyasagar & Dr. Ravikant meeting\"), activity_participants (who was involved, by their " +
        "real names), and activity_description — same keep-every-detail, don't-sanitize principle as " +
        "visit_notes above (in plain English), this is storytelling material too. quantity is how many people " +
        "or things the entry represents, as a plain number string — \"3\" when three saathis are inducted at " +
        "once — and empty when it is a single event or person (read as 1). Leave quantity empty on " +
        "patient_update segments.",
      messages: [
        { role: "user", content: `Free-text note:\n${text}` },
      ],
      output_config: { format: zodOutputFormat(buildSchema(activityTypeNames)) },
    });

    const parsed = response.parsed_output;
    if (!parsed) return jsonResponse({ error: "Could not parse the update" }, 502);

    return jsonResponse(parsed, 200);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
