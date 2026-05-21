"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock, Trophy } from "lucide-react";
import { GlassCard } from "@/components/GlassCard";
import { QUIZ_CATEGORIES, QUIZ_DB, type QuizCategory, type QuizDBQuestion } from "@/lib/quizDB";
import type { QuizSummary } from "@/lib/session";

interface QuizArenaProps {
  onAwardXp: (amount: number, message: string) => void;
  onComplete: (summary: QuizSummary) => void;
}

function shuffleQuestions(questions: QuizDBQuestion[]): QuizDBQuestion[] {
  const list = [...questions];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const j = Math.floor(Math.random() * (index + 1));
    [list[index], list[j]] = [list[j], list[index]];
  }
  return list;
}

export function QuizArena({ onAwardXp, onComplete }: QuizArenaProps) {
  const [category, setCategory] = useState<QuizCategory>("File System");
  const [phase, setPhase] = useState<"select" | "quiz" | "done">("select");
  const [questions, setQuestions] = useState<QuizDBQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [showExplanation, setShowExplanation] = useState(false);
  const [timeLeft, setTimeLeft] = useState(30);
  const [correctCount, setCorrectCount] = useState(0);
  const [wrongCount, setWrongCount] = useState(0);
  const [xpEarned, setXpEarned] = useState(0);
  const [, setCorrectStreak] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [timeTakenSec, setTimeTakenSec] = useState(0);

  const currentQuestion = questions[currentIndex];

  useEffect(() => {
    if (phase !== "quiz" || showExplanation) return;
    const timer = setInterval(() => {
      setTimeLeft((previous) => {
        if (previous <= 1) {
          handleAnswer(null);
          return 30;
        }
        return previous - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  });

  const progressPercent = useMemo(
    () => (questions.length ? ((currentIndex + 1) / questions.length) * 100 : 0),
    [currentIndex, questions.length]
  );

  const timerPercent = useMemo(() => (timeLeft / 30) * 100, [timeLeft]);

  function resetQuizState() {
    setQuestions([]);
    setCurrentIndex(0);
    setSelected(null);
    setShowExplanation(false);
    setTimeLeft(30);
    setCorrectCount(0);
    setWrongCount(0);
    setXpEarned(0);
    setCorrectStreak(0);
    setStartedAt(null);
    setTimeTakenSec(0);
  }

  function startQuiz() {
    const selectedSet = shuffleQuestions(QUIZ_DB[category]).slice(0, 10);
    setQuestions(selectedSet);
    setCurrentIndex(0);
    setSelected(null);
    setShowExplanation(false);
    setTimeLeft(30);
    setCorrectCount(0);
    setWrongCount(0);
    setXpEarned(0);
    setCorrectStreak(0);
    setPhase("quiz");
    setStartedAt(Date.now());
  }

  function handleAnswer(index: number | null) {
    if (showExplanation || !currentQuestion) return;
    setSelected(index);
    setShowExplanation(true);

    if (index === currentQuestion.correct) {
      setCorrectCount((previous) => previous + 1);
      setXpEarned((previous) => previous + 20);
      onAwardXp(20, "Correct! +20 XP");

      setCorrectStreak((previous) => {
        const next = previous + 1;
        if (next % 3 === 0) {
          setXpEarned((xp) => xp + 15);
          onAwardXp(15, "3-answer streak! +15 XP");
        }
        return next;
      });
      return;
    }

    setWrongCount((previous) => previous + 1);
    setCorrectStreak(0);
  }

  function finishQuiz() {
    const elapsed = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    setTimeTakenSec(elapsed);

    const summary: QuizSummary = {
      id: Math.random().toString(36).slice(2, 10),
      category,
      correct: correctCount,
      wrong: wrongCount,
      total: questions.length,
      xpEarned,
      timeTakenSec: elapsed,
      scorePercent: questions.length ? Math.round((correctCount / questions.length) * 100) : 0,
      createdAt: new Date().toISOString(),
    };
    onComplete(summary);
    setPhase("done");
  }

  function nextQuestion() {
    if (currentIndex + 1 >= questions.length) {
      finishQuiz();
      return;
    }
    setCurrentIndex((previous) => previous + 1);
    setSelected(null);
    setShowExplanation(false);
    setTimeLeft(30);
  }

  if (phase === "select") {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold text-white">
          <Trophy className="mr-2 inline h-6 w-6 text-yellow-400" />
          Quiz Arena
        </h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {QUIZ_CATEGORIES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setCategory(item)}
              className={`micro-button rounded-xl border p-4 text-left transition ${
                category === item
                  ? "border-[#E95420]/60 bg-[#E95420]/15 text-[#E95420]"
                  : "border-white/10 bg-black/20 text-gray-300 hover:border-[#E95420]/35"
              }`}
            >
              <p className="font-semibold">{item}</p>
              <p className="mt-1 text-xs text-gray-400">10 questions • 30 sec each</p>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={startQuiz}
          className="micro-button rounded-lg bg-[#E95420] px-6 py-2.5 font-medium text-white transition hover:bg-[#ff6b36]"
        >
          Start Quiz
        </button>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <GlassCard className="space-y-5">
        <h3 className="text-2xl font-bold text-white">Quiz Summary</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 bg-black/30 p-4">
            <p className="text-sm text-gray-400">Score</p>
            <p className="text-2xl font-bold text-white">
              {correctCount}/{questions.length}
            </p>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/30 p-4">
            <p className="text-sm text-gray-400">XP Earned</p>
            <p className="text-2xl font-bold text-emerald-300">+{xpEarned}</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/30 p-4">
            <p className="text-sm text-gray-400">Time Taken</p>
            <p className="text-xl font-semibold text-white">{timeTakenSec}s</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/30 p-4">
            <p className="text-sm text-gray-400">Breakdown</p>
            <p className="text-sm text-emerald-300">Correct: {correctCount}</p>
            <p className="text-sm text-rose-300">Wrong: {wrongCount}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            resetQuizState();
            setPhase("select");
          }}
          className="micro-button rounded-lg bg-[#E95420] px-5 py-2 text-white"
        >
          Start Another Category
        </button>
      </GlassCard>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-300">
        <p>
          {category} • Question {currentIndex + 1}/{questions.length}
        </p>
        <p className="flex items-center gap-1 text-orange-300">
          <Clock className="h-4 w-4" />
          {timeLeft}s
        </p>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-[#E95420] transition-all duration-300"
          style={{ width: `${timerPercent}%` }}
        />
      </div>

      <div className="h-1 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-emerald-400/80 transition-all duration-300"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {currentQuestion && (
        <GlassCard className="space-y-4">
          <p className="text-lg text-white">{currentQuestion.question}</p>

          <div className="space-y-2">
            {currentQuestion.options.map((option, index) => {
              const isCorrect = showExplanation && index === currentQuestion.correct;
              const isWrongSelection = showExplanation && selected === index && !isCorrect;
              return (
                <button
                  key={`${option}-${index}`}
                  type="button"
                  disabled={showExplanation}
                  onClick={() => handleAnswer(index)}
                  className={`micro-button w-full rounded-lg border px-4 py-3 text-left text-sm transition ${
                    isCorrect
                      ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-200"
                      : isWrongSelection
                        ? "border-rose-500/60 bg-rose-500/15 text-rose-100"
                        : "border-white/10 bg-black/20 text-gray-200 hover:border-[#E95420]/35"
                  }`}
                >
                  <span className="font-mono text-xs text-gray-500">{String.fromCharCode(65 + index)}.</span>{" "}
                  {option}
                </button>
              );
            })}
          </div>

          {showExplanation && (
            <div className="space-y-3 rounded-lg border border-white/10 bg-black/25 p-3 text-sm">
              <p className="text-gray-300">{currentQuestion.explanation}</p>
              <button
                type="button"
                onClick={nextQuestion}
                className="micro-button rounded-md bg-[#E95420] px-4 py-2 text-white"
              >
                {currentIndex + 1 >= questions.length ? "View Summary" : "Next Question"}
              </button>
            </div>
          )}
        </GlassCard>
      )}
    </div>
  );
}
