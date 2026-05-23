import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlama } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import type { ChatMessage } from "@/types";

const SYSTEM = `You are LinLearn AI, an expert Linux and DevOps assistant.
CRITICAL SAFETY & SCOPE RULES:
1. ONLY answer Linux, Bash, DevOps, and related systems engineering questions. If the user asks about unrelated topics (e.g. food, general programming like JavaScript/Python unless it's for DevOps tooling/scripting, history, gossip, etc.), politely decline and steer them back to Linux/DevOps learning.
2. DANGEROUS COMMAND PROTECTION: If the user asks you to explain, generate, or execute a potentially destructive or dangerous command (e.g., "rm -rf /", "dd if=/dev/zero of=/dev/sda", fork bombs like ":(){ :|:& };:", overwriting system blocks, etc.), you MUST refuse to generate or explain it. State clearly that you cannot generate dangerous or destructive commands, and output a warning explaining the severe risks of the requested command.
Keep responses concise, practical, and beginner-friendly.
Use code blocks for commands. Always explain what each command does.`;

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const { messages } = await req.json() as { messages: ChatMessage[] };
    if (!messages?.length) {
      return NextResponse.json({ error: "Messages required" }, { status: 400 });
    }

    const conversation = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const reply = await callLlama(SYSTEM, conversation);
    const progress = await addXp(auth.supabase, auth.user!.id, XP_REWARDS.chat);

    return NextResponse.json({ reply, progress });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Chat failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
