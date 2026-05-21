"use client";

import { useState } from "react";
import { Loader2, Sparkles, AlertTriangle, Star } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { CopyButton } from "./CopyButton";
import { TerminalPrompt } from "./TerminalPrompt";
import { riskBadgeClass } from "@/lib/utils";
import type { SessionCommand } from "@/lib/session";
import type { CommandResponse } from "@/types";

interface CommandGeneratorProps {
  onSuccess?: () => void;
  onCommandGenerated: (command: SessionCommand) => void;
  onCopy: () => void;
  onToggleBookmark: (command: SessionCommand) => void;
  isBookmarked: (commandId: string) => boolean;
}

export function CommandGenerator({
  onSuccess,
  onCommandGenerated,
  onCopy,
  onToggleBookmark,
  isBookmarked,
}: CommandGeneratorProps) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CommandResponse | null>(null);
  const [latestCommand, setLatestCommand] = useState<SessionCommand | null>(null);

  const generate = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(data);
      const commandItem: SessionCommand = {
        id: Math.random().toString(36).slice(2, 10),
        input: data.command,
        output: data.output || data.explanation || "",
        source: "ai-generated",
        createdAt: new Date().toISOString(),
      };
      setLatestCommand(commandItem);
      onCommandGenerated(commandItem);
      onSuccess?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">
        <span className="text-[#E95420]">AI</span> Command Generator
      </h2>

      <GlassCard>
        <TerminalPrompt />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && generate()}
          placeholder="Describe what you want to do... e.g. Find large files over 1GB"
          className="mt-3 w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 font-mono text-white placeholder:text-gray-600 focus:border-[#E95420]/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={generate}
          disabled={loading}
          className="mt-4 flex items-center gap-2 rounded-lg bg-[#E95420] px-6 py-2.5 font-medium text-white hover:bg-[#E95420]/90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Generate
        </button>
      </GlassCard>

      {error && <p className="text-red-400">{error}</p>}

      {result && (
        <GlassCard>
          <div className="mb-3 flex flex-wrap justify-between gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-xs ${riskBadgeClass(result.risk)}`}>
              {result.risk} Risk
            </span>
            <div className="flex items-center gap-2">
              {latestCommand && (
                <button
                  type="button"
                  onClick={() => onToggleBookmark(latestCommand)}
                  className={`micro-button rounded-md border p-2 transition ${
                    isBookmarked(latestCommand.id)
                      ? "border-yellow-400/50 bg-yellow-400/10 text-yellow-300"
                      : "border-white/10 bg-white/5 text-gray-300 hover:text-yellow-300"
                  }`}
                  title="Bookmark command"
                >
                  <Star
                    className={`h-4 w-4 ${isBookmarked(latestCommand.id) ? "fill-yellow-300" : ""}`}
                  />
                </button>
              )}
              <CopyButton text={result.command} onCopied={onCopy} />
            </div>
          </div>
          <pre className="rounded-lg border border-[#4CAF50]/30 bg-black/40 p-4 font-mono text-[#4CAF50]">
            $ {result.command}
          </pre>
          <p className="mt-4 text-gray-300">{result.explanation}</p>
          {result.output && (
            <pre className="mt-4 rounded-lg bg-black/30 p-3 font-mono text-sm text-gray-400">
              {result.output}
            </pre>
          )}
          {result.warning && (
            <div className="mt-4 flex gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-yellow-400">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <p className="text-sm">{result.warning}</p>
            </div>
          )}
        </GlassCard>
      )}
    </div>
  );
}
