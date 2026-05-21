/**
 * llama.ts — AI client
 *
 * Calls your Hugging Face Phi-3 model (silentone1234/linlearn-phi3-linux-assistant)
 * via the HF Inference API, which exposes an OpenAI-compatible endpoint:
 *   https://api-inference.huggingface.co/models/<model>/v1/chat/completions
 *
 * Environment variables:
 *   HF_API_KEY   — your Hugging Face access token (required)
 *   HF_MODEL     — override the model ID (optional)
 *   HF_API_URL   — override the full endpoint URL (optional)
 */

import { headers } from "next/headers";

const DEFAULT_MODEL =
  process.env.HF_MODEL ?? "silentone1234/linlearn-phi3-linux-assistant";

// ─── JSON helpers ─────────────────────────────────────────────────────────────

export function parseJsonFromText<T>(text: string): T | null {
  try {
    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]) as T;
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

// ─── Core caller ──────────────────────────────────────────────────────────────

export async function callLlama(
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  let apiKey = process.env.HF_API_KEY;
  let model = process.env.HF_MODEL ?? DEFAULT_MODEL;

  try {
    const reqHeaders = headers();
    const clientKey = reqHeaders.get("x-hf-api-key");
    const clientModel = reqHeaders.get("x-hf-model");
    if (clientKey) {
      apiKey = clientKey;
    }
    if (clientModel) {
      model = clientModel;
    }
  } catch {
    // outside request context or during static generation/build
  }

  if (!apiKey) {
    throw new Error(
      "HF_API_KEY is not set. Add your Hugging Face token to .env.local or configure it in Settings."
    );
  }

  const url =
    process.env.HF_API_URL ??
    `https://api-inference.huggingface.co/models/${model}/v1/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.6,
      max_tokens: 2048,
      stream: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Hugging Face Phi-3 API error (${res.status}): ${errText.slice(0, 300)}`
    );
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    // HF also sometimes returns `generated_text` at top level for older routes
    generated_text?: string;
  };

  // OpenAI-compatible path (preferred — /v1/chat/completions)
  const content =
    data.choices?.[0]?.message?.content?.trim() ??
    data.generated_text?.trim();

  if (!content) {
    throw new Error("Empty response from Hugging Face Phi-3 model");
  }

  return content;
}

// ─── JSON variant ─────────────────────────────────────────────────────────────

export async function callLlamaJson<T>(
  systemPrompt: string,
  userPrompt: string
): Promise<T> {
  const raw = await callLlama(
    `${systemPrompt}\n\nRespond with valid JSON only. No markdown fences.`,
    userPrompt
  );
  const parsed = parseJsonFromText<T>(raw);
  if (!parsed) throw new Error("Failed to parse Phi-3 response as JSON");
  return parsed;
}
