"use client";

import { useState } from "react";
import { Mic, Loader2 } from "lucide-react";
import { GlassCard } from "./GlassCard";
import type { InterviewAnswerResponse, InterviewReportResponse } from "@/types";

const TOPICS = [
  "Linux SysAdmin",
  "DevOps Engineer",
  "Docker & Kubernetes",
  "Shell Scripting",
  "Git & Version Control",
  "Networking",
];
const LEVELS = ["Junior", "Mid", "Senior"];

interface AnswerRecord {
  question: string;
  answer: string;
  score: number;
}

export function MockInterview({ onSuccess }: { onSuccess?: () => void }) {
  const [topic, setTopic] = useState(TOPICS[0]);
  const [difficulty, setDifficulty] = useState("Junior");
  const [phase, setPhase] = useState<"select" | "interview" | "report">("select");
  const [question, setQuestion] = useState("");
  const [questionNum, setQuestionNum] = useState(1);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<InterviewAnswerResponse | null>(null);
  const [records, setRecords] = useState<AnswerRecord[]>([]);
  const [report, setReport] = useState<InterviewReportResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const start = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", topic, difficulty }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setQuestion(data.question);
      setQuestionNum(1);
      setPhase("interview");
      setRecords([]);
      setFeedback(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  const submitAnswer = async () => {
    if (!answer.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "answer",
          topic,
          difficulty,
          question,
          answer,
          questionNumber: questionNum,
        }),
      });
      const data: InterviewAnswerResponse = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error);
      setFeedback(data);
      setRecords((r) => [...r, { question, answer, score: data.score }]);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  const next = async () => {
    if (!feedback) return;
    const allRecords = [...records];
    if (!feedback.nextQuestion || questionNum >= 5) {
      setLoading(true);
      const res = await fetch("/api/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "report",
          topic,
          answers: allRecords,
        }),
      });
      const data = await res.json();
      setReport(data);
      setPhase("report");
      onSuccess?.();
      setLoading(false);
      return;
    }
    setQuestion(feedback.nextQuestion);
    setQuestionNum((n) => n + 1);
    setAnswer("");
    setFeedback(null);
  };

  if (phase === "select") {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold text-white">
          <Mic className="inline h-7 w-7 text-[#E95420]" /> Mock Interview
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {TOPICS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTopic(t)}
              className={`rounded-lg border p-3 text-left text-sm ${
                topic === t ? "border-[#E95420] text-[#E95420]" : "border-white/10 text-gray-400"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <GlassCard>
          <div className="flex gap-2">
            {LEVELS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setDifficulty(l)}
                className={`rounded-full px-3 py-1 text-sm ${
                  difficulty === l ? "bg-[#E95420] text-white" : "border border-white/10"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={start}
            disabled={loading}
            className="mt-4 w-full rounded-lg bg-[#E95420] py-3 text-white"
          >
            Start Interview
          </button>
        </GlassCard>
      </div>
    );
  }

  if (phase === "report" && report) {
    return (
      <GlassCard className="space-y-4">
        <h3 className="text-xl font-bold text-white">Final Report</h3>
        <p className="text-3xl font-bold text-[#4CAF50]">{report.totalScore}/50</p>
        <p className="text-[#E95420]">{report.performance}</p>
        <div>
          <h4 className="text-sm text-gray-400">Strengths</h4>
          <ul className="list-disc pl-5 text-sm text-gray-300">
            {report.strengths.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="text-sm text-gray-400">Improve</h4>
          <ul className="list-disc pl-5 text-sm text-gray-300">
            {report.improvements.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={() => setPhase("select")}
          className="rounded-lg bg-[#E95420] px-4 py-2 text-white"
        >
          New Interview
        </button>
      </GlassCard>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Question {questionNum}/5 — {topic}
      </p>
      <GlassCard>
        <p className="font-mono text-[#4CAF50]">interviewer@linlearn:~$ {question}</p>
        {!feedback ? (
          <>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={6}
              className="mt-4 w-full rounded-lg border border-white/10 bg-black/30 p-3 text-white"
              placeholder="Type your answer..."
            />
            <button
              type="button"
              onClick={submitAnswer}
              disabled={loading}
              className="mt-3 flex items-center gap-2 rounded-lg bg-[#E95420] px-4 py-2 text-white"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Submit Answer
            </button>
          </>
        ) : (
          <div className="mt-4 space-y-3 text-sm">
            <p>
              Score: <span className="text-[#4CAF50]">{feedback.score}/10</span>
            </p>
            <p className="text-gray-300">
              <strong className="text-[#4CAF50]">Good:</strong> {feedback.good}
            </p>
            <p className="text-gray-300">
              <strong className="text-yellow-400">Missing:</strong> {feedback.missing}
            </p>
            <p className="text-gray-400">
              <strong>Model:</strong> {feedback.modelAnswer}
            </p>
            <button
              type="button"
              onClick={next}
              className="rounded-lg bg-[#E95420] px-4 py-2 text-white"
            >
              {questionNum >= 5 ? "View Report" : "Next Question"}
            </button>
          </div>
        )}
      </GlassCard>
    </div>
  );
}
