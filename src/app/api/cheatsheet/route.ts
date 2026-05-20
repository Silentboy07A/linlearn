import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlamaJson } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import type { CheatSheetResponse } from "@/types";

const SYSTEM = `You are a Linux and DevOps expert. Generate a comprehensive cheat sheet.
Return ONLY valid JSON:
{
  "title": "string",
  "sections": [{ "heading": "string", "items": [{ "command": "string", "description": "string" }] }]
}
Never include markdown. Be thorough and practical.`;

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { topic, style } = await req.json();
    if (!topic) {
      return NextResponse.json({ error: "Topic required" }, { status: 400 });
    }

    const result = await callLlamaJson<CheatSheetResponse>(
      SYSTEM,
      `Topic: ${topic}\nStyle: ${style || "Detailed"}`
    );

    await auth.supabase.from("cheatsheets").insert({
      user_id: auth.user!.id,
      topic,
      content: JSON.stringify(result),
    });

    const progress = await addXp(auth.supabase, auth.user!.id, XP_REWARDS.cheatsheet);

    return NextResponse.json({ ...result, progress });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Cheat sheet generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
