import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlamaJson } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import { rateLimit } from "@/lib/rate-limit";
import type { CommandResponse } from "@/types";
import { checkDangerousCommand } from "@/lib/safety";
import { Redis } from "@upstash/redis";

const DAILY_LIMIT = 30; // Stricter limit for generation

async function checkDailyQuota(userId: string): Promise<boolean> {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return true;
  
  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  const key = `quota:generate:${userId}:${new Date().toISOString().split('T')[0]}`;
  const current = await redis.get<number>(key) || 0;
  
  if (current >= DAILY_LIMIT) {
    return false;
  }
  
  await redis.incr(key);
  if (current === 0) {
    await redis.expire(key, 86400);
  }
  return true;
}

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

  // Rate Limit: 20 requests per minute
  const limitResponse = rateLimit(req, auth.user!.id, { limit: 20, windowMs: 60 * 1000 });
  if (limitResponse) return limitResponse;

  try {
    const { query } = await req.json();
    if (!query || typeof query !== "string") {
      return NextResponse.json({ error: "Query is required" }, { status: 400 });
    }

    // AI Quota Check
    const hasQuota = await checkDailyQuota(auth.user!.id);
    if (!hasQuota) {
      return NextResponse.json({ error: "Daily AI Generate Quota Exceeded (30 requests/day)" }, { status: 429 });
    }

    // Prompt sanitization: strip HTML tags and restrict length to prevent massive prompt injection/buffer overflows
    const safeQuery = query.replace(/<[^>]*>?/gm, '').slice(0, 500);

    // Validate safety of the input query
    const danger = checkDangerousCommand(safeQuery);
    if (danger) {
      return NextResponse.json({
        command: "Blocked",
        explanation: `The request contains a dangerous command: ${danger.name}`,
        risk: "High",
        output: "",
        warning: `WARNING: The command "${danger.name}" is dangerous because: ${danger.risk} Generation has been blocked for safety.`,
      });
    }

    const supabase = auth.supabase;
    let result: CommandResponse | null = null;

    // Check DB first (search by exact command name matching query)
    const { data: dbCommand } = await supabase
      .from("linux_commands")
      .select("command_name, description, example_usage, category")
      .ilike("command_name", safeQuery.trim())
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
        .ilike("description", `%${safeQuery.trim()}%`)
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
      result = await callLlamaJson<CommandResponse>(SYSTEM, safeQuery);
    }

    // Double check generated command safety
    const genDanger = checkDangerousCommand(result.command);
    if (genDanger) {
      result = {
        command: "Blocked",
        explanation: `The generated command is dangerous: ${genDanger.name}`,
        risk: "High",
        output: "",
        warning: `WARNING: The command "${genDanger.name}" is dangerous because: ${genDanger.risk} Generation has been blocked for safety.`,
      };
    }

    await auth.supabase.from("command_history").insert({
      user_id: auth.user!.id,
      query: safeQuery,
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
