const LLAMA_URL = "https://api.llama.ai/v1/chat/completions";
const DEFAULT_MODEL = "Llama-3.3-70B-Instruct";

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

export async function callLlama(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.LLAMA_API_KEY;
  if (!apiKey) {
    throw new Error("LLAMA_API_KEY is not configured");
  }

  const res = await fetch(LLAMA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.LLAMA_MODEL || DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.6,
      max_tokens: 2048,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Llama API error (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Empty response from Llama API");
  return content;
}

export async function callLlamaJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
  const raw = await callLlama(
    `${systemPrompt}\n\nRespond with valid JSON only. No markdown fences.`,
    userPrompt
  );
  const parsed = parseJsonFromText<T>(raw);
  if (!parsed) throw new Error("Failed to parse AI response as JSON");
  return parsed;
}
