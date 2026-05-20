"use client";

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { GlassCard } from "./GlassCard";
import { CopyButton } from "./CopyButton";
import { riskBadgeClass } from "@/lib/utils";
import type { CommandHistoryRow } from "@/types";

export function CommandHistory() {
  const [rows, setRows] = useState<CommandHistoryRow[]>([]);
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const perPage = 10;

  useEffect(() => {
    const load = async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("command_history")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      setRows((data as CommandHistoryRow[]) || []);
    };
    load();
  }, []);

  const filtered = rows.filter((r) => {
    if (filter !== "All" && r.risk_level !== filter) return false;
    const q = search.toLowerCase();
    return (
      r.query.toLowerCase().includes(q) ||
      r.command.toLowerCase().includes(q)
    );
  });

  const paged = filtered.slice(page * perPage, (page + 1) * perPage);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">
        <History className="inline h-7 w-7 text-[#E95420]" /> Command History
      </h2>
      <GlassCard>
        <div className="flex flex-wrap gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white"
          />
          {["All", "Low", "Medium", "High"].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1 text-sm ${
                filter === f ? "bg-[#E95420] text-white" : "border border-white/10"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </GlassCard>
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-white/5 text-gray-400">
            <tr>
              <th className="p-3">Query</th>
              <th className="p-3">Command</th>
              <th className="p-3">Risk</th>
              <th className="p-3">Date</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {paged.map((r) => (
              <tr key={r.id} className="border-t border-white/5">
                <td className="p-3 text-gray-300">{r.query}</td>
                <td className="p-3 font-mono text-[#4CAF50]">{r.command.slice(0, 50)}</td>
                <td className="p-3">
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${riskBadgeClass(r.risk_level || "Low")}`}>
                    {r.risk_level}
                  </span>
                </td>
                <td className="p-3 text-gray-500">
                  {new Date(r.created_at).toLocaleDateString()}
                </td>
                <td className="p-3">
                  <CopyButton text={r.command} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-center gap-2">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
          className="rounded-lg border border-white/10 px-3 py-1 text-sm disabled:opacity-40"
        >
          Prev
        </button>
        <span className="text-sm text-gray-400">
          Page {page + 1} / {Math.max(1, Math.ceil(filtered.length / perPage))}
        </span>
        <button
          type="button"
          disabled={(page + 1) * perPage >= filtered.length}
          onClick={() => setPage((p) => p + 1)}
          className="rounded-lg border border-white/10 px-3 py-1 text-sm disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
