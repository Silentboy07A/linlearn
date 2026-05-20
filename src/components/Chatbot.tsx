"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Trash2 } from "lucide-react";
import { GlassCard } from "./GlassCard";
import type { ChatMessage } from "@/types";

export function Chatbot({ onSuccess }: { onSuccess?: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: "Hello! I'm LinLearn AI. Ask me anything about Linux, Docker, Git, or DevOps.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMessages([...next, { role: "assistant", content: data.reply }]);
      onSuccess?.();
    } catch {
      setMessages([
        ...next,
        { role: "assistant", content: "Sorry, I couldn't respond. Check your API key." },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-10rem)] flex-col space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">
          Linux <span className="text-[#4CAF50]">AI Chatbot</span>
        </h2>
        <button
          type="button"
          onClick={() =>
            setMessages([
              {
                role: "assistant",
                content: "Chat cleared. What would you like to learn?",
              },
            ])
          }
          className="flex items-center gap-1 text-sm text-gray-400 hover:text-white"
        >
          <Trash2 className="h-4 w-4" /> Clear
        </button>
      </div>
      <GlassCard className="flex flex-1 flex-col overflow-hidden p-0">
        <div className="flex-1 overflow-y-auto p-4 font-mono text-sm">
          {messages.map((m, i) => (
            <div key={i} className={`mb-4 ${m.role === "user" ? "text-right" : ""}`}>
              {m.role === "user" ? (
                <div className="inline-block max-w-[85%] rounded-lg bg-[#E95420]/20 px-3 py-2 text-left text-white">
                  you@linlearn:~$ {m.content}
                </div>
              ) : (
                <div className="max-w-[90%] rounded-lg border border-[#4CAF50]/20 bg-black/30 px-3 py-2 text-[#4CAF50]">
                  <span className="text-xs text-gray-500">ai@linlearn:~$</span>
                  <p className="mt-1 whitespace-pre-wrap font-sans text-gray-300">{m.content}</p>
                </div>
              )}
            </div>
          ))}
          {loading && (
            <p className="text-[#4CAF50]">
              ai@linlearn:~$ <span className="animate-pulse">...</span>
            </p>
          )}
          <div ref={bottomRef} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex gap-2 border-t border-white/10 p-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white"
            placeholder="Ask about Linux..."
          />
          <button type="submit" disabled={loading} className="rounded-lg bg-[#4CAF50]/20 p-2 text-[#4CAF50]">
            <Send className="h-5 w-5" />
          </button>
        </form>
      </GlassCard>
    </div>
  );
}