"use client";

import { useState, useEffect, useCallback } from "react";
import { Trophy, Clock } from "lucide-react";
import { GlassCard } from "./GlassCard";
import type { QuizQuestion } from "@/types";

const CATEGORIES = [
  "Linux Basics",
  "Shell Commands",
  "Git",
  "Docker",
  "Networking",
  "File Permissions",
  "DevOps Fundamentals",
];

const DIFFICULTIES = ["Beginner", "Intermediate", "Advanced"];

export function QuizArena({ onSuccess }: { onSuccess?: () => void }) {
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [difficulty, setDifficulty] = useState("Beginner");
  const [phase, setPhase] = useState<"select" | "quiz" | "done">("select");
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [showExp, setShowExp] = useState(false);
  const [timeLeft, setTimeLeft] = useState(30);
  const [loading, setLoading] = useState(false);
  const [xpEarned, setXpEarned] = useState(0);

  const start = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, difficulty }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setQuestions(data.questions);
      setPhase("quiz");
      setIndex(0);
      setScore(0);
      setTimeLeft(30);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to load quiz");
    } finally {
      setLoading(false);
    }
  };

  const answer = useCallback(
    (idx: number) => {
      if (showExp || !questions[index]) return;
      setSelected(idx);
      setShowExp(true);
      if (idx === questions[index].correct) setScore((s) => s + 1);
    },
    [showExp, questions, index]
  );

  useEffect(() => {
    if (phase !== "quiz" || showExp) return;
    const t = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          answer(-1);
          return 30;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [phase, showExp, index, answer]);

  const next = async () => {
    if (index + 1 >= questions.length) {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          difficulty,
          score,
          total: questions.length,
        }),
      });
      const data = await res.json();
      setXpEarned(data.xpEarned ?? score * 20);
      setPhase("done");
      onSuccess?.();
      return;
    }
    setIndex((i) => i + 1);
    setSelected(null);
    setShowExp(false);
    setTimeLeft(30);
  };

  const q = questions[index];

  if (phase === "select") {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold text-white">
          <Trophy className="inline h-7 w-7 text-yellow-400" /> Quiz Arena
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`rounded-xl border p-4 text-left text-sm cursor-pointer transition-all duration-300 ${
                category === c
                  ? "border-[#E95420] bg-[#E95420]/10 text-[#E95420] hover:scale-105"
                  : "border-white/10 text-gray-400 hover:border-orange-500 hover:shadow-lg hover:shadow-orange-500/20"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <GlassCard>
          <p className="mb-2 text-sm text-gray-400">Difficulty</p>
          <div className="flex gap-2">
            {DIFFICULTIES.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDifficulty(d)}
                className={`rounded-full px-4 py-1 text-sm transition-all duration-300 ${
                  difficulty === d 
                    ? "bg-[#E95420] text-white hover:scale-105" 
                    : "border border-white/10 hover:border-orange-500 hover:text-orange-500"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={start}
            disabled={loading}
            className="mt-6 w-full rounded-lg bg-[#E95420] py-3 font-medium text-white disabled:opacity-50 hover:scale-105 hover:brightness-110 transition-all duration-300"
          >
            {loading ? "Loading..." : "Start Quiz"}
          </button>
        </GlassCard>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <GlassCard className="text-center">
        <Trophy className="mx-auto h-16 w-16 text-yellow-400" />
        <h3 className="mt-4 text-2xl font-bold text-white">
          {score} / {questions.length}
        </h3>
        <p className="mt-2 text-[#4CAF50]">+{xpEarned} XP earned</p>
        <p className="mt-2 text-gray-400">
          {score >= 8 ? "Excellent!" : score >= 5 ? "Good job!" : "Keep practicing!"}
        </p>
        <button
          type="button"
          onClick={() => setPhase("select")}
          className="mt-6 rounded-lg bg-[#E95420] px-6 py-2 text-white"
        >
          Change Category
        </button>
      </GlassCard>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between text-sm text-gray-400">
        <span>
          Question {index + 1}/{questions.length}
        </span>
        <span className="flex items-center gap-1 text-[#E95420]">
          <Clock className="h-4 w-4" /> {timeLeft}s
        </span>
        <span>Score: {score}</span>
      </div>
      <div className="h-2 rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-[#E95420] transition-all"
          style={{ width: `${((index + 1) / questions.length) * 100}%` }}
        />
      </div>
      {q && (
        <GlassCard>
          <p className="text-lg text-white">{q.question}</p>
          <ul className="mt-4 space-y-2">
            {q.options.map((opt, i) => (
              <li key={i}>
                <button
                  type="button"
                  disabled={showExp}
                  onClick={() => answer(i)}
                  className={`w-full rounded-lg border px-4 py-3 text-left text-sm ${
                    showExp && i === q.correct
                      ? "border-[#4CAF50] bg-[#4CAF50]/10"
                      : showExp && i === selected
                        ? "border-red-500/50 bg-red-500/10"
                        : "border-white/10"
                  }`}
                >
                  {String.fromCharCode(65 + i)}. {opt}
                </button>
              </li>
            ))}
          </ul>
          {showExp && (
            <div className="mt-4 rounded-lg bg-[#4CAF50]/10 p-3 text-sm text-[#4CAF50]">
              {q.explanation}
              <button
                type="button"
                onClick={next}
                className="mt-3 block rounded-lg bg-[#E95420] px-4 py-2 text-white"
              >
                {index + 1 >= questions.length ? "See Results" : "Next"}
              </button>
            </div>
          )}
        </GlassCard>
      )}
    </div>
  );
}
