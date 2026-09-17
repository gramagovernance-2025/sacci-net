// Translates short English fragments of live patient/log data (diagnosis,
// treatment, notes, log descriptions) to Hindi, for staff who read the
// portal in Hindi (e.g. Sanjay ji). Unlike the portal's static UI copy —
// translated up front and shipped in the page — this is text staff typed
// themselves as they worked, so it's translated lazily on first Hindi view
// and cached in translations_hi, keyed by a hash of the source text, so the
// same sentence is never sent to Claude twice across all users/patients.
import Anthropic from "npm:@anthropic-ai/sdk@0.112.1";
import { z } from "npm:zod@4.4.3";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk@0.112.1/helpers/zod";
import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { CORS_HEADERS, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const MAX_TEXTS = 80;
const MAX_CHARS = 40000;

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
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
    if (!profile || (profile.role !== "staff" && profile.role !== "advisor")) {
      return jsonResponse({ error: "Not authorized" }, 403);
    }

    const { texts } = await req.json();
    if (!Array.isArray(texts) || texts.length === 0) {
      return jsonResponse({ error: "texts is required" }, 400);
    }
    if (texts.length > MAX_TEXTS) {
      return jsonResponse({ error: `Too many texts in one request (max ${MAX_TEXTS})` }, 400);
    }

    // Empty/whitespace-only entries pass straight through untranslated.
    const trimmed: string[] = texts.map((t: unknown) => (typeof t === "string" ? t.trim() : ""));
    const totalChars = trimmed.reduce((n: number, t: string) => n + t.length, 0);
    if (totalChars > MAX_CHARS) return jsonResponse({ error: "Text batch too large" }, 400);

    const hashes = await Promise.all(trimmed.map((t) => (t ? sha256Hex(t) : Promise.resolve(""))));

    const nonEmptyHashes = [...new Set(hashes.filter((h) => h))];
    const cacheMap: Record<string, string> = {};
    if (nonEmptyHashes.length) {
      const { data: cached } = await admin
        .from("translations_hi")
        .select("source_hash, hi_text")
        .in("source_hash", nonEmptyHashes);
      (cached || []).forEach((row: any) => { cacheMap[row.source_hash] = row.hi_text; });
    }

    // Unique texts still missing from the cache, in first-seen order.
    const missingByHash = new Map<string, string>();
    trimmed.forEach((t, i) => {
      const h = hashes[i];
      if (h && !(h in cacheMap) && !missingByHash.has(h)) missingByHash.set(h, t);
    });

    if (missingByHash.size) {
      const missingHashes = [...missingByHash.keys()];
      const missingTexts = [...missingByHash.values()];
      const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const Schema = z.object({ translations: z.array(z.string()) });
      const numbered = missingTexts.map((t, i) => `[${i}] ${t}`).join("\n");
      const response = await anthropic.messages.parse({
        model: "claude-opus-4-8",
        // Devanagari output runs noticeably more tokens than the English
        // input, and a batch here can be dozens of log entries at once
        // (up to MAX_CHARS/MAX_TEXTS). 4096 was cutting long batches off
        // mid-response, which fails structured-output parsing and silently
        // falls back to English below — bumped well past worst case.
        max_tokens: 16000,
        system:
          "You translate short English fragments from a cancer-care nonprofit's patient records and activity " +
          "log into natural, plain Hindi (Devanagari script), for a Hindi-reading field coordinator. Each " +
          "fragment may be a diagnosis, a treatment or medication note, a free-text staff note, or a log entry " +
          "description. Preserve names of people, places, hospitals, drugs, and medical terms that are commonly " +
          "used in English even in Hindi speech (e.g. drug names, \"chemotherapy\") rather than forcing an " +
          "awkward translation. Keep numbers, dates, and amounts as written. Return exactly one translation per " +
          "input, in the same order, with no added commentary.",
        messages: [
          { role: "user", content: `Translate each of these ${missingTexts.length} fragments to Hindi:\n${numbered}` },
        ],
        output_config: { effort: "medium", format: zodOutputFormat(Schema) },
      });

      const parsed = response.parsed_output;
      if (parsed && parsed.translations.length === missingTexts.length) {
        const rows = missingHashes.map((h, i) => ({
          source_hash: h,
          source_text: missingByHash.get(h)!,
          hi_text: parsed.translations[i],
        }));
        rows.forEach((r) => { cacheMap[r.source_hash] = r.hi_text; });
        const { error: upsertError } = await admin.from("translations_hi").upsert(rows, { onConflict: "source_hash" });
        if (upsertError) console.error("translations_hi upsert failed:", upsertError);
      } else {
        // Claude didn't return a usable translation set — log why, and fall
        // through to returning the original English text below rather than
        // failing the whole request over a handful of untranslated strings.
        console.error(
          "translate-text: unusable model output",
          JSON.stringify({ expected: missingTexts.length, got: parsed?.translations?.length, stopReason: response.stop_reason }),
        );
      }
    }

    const translations = trimmed.map((t, i) => (t ? (cacheMap[hashes[i]] || t) : (texts[i] ?? "")));

    return jsonResponse({ translations }, 200);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
