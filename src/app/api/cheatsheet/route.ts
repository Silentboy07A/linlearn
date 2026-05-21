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

    let result: CheatSheetResponse;
    let source = "ai";

    // ── AI first ──
    try {
      result = await callLlamaJson<CheatSheetResponse>(
        SYSTEM,
        `Topic: ${topic}\nStyle: ${style || "Detailed"}`
      );
    } catch (aiErr) {
      console.warn("AI cheatsheet failed, falling back to DB:", aiErr);
      source = "db";

      // ── DB fallback: query linux_commands table by topic keyword ──
      const { data: commands, error: dbErr } = await auth.supabase
        .from("linux_commands")
        .select("command_name, description, example_usage, category")
        .ilike("category", `%${topic}%`)
        .limit(50);

      // If category search returns too few results, broaden to keyword in description
      const rows =
        commands && commands.length >= 3
          ? commands
          : (
              await auth.supabase
                .from("linux_commands")
                .select("command_name, description, example_usage, category")
                .or(
                  `description.ilike.%${topic}%,command_name.ilike.%${topic}%`
                )
                .limit(50)
            ).data ?? [];

      if (dbErr || rows.length === 0) {
        throw new Error("AI unavailable and no matching commands in DB.");
      }

      // Group rows by their category into sections
      const grouped: Record<string, typeof rows> = {};
      for (const row of rows) {
        const key = row.category || "General";
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(row);
      }

      result = {
        title: `${topic} Cheat Sheet`,
        sections: Object.entries(grouped).map(([heading, items]) => ({
          heading,
          items: items.map((r) => ({
            command: r.command_name,
            description: `${r.description} — e.g. ${r.example_usage}`,
          })),
        })),
      };
    }

    await auth.supabase.from("cheatsheets").insert({
      user_id: auth.user!.id,
      topic,
      content: JSON.stringify(result),
    });

    const progress = await addXp(auth.supabase, auth.user!.id, XP_REWARDS.cheatsheet);

    return NextResponse.json({ ...result, progress, source });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Cheat sheet generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
