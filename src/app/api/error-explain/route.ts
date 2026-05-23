import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlamaJson } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import type { ErrorExplainResponse } from "@/types";

const SYSTEM = `You are a Linux troubleshooting expert.
CRITICAL SAFETY & SCOPE RULES:
1. ONLY explain Linux, Bash, and DevOps errors. If the error text is unrelated, explain that in the summary field.
2. DANGEROUS COMMAND PROTECTION: Ensure any troubleshooting command you suggest is completely safe. Never suggest destructive commands; if one is required, explain it in text and alter it to a safe simulation or dry-run.
Analyze the error and return ONLY valid JSON:
{
  "summary": "string",
  "rootCause": "string",
  "steps": ["string"],
  "prevention": ["string"],
  "commands": ["string"]
}
Never include markdown. Be concise and practical.`;

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { error } = await req.json();
    if (!error) {
      return NextResponse.json({ error: "Error text required" }, { status: 400 });
    }

    const result = await callLlamaJson<ErrorExplainResponse>(SYSTEM, error);
    const progress = await addXp(auth.supabase, auth.user!.id, XP_REWARDS.errorExplain);

    return NextResponse.json({ ...result, progress });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Explanation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
