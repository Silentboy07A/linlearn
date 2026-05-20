"use client";

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { GlassCard } from "./GlassCard";
import { CopyButton } from "./CopyButton";
import type { ErrorExplainResponse } from "@/types";

export function ErrorExplainer({ onSuccess }: { onSuccess?: () => void }) {
  const [errorText, setErrorText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ErrorExplainResponse | null>(null);
  const [err, setErr] = useState("");

  const explain = async () => {
    if (!errorText.trim()) return;
    setLoading(true);
    setErr("");
    try {
      const res = await fetch("/api/error-explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: errorText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(data);
      onSuccess?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">
        <AlertTriangle className="inline h-7 w-7 text-red-400" /> Error Explainer
      </h2>
      <GlassCard>
        <textarea
          value={errorText}
          onChange={(e) => setErrorText(e.target.value)}
          rows={6}
          placeholder="Paste your Linux error here..."
          className="w-full rounded-lg border border-white/10 bg-black/30 p-4 font-mono text-[#4CAF50]"
        />
        <button
          type="button"
          onClick={explain}
          disabled={loading}
          className="mt-4 flex items-center gap-2 rounded-lg bg-[#E95420] px-6 py-2 text-white"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Explain
        </button>
      </GlassCard>
      {err && <p className="text-red-400">{err}</p>}
      {result && (
        <div className="space-y-4">
          <GlassCard>
            <h4 className="text-[#E95420]">Summary</h4>
            <p className="mt-2 text-gray-300">{result.summary}</p>
          </GlassCard>
          <GlassCard>
            <h4 className="text-red-400">Root Cause</h4>
            <p className="mt-2 text-gray-300">{result.rootCause}</p>
          </GlassCard>
          <GlassCard>
            <h4 className="text-[#4CAF50]">Fix Steps</h4>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-gray-300">
              {result.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </GlassCard>
          <GlassCard>
            <h4 className="text-gray-400">Prevention</h4>
            <ul className="mt-2 list-disc pl-5 text-gray-300">
              {result.prevention.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </GlassCard>
          <GlassCard>
            <h4 className="text-[#4CAF50]">Commands</h4>
            <ul className="mt-2 space-y-2">
              {result.commands.map((c) => (
                <li key={c} className="flex justify-between gap-2 font-mono text-sm">
                  <span>$ {c}</span>
                  <CopyButton text={c} />
                </li>
              ))}
            </ul>
          </GlassCard>
        </div>
      )}
    </div>
  );
}
