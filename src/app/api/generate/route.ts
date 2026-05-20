import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlamaJson } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import type { CommandResponse } from "@/types";

const SYSTEM = `You are a Linux command expert. Return ONLY valid JSON in this exact format:
{
  "command": "string",
  "explanation": "string",
  "risk": "Low" | "Medium" | "High",
  "output": "string",
  "warning": "string"
}
Never include markdown. Never execute real commands. Be accurate and educational.`;

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { query } = await req.json();
    if (!query || typeof query !== "string") {
      return NextResponse.json({ error: "Query is required" }, { status: 400 });
    }

    const result = await callLlamaJson<CommandResponse>(SYSTEM, query);

    await auth.supabase.from("command_history").insert({
      user_id: auth.user!.id,
      query,
      command: result.command,
      explanation: result.explanation,
      risk_level: result.risk,
    });

    const progress = await addXp(auth.supabase, auth.user!.id, XP_REWARDS.command);

    return NextResponse.json({ ...result, progress });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
