import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlamaJson } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import type { CommandResponse } from "@/types";

const SYSTEM = `You are a Linux command expert.
CRITICAL SAFETY & SCOPE RULES:
1. ONLY generate Linux, Bash, and DevOps related commands. If the user query is unrelated to Linux/DevOps, return a placeholder command like "echo 'Please ask a Linux-related question.'" and explain that in the JSON fields.
2. DANGEROUS COMMAND PROTECTION: If the query requests a destructive or dangerous command (like "rm -rf /", "dd", fork bombs, formatting drives, etc.), you MUST refuse to generate it. Return "echo 'Dangerous command execution blocked'" in the "command" field, set "risk" to "High", explain the refusal in the "explanation" field, and provide a clear, bold warning in the "warning" field explaining that you cannot generate dangerous commands and highlighting the specific risks of the request.
Return ONLY valid JSON in this exact format:
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

    const supabase = auth.supabase;
    let result: CommandResponse | null = null;

    // Check DB first (search by exact command name matching query)
    const { data: dbCommand } = await supabase
      .from("linux_commands")
      .select("command_name, description, example_usage, category")
      .ilike("command_name", query.trim())
      .limit(1);

    if (dbCommand && dbCommand.length > 0) {
      const cmd = dbCommand[0];
      result = {
        command: cmd.example_usage || cmd.command_name,
        explanation: cmd.description,
        risk: "Low",
        output: "",
        warning: "",
      };
    } else {
      // If not exact match, search by description containing query
      const { data: dbCommandDesc } = await supabase
        .from("linux_commands")
        .select("command_name, description, example_usage, category")
        .ilike("description", `%${query.trim()}%`)
        .limit(1);

      if (dbCommandDesc && dbCommandDesc.length > 0) {
        const cmd = dbCommandDesc[0];
        result = {
          command: cmd.example_usage || cmd.command_name,
          explanation: cmd.description,
          risk: "Low",
          output: "",
          warning: "",
        };
      }
    }

    // Fallback to LLM if not in DB
    if (!result) {
      result = await callLlamaJson<CommandResponse>(SYSTEM, query);
    }

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
