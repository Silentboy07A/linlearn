import Link from "next/link";
import { Terminal, Sparkles, Trophy, MessageSquare } from "lucide-react";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[#1a0a2e] text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-6 py-4">
        <div className="flex items-center gap-2">
          <Terminal className="h-7 w-7 text-[#E95420]" />
          <span className="text-xl font-bold text-[#E95420]">LinLearn</span>
        </div>
        <div className="flex gap-3">
          <Link
            href="/auth/login"
            className="rounded-lg border border-white/10 px-4 py-2 text-sm hover:bg-white/5"
          >
            Sign In
          </Link>
          <Link
            href="/auth/signup"
            className="rounded-lg bg-[#E95420] px-4 py-2 text-sm font-medium text-white"
          >
            Get Started
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-20 text-center">
        <h1 className="text-4xl font-bold md:text-5xl">
          Learn Linux & DevOps with{" "}
          <span className="gradient-text">AI</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-gray-400">
          Ubuntu-themed learning platform. Generate commands, write scripts, take quizzes,
          mock interviews, and more — powered by Llama AI.
        </p>
        <Link
          href="/auth/signup"
          className="mt-10 inline-block rounded-lg bg-[#E95420] px-8 py-3 font-medium text-white shadow-lg shadow-[#E95420]/30"
        >
          Start Learning Free
        </Link>

        <div className="mt-20 grid gap-6 sm:grid-cols-3">
          {[
            { icon: Sparkles, title: "AI Commands", desc: "Natural language to Linux commands" },
            { icon: MessageSquare, title: "Linux Tutor", desc: "Chat with DevOps AI assistant" },
            { icon: Trophy, title: "Quiz & XP", desc: "Gamified learning with streaks" },
          ].map(({ icon: Icon, title, desc }) => (
            <div
              key={title}
              className="rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur"
            >
              <Icon className="mx-auto h-8 w-8 text-[#E95420]" />
              <h3 className="mt-3 font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-gray-500">{desc}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="border-t border-white/10 py-6 text-center text-sm text-gray-500">
        LinLearn — commands are simulated for education only
      </footer>
    </div>
  );
}
