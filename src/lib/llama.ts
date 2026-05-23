/**
 * llama.ts — AI client
 *
 * Calls the Groq API (exposing an OpenAI-compatible endpoint):
 *   https://api.groq.com/openai/v1/chat/completions
 *
 * Environment variables:
 *   GROQ_API_KEY — your Groq API key (required)
 *   GROQ_MODEL   — override the model ID (optional, defaults to llama-3.3-70b-versatile)
 */

import { headers } from "next/headers";

const DEFAULT_MODEL =
  process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

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
  let apiKey = process.env.GROQ_API_KEY;
  let model = process.env.GROQ_MODEL ?? DEFAULT_MODEL;

  try {
    const reqHeaders = headers();
    const clientKey = reqHeaders.get("x-groq-api-key");
    const clientModel = reqHeaders.get("x-groq-model");
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
      "GROQ_API_KEY is not set. Add your Groq API key to .env.local or configure it in Settings."
    );
  }

  const url = "https://api.groq.com/openai/v1/chat/completions";

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
      `Groq API error (${res.status}): ${errText.slice(0, 300)}`
    );
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("Empty response from Groq model");
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
  if (!parsed) throw new Error("Failed to parse Groq response as JSON");
  return parsed;
}
