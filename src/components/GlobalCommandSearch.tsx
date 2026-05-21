"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, X } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { matchesCommandFilter, type CommandFilter, type SessionCommand } from "@/lib/session";

const FILTERS: CommandFilter[] = ["All", "AI Generated", "DB Fallback", "Local"];

function sourceLabel(source: SessionCommand["source"]): string {
  if (source === "db") return "DB Fallback";
  if (source === "local") return "Local";
  return "AI Generated";
}

interface GlobalCommandSearchProps {
  isOpen: boolean;
  onClose: () => void;
  items: SessionCommand[];
  onCopy: () => void;
}

export function GlobalCommandSearch({ isOpen, onClose, items, onCopy }: GlobalCommandSearchProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CommandFilter>("All");

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setFilter("All");
    }
  }, [isOpen]);

  const filtered = useMemo(() => {
    const needle = query.toLowerCase().trim();
    return items
      .filter((item) => matchesCommandFilter(item.source, filter))
      .filter((item) => {
        if (!needle) return true;
        return (
          item.input.toLowerCase().includes(needle) || item.output.toLowerCase().includes(needle)
        );
      })
      .slice(0, 20);
  }, [items, query, filter]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 px-4 pt-20 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="w-full max-w-3xl rounded-xl border border-white/15 bg-[#170a29] p-4 shadow-2xl"
            initial={{ y: -12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -12, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              <Search className="h-4 w-4 text-gray-400" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search commands and bookmarks..."
                className="w-full bg-transparent text-sm text-white placeholder:text-gray-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-gray-400 transition hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {FILTERS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setFilter(option)}
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    filter === option
                      ? "border-[#E95420]/50 bg-[#E95420]/15 text-[#E95420]"
                      : "border-white/10 text-gray-400 hover:text-white"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>

            <div className="mt-4 max-h-[60vh] space-y-2 overflow-y-auto pr-1">
              {filtered.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/15 p-6 text-center text-sm text-gray-400">
                  No matching commands.
                </div>
              ) : (
                filtered.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-lg border border-white/10 bg-black/20 p-3 transition hover:border-[#E95420]/30"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-mono text-sm text-[#4CAF50]">$ {item.input}</p>
                      <CopyButton text={item.input} onCopied={onCopy} />
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {sourceLabel(item.source)} • {new Date(item.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
