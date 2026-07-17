// Reads a doctor-report photo (prescription / lab report / discharge summary)
// and extracts structured details with Claude. Staff/advisor only — verifies
// the caller's Supabase session and profile role before spending API credits.
import Anthropic from "npm:@anthropic-ai/sdk@0.112.1";
import { z } from "npm:zod@4.4.3";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk@0.112.1/helpers/zod";
import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { bytesToBase64, CORS_HEADERS, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const ReportSchema = z.object({
  document_type: z.enum(["prescription", "lab_report", "discharge_summary", "other"]),
  date_on_document: z.string(),
  doctor_name: z.string(),
  diagnosis_mentioned: z.string(),
  medicines: z.array(
    z.object({
      name: z.string(),
      dosage: z.string(),
      frequency: z.string(),
    }),
  ),
  key_findings: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
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
    if (!profile || (profile.role !== "staff" && profile.role !== "advisor")) {
      return jsonResponse({ error: "Not authorized" }, 403);
    }

    const { fileId } = await req.json();
    if (!fileId) return jsonResponse({ error: "fileId is required" }, 400);

    const { data: file } = await admin.from("patient_files").select("*").eq("id", fileId).single();
    if (!file) return jsonResponse({ error: "File not found" }, 404);

    const { data: signed, error: signErr } = await admin.storage
      .from("patient-files")
      .createSignedUrl(file.storage_path, 60);
    if (signErr || !signed) return jsonResponse({ error: "Could not access the file in storage" }, 500);

    const imgRes = await fetch(signed.signedUrl);
    if (!imgRes.ok) return jsonResponse({ error: "Could not download the file" }, 500);
    const mediaType = imgRes.headers.get("content-type") || "image/jpeg";
    if (!mediaType.startsWith("image/")) {
      return jsonResponse({ error: "Only image files can be analyzed right now" }, 400);
    }
    const base64 = bytesToBase64(new Uint8Array(await imgRes.arrayBuffer()));

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await anthropic.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      system:
        "You are a medical-records assistant helping a cancer-care nonprofit's staff quickly read doctor reports, " +
        "prescriptions, and lab results for low-income patients in rural India. Extract exactly what is written on " +
        "the document — do not infer or guess at anything not legible or not present. If a field is not present or " +
        "not legible, use an empty string (or an empty array for medicines). Handwriting may be imperfect; do your " +
        "best and reflect your certainty honestly in the confidence field.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType as any, data: base64 } },
            {
              type: "text",
              text: "Read this medical document photo and extract the structured details defined by the schema.",
            },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(ReportSchema) },
    });

    const parsed = response.parsed_output;
    if (!parsed) return jsonResponse({ error: "Could not parse the document" }, 502);

    await admin
      .from("patient_files")
      .update({ ai_analysis: parsed, ai_analyzed_at: new Date().toISOString() })
      .eq("id", fileId);

    return jsonResponse(parsed, 200);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
