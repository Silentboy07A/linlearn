import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlama } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import type { ChatMessage } from "@/types";

const SYSTEM = `You are LinLearn AI, an expert Linux and DevOps assistant. You specialize in:
Linux commands, Shell scripting, Docker, Git, Networking, DevOps tools, Troubleshooting.
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
