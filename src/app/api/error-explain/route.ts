import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlamaJson } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import type { ErrorExplainResponse } from "@/types";

const SYSTEM = `You are a Linux troubleshooting expert. Analyze the error and return ONLY valid JSON:
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
