"use client";

import { useState } from "react";
import { FileText, Download, Loader2 } from "lucide-react";
import { jsPDF } from "jspdf";
import { GlassCard } from "./GlassCard";
import { CopyButton } from "./CopyButton";
import type { CheatSheetResponse } from "@/types";
import { getHfHeaders } from "@/lib/utils";

const TOPICS = [
  "Git",
  "Docker",
  "Vim",
  "Bash Scripting",
  "Linux Commands",
  "Networking",
  "Kubernetes",
  "SSH",
  "Grep & Sed & Awk",
  "Cron Jobs",
];
const STYLES = ["Minimal", "Detailed", "Interview-Ready"];

export function CheatSheetGenerator({ onSuccess }: { onSuccess?: () => void }) {
  const [topic, setTopic] = useState(TOPICS[0]);
  const [style, setStyle] = useState(STYLES[1]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheatSheetResponse | null>(null);
  const [error, setError] = useState("");

  const generate = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/cheatsheet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getHfHeaders(),
        },
        body: JSON.stringify({ topic, style }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(data);
      onSuccess?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  const downloadPdf = () => {
    if (!result) return;
    const doc = new jsPDF();
    let y = 20;
    doc.setFontSize(16);
    doc.text(result.title, 14, y);
    y += 12;
    doc.setFontSize(10);
    result.sections.forEach((sec) => {
      doc.setFont("helvetica", "bold");
      doc.text(sec.heading, 14, y);
      y += 7;
      doc.setFont("helvetica", "normal");
      sec.items.forEach((item) => {
        if (y > 270) {
          doc.addPage();
          y = 20;
        }
        doc.text(`${item.command} — ${item.description}`, 16, y);
        y += 6;
      });
      y += 4;
    });
    doc.save(`linlearn-${topic.replace(/\s+/g, "-").toLowerCase()}.pdf`);
  };

  const copyAll = () => {
    if (!result) return;
    const text = result.sections
      .map(
        (s) =>
          `## ${s.heading}\n` + s.items.map((i) => `${i.command} — ${i.description}`).join("\n")
      )
      .join("\n\n");
    navigator.clipboard.writeText(`${result.title}\n\n${text}`);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-white">
        <FileText className="inline h-7 w-7 text-[#E95420]" /> Cheat Sheet Generator
      </h2>
      <GlassCard>
        <select
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-black/30 p-2 text-white"
        >
          {TOPICS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <div className="mt-3 flex flex-wrap gap-2">
          {STYLES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStyle(s)}
              className={`rounded-full px-3 py-1 text-sm ${
                style === s ? "bg-[#E95420] text-white" : "border border-white/10"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={loading}
          className="mt-4 flex items-center gap-2 rounded-lg bg-[#E95420] px-6 py-2 text-white"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Generate Cheat Sheet
        </button>
      </GlassCard>
      {error && <p className="text-red-400">{error}</p>}
      {result && (
        <GlassCard>
          <div className="mb-4 flex flex-wrap gap-2">
            <CopyButton text={result.title} label="Copy All" />
            <button type="button" onClick={copyAll} className="text-sm text-gray-400 underline">
              Copy full sheet
            </button>
            <button
              type="button"
              onClick={downloadPdf}
              className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1 text-sm"
            >
              <Download className="h-4 w-4" /> PDF
            </button>
          </div>
          <h3 className="text-xl font-bold text-[#E95420]">{result.title}</h3>
          {result.sections.map((sec) => (
            <div key={sec.heading} className="mt-6">
              <h4 className="border-b border-white/10 pb-1 font-medium text-[#4CAF50]">
                {sec.heading}
              </h4>
              <ul className="mt-2 space-y-2">
                {sec.items.map((item) => (
                  <li key={item.command} className="rounded-lg bg-black/30 p-3 font-mono text-sm">
                    <span className="text-[#4CAF50]">{item.command}</span>
                    <p className="mt-1 font-sans text-xs text-gray-400">{item.description}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </GlassCard>
      )}
    </div>
  );
}
