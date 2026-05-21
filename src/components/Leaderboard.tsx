"use client";

import { Crown, Flame, Medal } from "lucide-react";
import { GlassCard } from "@/components/GlassCard";

interface LeaderboardProps {
  username: string;
  xp: number;
}

const MOCK_USERS = [
  { id: "u1", name: "KernelKhan", xp: 1860 },
  { id: "u2", name: "ShellNinja", xp: 1720 },
  { id: "u3", name: "DevOpsDiva", xp: 1665 },
  { id: "u4", name: "PacketPilot", xp: 1510 },
  { id: "u5", name: "CronCaptain", xp: 1435 },
  { id: "u6", name: "StackSage", xp: 1320 },
  { id: "u7", name: "GitGuru", xp: 1240 },
  { id: "u8", name: "CLIComet", xp: 1155 },
  { id: "u9", name: "RootRanger", xp: 1010 },
  { id: "u10", name: "PipesAndFlags", xp: 980 },
];

function medal(rank: number) {
  if (rank === 1) return <Crown className="h-4 w-4 text-yellow-300" />;
  if (rank === 2) return <Medal className="h-4 w-4 text-slate-300" />;
  if (rank === 3) return <Medal className="h-4 w-4 text-amber-400" />;
  return <span className="w-4 text-right text-xs text-gray-400">#{rank}</span>;
}

export function Leaderboard({ username, xp }: LeaderboardProps) {
  const rows = [...MOCK_USERS, { id: "me", name: username || "You", xp }]
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 11);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-white">Leaderboard</h2>
        <p className="mt-1 text-sm text-gray-400">Top Linux learners by XP this session.</p>
      </div>

      <GlassCard>
        <ul className="space-y-2">
          {rows.map((row, index) => {
            const isCurrentUser = row.id === "me";
            const rank = index + 1;
            return (
              <li
                key={`${row.id}-${rank}`}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
                  isCurrentUser
                    ? "border-[#E95420]/60 bg-[#E95420]/15"
                    : "border-white/10 bg-black/20"
                }`}
              >
                <div className="flex items-center gap-3">
                  {medal(rank)}
                  <span className={isCurrentUser ? "font-semibold text-[#E95420]" : "text-white"}>
                    {row.name}
                  </span>
                  {isCurrentUser && (
                    <span className="rounded-full border border-[#E95420]/40 px-2 py-0.5 text-xs text-[#E95420]">
                      You
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 font-mono text-sm text-amber-300">
                  <Flame className="h-4 w-4" />
                  {row.xp} XP
                </div>
              </li>
            );
          })}
        </ul>
      </GlassCard>
    </div>
  );
}
