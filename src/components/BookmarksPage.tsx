"use client";

import { Star, Trash2 } from "lucide-react";
import { GlassCard } from "@/components/GlassCard";
import { CopyButton } from "@/components/CopyButton";
import type { SessionCommand } from "@/lib/session";

interface BookmarksPageProps {
  bookmarks: SessionCommand[];
  onRemove: (id: string) => void;
  onCopy: () => void;
}

export function BookmarksPage({ bookmarks, onRemove, onCopy }: BookmarksPageProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-white">Bookmarks</h2>
        <p className="mt-1 text-sm text-gray-400">Saved commands you can quickly reuse.</p>
      </div>

      {bookmarks.length === 0 ? (
        <GlassCard>
          <p className="text-sm text-gray-400">
            No bookmarks yet. Star a command in the generator or terminal output.
          </p>
        </GlassCard>
      ) : (
        <div className="space-y-3">
          {bookmarks.map((item) => (
            <GlassCard key={item.id} className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                  <span>{new Date(item.createdAt).toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-2">
                  <CopyButton text={item.input} onCopied={onCopy} />
                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-red-300 transition hover:bg-red-500/20"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <pre className="overflow-x-auto rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-sm text-[#4CAF50]">
                $ {item.input}
              </pre>
              {item.output && (
                <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-xs text-gray-400">
                  {item.output}
                </pre>
              )}
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
