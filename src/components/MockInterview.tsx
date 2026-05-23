"use client";

import { useMemo, useState } from "react";
import { Loader2, Mic } from "lucide-react";
import { GlassCard } from "@/components/GlassCard";
import type { InterviewHistoryItem } from "@/lib/session";
import { getHfHeaders } from "@/lib/utils";

const QUESTION_BANK = [
  "How does Linux file permission `750` work in a production web app folder?",
  "Explain the difference between a process and a thread in Linux.",
  "How would you troubleshoot high CPU usage on a Linux server?",
  "What is the difference between `systemctl restart` and `systemctl reload`?",
  "How do you roll back a bad deploy in a Git-based CI/CD pipeline?",
  "Describe how DNS resolution works when calling an API from a container.",
  "How do you secure SSH access on a production VM?",
  "What are common reasons for Kubernetes pods entering CrashLoopBackOff?",
  "How would you monitor and alert on disk usage before outages happen?",
  "What is the purpose of infrastructure as code in DevOps teams?",
];

interface InterviewResponse {
  score: number;
  good: string;
  missing: string;
  modelAnswer: string;
}

interface MockInterviewProps {
  onAwardXp: (amount: number, message: string) => void;
  onHistoryAdd: (item: InterviewHistoryItem) => void;
}

export function MockInterview({ onAwardXp, onHistoryAdd }: MockInterviewProps) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<InterviewResponse | null>(null);
  const [error, setError] = useState("");
  const [localHistory, setLocalHistory] = useState<InterviewHistoryItem[]>([]);

  const question = QUESTION_BANK[questionIndex];
  const canSubmit = answer.trim().length > 0 && !loading;

  const summaryText = useMemo(() => {
    if (!result) return "";
    if (result.score >= 8) return "Strong answer. Great structure and depth.";
    if (result.score >= 5) return "Solid baseline. Add more implementation detail.";
    return "Needs more precision. Focus on practical steps and tradeoffs.";
  }, [result]);

  async function submit() {
    if (!canSubmit) return;
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch("/api/interview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getHfHeaders(),
        },
        body: JSON.stringify({
          action: "answer",
          topic: "Linux SysAdmin",
          difficulty: "Mid",
          question,
          answer: answer.trim(),
          questionNumber: questionIndex + 1,
        }),
      });
      const data = (await response.json()) as InterviewResponse & { error?: string; message?: string };
      if (!response.ok) {
        throw new Error(data.message || data.error || "Interview scoring failed");
      }


      const score = Math.max(0, Math.min(10, Math.round(data.score)));
      const xpAward = score * 5;
      onAwardXp(xpAward, `Interview scored ${score}/10 • +${xpAward} XP`);

      const entry: InterviewHistoryItem = {
        id: Math.random().toString(36).slice(2, 10),
        question,
        answer: answer.trim(),
        score,
        good: data.good,
        missing: data.missing,
        modelAnswer: data.modelAnswer,
        xpEarned: xpAward,
        createdAt: new Date().toISOString(),
      };
      onHistoryAdd(entry);
      setLocalHistory((previous) => [entry, ...previous].slice(0, 10));
      setResult({ ...data, score });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Interview scoring failed");
    } finally {
      setLoading(false);
    }
  }

  function nextQuestion() {
    setQuestionIndex((previous) => (previous + 1) % QUESTION_BANK.length);
    setAnswer("");
    setResult(null);
    setError("");
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-white">
          <Mic className="mr-2 inline h-6 w-6 text-[#E95420]" />
          Mock Interview
        </h2>
        <p className="mt-1 text-sm text-gray-400">
          Answer one Linux/DevOps question at a time and get a model-scored review.
        </p>
      </div>

      <GlassCard className="space-y-4">
        <p className="font-mono text-[#4CAF50]">interviewer@linlearn:~$ {question}</p>
        <textarea
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          rows={6}
          placeholder="Type your answer with practical steps..."
          className="w-full rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-white placeholder:text-gray-500 focus:border-[#E95420]/40 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="micro-button flex items-center gap-2 rounded-lg bg-[#E95420] px-4 py-2 text-white transition hover:bg-[#ff6b36] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Submit Answer
          </button>
          <button
            type="button"
            onClick={nextQuestion}
            className="micro-button rounded-lg border border-white/15 px-4 py-2 text-sm text-gray-300"
          >
            Next Question
          </button>
        </div>
        {error && <p className="text-sm text-rose-300">{error}</p>}
      </GlassCard>

      {result && (
        <GlassCard className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-semibold text-white">Interview Feedback</h3>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-sm text-emerald-300">
              Score: {result.score}/10
            </span>
          </div>
          <p className="text-sm text-gray-300">{summaryText}</p>
          <div className="space-y-2 rounded-lg border border-white/10 bg-black/25 p-3 text-sm">
            <p className="text-emerald-300">
              <span className="font-semibold">What was good:</span> {result.good}
            </p>
            <p className="text-amber-200">
              <span className="font-semibold">What was missing:</span> {result.missing}
            </p>
            <p className="text-gray-300">
              <span className="font-semibold">Model answer:</span> {result.modelAnswer}
            </p>
          </div>
        </GlassCard>
      )}

      {localHistory.length > 0 && (
        <GlassCard>
          <h3 className="text-sm font-semibold text-white">Session Interview History</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {localHistory.map((item) => (
              <li key={item.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                <p className="line-clamp-1 text-gray-300">{item.question}</p>
                <p className="mt-1 text-xs text-emerald-300">
                  Score {item.score}/10 • +{item.xpEarned} XP
                </p>
              </li>
            ))}
          </ul>
        </GlassCard>
      )}
    </div>
  );
}
