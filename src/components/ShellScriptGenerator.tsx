"use client";

import { useState } from "react";
import { Code, Download, Loader2, AlertTriangle } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { CopyButton } from "./CopyButton";
import { TerminalPrompt } from "./TerminalPrompt";
import type { ScriptResponse } from "@/types";

import { getHfHeaders } from "@/lib/utils";

const DIFFICULTIES = ["Simple", "Intermediate", "Advanced"] as const;

export function ShellScriptGenerator({ onSuccess }: { onSuccess?: () => void }) {
  const [description, setDescription] = useState("");
  const [difficulty, setDifficulty] = useState("Intermediate");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScriptResponse | null>(null);

  const generate = async () => {
    if (!description.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/script", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getHfHeaders(),
        },
        body: JSON.stringify({ description, difficulty }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Failed to generate script.");
      setResult(data);
      onSuccess?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
 finally {
      setLoading(false);
    }
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([result.script], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "linlearn-script.sh";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">
        <span className="text-[#E95420]">Shell</span> Script Generator
      </h2>
      <GlassCard>
        <TerminalPrompt />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe your task in plain English..."
          rows={3}
          className="mt-3 w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 font-mono text-white focus:outline-none"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {DIFFICULTIES.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDifficulty(d)}
              className={`rounded-full px-3 py-1 text-sm ${
                difficulty === d ? "bg-[#E95420] text-white" : "border border-white/10 text-gray-400"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={loading}
          className="mt-4 flex items-center gap-2 rounded-lg bg-[#E95420] px-6 py-2 text-white disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Code className="h-4 w-4" />}
          Generate Script
        </button>
      </GlassCard>
      {error && <p className="text-red-400">{error}</p>}
      {result && (
        <GlassCard>
          <div className="mb-3 flex flex-wrap gap-2">
            <CopyButton text={result.script} label="Copy Script" />
            <button
              type="button"
              onClick={download}
              className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-sm"
            >
              <Download className="h-4 w-4" /> Download .sh
            </button>
          </div>
          <pre className="max-h-96 overflow-auto rounded-lg border border-[#4CAF50]/30 bg-black/50 p-4 font-mono text-sm text-[#4CAF50]">
            {result.script}
          </pre>
          <h4 className="mt-4 font-medium text-[#E95420]">Breakdown</h4>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-300">
            {result.breakdown.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ol>
          {result.warning && (
            <div className="mt-4 flex gap-2 text-yellow-400">
              <AlertTriangle className="h-5 w-5" />
              <p className="text-sm">{result.warning}</p>
            </div>
          )}
        </GlassCard>
      )}
    </div>
  );
}
