import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlamaJson } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import { rateLimit } from "@/lib/rate-limit";
import type { ScriptResponse } from "@/types";
import { checkDangerousCommand } from "@/lib/safety";

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

  // Rate Limit: 5 requests per minute (very heavy operation)
  const limitResponse = rateLimit(req, auth.user!.id, { limit: 5, windowMs: 60 * 1000 });
  if (limitResponse) return limitResponse;

  try {
    const { description, difficulty } = await req.json();
    if (!description) {
      return NextResponse.json({ error: "Description is required" }, { status: 400 });
    }


    // Validate safety of the input description
    const danger = checkDangerousCommand(description);
    if (danger) {
      return NextResponse.json({
        script: "echo 'Script generation blocked for safety.'",
        breakdown: [`The script request contains a dangerous operation: ${danger.name}`],
        warning: `WARNING: The command "${danger.name}" is dangerous because: ${danger.risk} Generation has been blocked for safety.`,
        difficulty: "N/A",
      });
    }

    const result = await callLlamaJson<ScriptResponse>(
      SYSTEM,
      `Difficulty: ${difficulty || "Intermediate"}\nTask: ${description}`
    );

    // Double check generated script safety
    const genDanger = checkDangerousCommand(result.script);
    if (genDanger) {
      return NextResponse.json({
        script: "echo 'Script execution blocked for safety.'",
        breakdown: [`The generated script contains a dangerous operation: ${genDanger.name}`],
        warning: `WARNING: The script contains "${genDanger.name}" which is dangerous because: ${genDanger.risk} Execution has been blocked for safety.`,
        difficulty: "N/A",
      });
    }

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
