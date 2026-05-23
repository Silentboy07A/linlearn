import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlamaJson } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import type { ScriptResponse } from "@/types";

const SYSTEM = `You are a bash scripting expert. The user will describe a task in plain English.
CRITICAL SAFETY & SCOPE RULES:
1. ONLY write scripts for Linux, Bash, and DevOps related tasks. If the task is unrelated to Linux/DevOps, return a script that prints a message asking for Linux-related tasks.
2. DANGEROUS COMMAND PROTECTION: If the task requests destructive or dangerous actions (like deleting root directories, wiping partitions, fork bombs, destructive network scans, etc.), you MUST refuse to generate the script. In the "script" field, return a simple echo statement refusing the task. Explain that you cannot generate dangerous scripts in the "breakdown", and provide a clear, detailed explanation of the refusal and the command risks in the "warning" field.
Write a complete, well-commented bash script that accomplishes the task.
Return ONLY valid JSON in this exact format:
{
  "script": "string with #!/bin/bash header and inline comments",
  "breakdown": ["string explaining each major section"],
  "warning": "empty string if safe, otherwise explain destructive ops",
  "difficulty": "string"
}
Never include markdown backticks in the script field. Be educational and thorough.`;

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { description, difficulty } = await req.json();
    if (!description) {
      return NextResponse.json({ error: "Description is required" }, { status: 400 });
    }

    const result = await callLlamaJson<ScriptResponse>(
      SYSTEM,
      `Difficulty: ${difficulty || "Intermediate"}\nTask: ${description}`
    );

    await auth.supabase.from("scripts").insert({
      user_id: auth.user!.id,
      description,
      script: result.script,
    });

    const progress = await addXp(auth.supabase, auth.user!.id, XP_REWARDS.script);

    return NextResponse.json({ ...result, progress });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Script generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
