import { NextRequest, NextResponse } from "next/server";
import { getCommandDBOutput } from "@/lib/commandDB";
import { callLlama } from "@/lib/llama";

export async function POST(req: NextRequest) {
  const { command, cwd, filesystem } = await req.json();

  const systemPrompt = `You are a Linux terminal on Ubuntu 22.04.
Current directory: ${cwd}
Filesystem: ${JSON.stringify(filesystem)}
Respond with ONLY raw terminal output, no markdown, no explanation.
If the command modifies the filesystem append updated state in <fs>...</fs> tags.`;

  let aiOutput = "";
  let aiFailed = false;

  try {
    aiOutput = await callLlama(systemPrompt, command);
    if (!aiOutput) aiFailed = true;
  } catch {
    aiFailed = true;
  }

  // Parse <fs>...</fs> for updated filesystem
  let fsUpdate = null;
  if (!aiFailed && aiOutput.includes("<fs>")) {
    const match = aiOutput.match(/<fs>([\s\S]*?)<\/fs>/);
    if (match) {
      try {
        fsUpdate = JSON.parse(match[1]);
        aiOutput = aiOutput.replace(match[0], "").trim();
      } catch {}
    }
  }

  // Fallback to DB if AI failed
  if (aiFailed) {
    const dbOutput = getCommandDBOutput(command);
    return NextResponse.json({
      output: dbOutput ?? `bash: ${command}: command not found`,
      fsUpdate: null,
    });
  }

  return NextResponse.json({ output: aiOutput, fsUpdate });
}
