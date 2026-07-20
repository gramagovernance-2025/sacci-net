// Parses a plain-English visit update into structured form fields so staff
// don't have to hand-fill Status/Treatment/Medication/etc after every visit.
// Staff-only (this feeds a write flow, unlike analyze-report/summarize-patient
// which advisors can also trigger). Returns parsed fields only — never writes
// to the database itself; staff still reviews and clicks Save Update.
import Anthropic from "npm:@anthropic-ai/sdk@0.112.1";
import { z } from "npm:zod@4.4.3";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk@0.112.1/helpers/zod";
import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { CORS_HEADERS, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const STATUS_VALUES = [
  "", "Screening", "Under Investigation", "Treatment", "Admitted",
  "On Medication", "Follow-up", "Completed",
] as const;

const PURPOSE_VALUES = [
  "", "Travel", "Screening", "Treatment", "Medicine", "Hospital Stay", "Other",
] as const;

// Empty string is the explicit "not mentioned in this text, leave
// unchanged" signal — mirrors the existing uStatus/uNextVisit "no change"
// convention already used by saveUpdate() in the frontend. payment_amount
// follows the same convention: empty means no money was mentioned, not
// zero — the frontend only offers to log a payment when this is non-empty.
const UpdateSchema = z.object({
  visit_notes: z.string(),
  status: z.enum(STATUS_VALUES),
  next_visit_date: z.string(),
  treatment: z.string(),
  medication: z.string(),
  next_test: z.string(),
  test_date: z.string(),
  med_date: z.string(),
  diagnosis: z.string(),
  payment_amount: z.string(),
  payment_purpose: z.enum(PURPOSE_VALUES),
  payment_notes: z.string(),
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

    const { patientId, text } = await req.json();
    if (!patientId) return jsonResponse({ error: "patientId is required" }, 400);
    if (!text || !text.trim()) return jsonResponse({ error: "text is required" }, 400);

    const { data: patient } = await admin
      .from("patients")
      .select("status, treatment, medication, next_visit, next_test, test_date, med_date, diagnosis, visit_num")
      .eq("id", patientId)
      .single();
    if (!patient) return jsonResponse({ error: "Patient not found" }, 404);

    const todayIso = new Date().toISOString().slice(0, 10);
    const currentRecord = [
      `Status on file: ${patient.status ?? "—"}`,
      `Diagnosis on file: ${patient.diagnosis ?? "none recorded"}`,
      `Treatment on file: ${patient.treatment ?? "none recorded"}`,
      `Medication on file: ${patient.medication ?? "none recorded"}`,
      `Next visit on file: ${patient.next_visit ?? "none scheduled"}`,
      `Next test on file: ${patient.next_test ?? "none"}`,
      `Test due date on file: ${patient.test_date ?? "none"}`,
      `Medicine refill due on file: ${patient.med_date ?? "none"}`,
    ].join("\n");

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await anthropic.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system:
        "You are a medical-records assistant helping a cancer-care nonprofit's staff turn a plain-English visit " +
        `note into structured form fields. Today's date is ${todayIso} — resolve relative phrasing ("next visit ` +
        'in 3 weeks", "test due in 10 days") into absolute YYYY-MM-DD dates using that as the reference point. ' +
        "You are given the patient's current record for context. Only fill a field when the text actually states " +
        "something new for it — if a field is not mentioned or not changed, return an empty string for it (this is " +
        "read by the caller as \"leave unchanged\", so guessing or repeating the existing value is wrong and would " +
        "get treated as a real edit). Do not invent facts. If a date is ambiguous, leave the date field empty and " +
        "describe the ambiguity in visit_notes instead of guessing. visit_notes should be a clean rewrite of what " +
        "happened at this visit, suitable for a permanent record. Separately, if the text mentions money given to " +
        "or spent for the patient (e.g. travel fare, a medicine purchase, a hospital deposit), extract " +
        "payment_amount as a plain number string with no currency symbol or commas (e.g. \"2000\"), " +
        "payment_purpose as the closest matching category, and payment_notes with any specifics worth recording. " +
        "Leave all three payment fields empty if no concrete amount is mentioned — do not estimate or guess an " +
        "amount.",
      messages: [
        {
          role: "user",
          content: `Patient's current record:\n${currentRecord}\n\nVisit update (plain English):\n${text}`,
        },
      ],
      output_config: { format: zodOutputFormat(UpdateSchema) },
    });

    const parsed = response.parsed_output;
    if (!parsed) return jsonResponse({ error: "Could not parse the update" }, 502);

    return jsonResponse(parsed, 200);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
