"use client";

import { useMemo, useState } from "react";
import { History } from "lucide-react";
import { GlassCard } from "@/components/GlassCard";
import { CopyButton } from "@/components/CopyButton";
import { matchesCommandFilter, type CommandFilter, type SessionCommand } from "@/lib/session";

const FILTERS: CommandFilter[] = ["All", "AI Generated", "DB Fallback", "Local"];

function sourceLabel(source: SessionCommand["source"]) {
  if (source === "db") return "DB Fallback";
  if (source === "local") return "Local";
  return "AI Generated";
}

interface CommandHistoryProps {
  rows: SessionCommand[];
  onCopy: () => void;
}

export function CommandHistory({ rows, onCopy }: CommandHistoryProps) {
  const [filter, setFilter] = useState<CommandFilter>("All");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const perPage = 10;

  const filtered = useMemo(() => {
    const query = search.toLowerCase().trim();
    return rows.filter((row) => {
      if (!matchesCommandFilter(row.source, filter)) return false;
      if (!query) return true;
      return row.input.toLowerCase().includes(query) || row.output.toLowerCase().includes(query);
    });
  }, [filter, rows, search]);

  const paged = filtered.slice(page * perPage, (page + 1) * perPage);
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">
        <History className="mr-2 inline h-7 w-7 text-[#E95420]" />
        Command History
      </h2>

      <GlassCard>
        <div className="flex flex-wrap gap-3">
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            placeholder="Search command history..."
            className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white"
          />
          {FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setFilter(item);
                setPage(0);
              }}
              className={`micro-button rounded-full px-3 py-1 text-xs ${
                filter === item
                  ? "bg-[#E95420] text-white"
                  : "border border-white/10 text-gray-300"
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </GlassCard>

      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-white/5 text-gray-400">
            <tr>
              <th className="p-3">Command</th>
              <th className="p-3">Source</th>
              <th className="p-3">Date</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {paged.map((row) => (
              <tr key={row.id} className="border-t border-white/5">
                <td className="p-3 font-mono text-[#4CAF50]">{row.input}</td>
                <td className="p-3 text-gray-300">{sourceLabel(row.source)}</td>
                <td className="p-3 text-gray-500">{new Date(row.createdAt).toLocaleString()}</td>
                <td className="p-3">
                  <CopyButton text={row.input} onCopied={onCopy} />
                </td>
              </tr>
            ))}
            {paged.length === 0 && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-sm text-gray-500">
                  No commands found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-center gap-2">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setPage((previous) => previous - 1)}
          className="micro-button rounded-lg border border-white/10 px-3 py-1 text-sm disabled:opacity-40"
        >
          Prev
        </button>
        <span className="text-sm text-gray-400">
          Page {page + 1} / {totalPages}
        </span>
        <button
          type="button"
          disabled={page + 1 >= totalPages}
          onClick={() => setPage((previous) => previous + 1)}
          className="micro-button rounded-lg border border-white/10 px-3 py-1 text-sm disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
