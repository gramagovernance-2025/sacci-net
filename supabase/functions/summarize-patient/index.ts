// Builds a short plain-English case summary for a patient — written for Dr.
// Vidyasagar (advisor role) so he doesn't have to piece together a case from
// raw visit notes and report photos. Staff/advisor only, same auth check as
// analyze-report. On-demand + cached: only runs when the caller asks for it.
import Anthropic from "npm:@anthropic-ai/sdk@0.112.1";
import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { CORS_HEADERS, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

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
    if (!profile || (profile.role !== "staff" && profile.role !== "advisor")) {
      return jsonResponse({ error: "Not authorized" }, 403);
    }

    const { patientId } = await req.json();
    if (!patientId) return jsonResponse({ error: "patientId is required" }, 400);

    const { data: patient } = await admin.from("patients").select("*").eq("id", patientId).single();
    if (!patient) return jsonResponse({ error: "Patient not found" }, 404);

    const { data: files } = await admin
      .from("patient_files")
      .select("name, category, ai_analysis")
      .eq("patient_id", patientId)
      .not("ai_analysis", "is", null);

    const history = Array.isArray(patient.history) ? patient.history : [];
    const historyText = history.length
      ? history
        .slice()
        .reverse()
        .map((h: any) => `- ${h.date ?? ""}: ${h.note ?? ""}`)
        .join("\n")
      : "No visit history recorded yet.";

    const analyzedText = files?.length
      ? files
        .map((f: any) => `- ${f.category ?? "Other"} (${f.name}): ${JSON.stringify(f.ai_analysis)}`)
        .join("\n")
      : "No report photos have been analyzed yet.";

    const caseText = [
      `Name: ${patient.name}`,
      `Age: ${patient.age ?? "unknown"}, Gender: ${patient.gender ?? "unknown"}`,
      `Village/Block: ${patient.village ?? "—"} / ${patient.block ?? "—"}`,
      `Status: ${patient.status ?? "—"}`,
      `Diagnosis on file: ${patient.diagnosis ?? "none recorded"}`,
      `Treatment on file: ${patient.treatment ?? "none recorded"}`,
      `Medication on file: ${patient.medication ?? "none recorded"}`,
      `Staff notes: ${patient.notes ?? "none"}`,
      ``,
      `Visit history (most recent first):`,
      historyText,
      ``,
      `AI-analyzed report photos on file:`,
      analyzedText,
    ].join("\n");

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system:
        "You write short, plain-English case summaries for a volunteer oncologist advising a cancer-care " +
        "nonprofit in rural India. He reviews many patients and needs to get oriented fast. Write one or two " +
        "short paragraphs: who the patient is, what's been diagnosed/treated so far, and where things currently " +
        "stand (next steps, open questions, anything that looks concerning or inconsistent). Avoid restating " +
        "every visit — synthesize. Do not invent facts not present in the record.",
      messages: [{ role: "user", content: `Here is the patient's record:\n\n${caseText}` }],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const summary = textBlock?.text?.trim();
    if (!summary) return jsonResponse({ error: "Could not generate a summary" }, 502);

    await admin
      .from("patients")
      .update({ ai_summary: summary, ai_summary_generated_at: new Date().toISOString() })
      .eq("id", patientId);

    return jsonResponse({ summary }, 200);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
