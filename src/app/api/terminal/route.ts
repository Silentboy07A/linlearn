import { NextRequest, NextResponse } from "next/server";
import { getCommandDBOutput } from "@/lib/commandDB";
import { callLlama } from "@/lib/llama";
import { validateTerminalCommand } from "@/lib/safety";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  // Rate Limit: 30 requests per minute by IP address (allows fast terminal typing but prevents API hammering/denial)
  const limitResponse = rateLimit(req, null, { limit: 30, windowMs: 60 * 1000 });
  if (limitResponse) return limitResponse;

  const { command, cwd, filesystem } = await req.json();


  // Validate safety
  const validation = validateTerminalCommand(command);
  if (!validation.valid) {
    return NextResponse.json({
      output: validation.error || "Permission denied: command validation failed.",
      fsUpdate: null,
    });
  }

  const systemPrompt = `You are a simulated Linux terminal on Ubuntu 22.04.
CRITICAL SAFETY & SCOPE RULES:
1. ONLY execute and respond to Linux commands.
2. DANGEROUS COMMAND PROTECTION: If the user inputs a dangerous or destructive command (e.g. rm -rf /, dd, fork bombs, wiping drives, etc.), you MUST NOT execute or simulate it. Instead, output a clear warning: "Error: Dangerous command blocked. LinLearn does not support or generate destructive operations." and do not modify the filesystem.
Current directory: ${cwd}
Filesystem: ${JSON.stringify(filesystem)}
Respond with ONLY raw terminal output, no markdown, no explanation.
If the command modifies the filesystem append updated state in <fs>...</fs> tags.`;

  // Check DB first
  const dbOutput = getCommandDBOutput(command);
  if (dbOutput !== null) {
    return NextResponse.json({
      output: dbOutput,
      fsUpdate: null,
    });
  }

  // Fallback to LLM if not in DB
  let aiOutput = "";
  let aiFailed = false;

  try {
    aiOutput = await callLlama(systemPrompt, command);
    if (!aiOutput) aiFailed = true;
  } catch {
    aiFailed = true;
  }

  if (aiFailed) {
    return NextResponse.json({
      output: `bash: ${command}: command not found`,
      fsUpdate: null,
    });
  }

  // Parse <fs>...</fs> for updated filesystem
  let fsUpdate = null;
  if (aiOutput.includes("<fs>")) {
    const match = aiOutput.match(/<fs>([\s\S]*?)<\/fs>/);
    if (match) {
      try {
        fsUpdate = JSON.parse(match[1]);
        aiOutput = aiOutput.replace(match[0], "").trim();
      } catch {}
    }
  }

  return NextResponse.json({ output: aiOutput, fsUpdate });
}
