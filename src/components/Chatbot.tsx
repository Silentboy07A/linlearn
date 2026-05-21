"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  Trash2,
  Copy,
  Check,
  Terminal,
  AlertTriangle,
  ChevronRight,
  Lightbulb,
  BookOpen,
  Link2,
  History,
  X,
  Plus,
  Zap,
  FolderOpen,
  Wifi,
  Shield,
  Package,
  Code2,
  Hash,
  ChevronDown,
} from "lucide-react";
import type { ChatMessage } from "@/types";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ParsedBlock {
  type: "text" | "code";
  content: string;
  language?: string;
}

interface ExplanationPanel {
  command?: string;
  syntax?: string;
  example?: string;
  danger?: string;
  mistakes?: string[];
  related?: string[];
  level?: "Beginner" | "Intermediate" | "Advanced";
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: Date;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = [
  { id: "filesystem", label: "File System", icon: FolderOpen, color: "#4CAF50" },
  { id: "networking", label: "Networking", icon: Wifi, color: "#2196F3" },
  { id: "permissions", label: "Permissions", icon: Shield, color: "#FF9800" },
  { id: "packages", label: "Packages", icon: Package, color: "#9C27B0" },
  { id: "scripting", label: "Shell Script", icon: Code2, color: "#E95420" },
];

const SUGGESTIONS: Record<string, string[]> = {
  filesystem: ["List files recursively", "Find files by name", "Check disk usage", "Move files safely"],
  networking: ["Check open ports", "Test connectivity", "View network interfaces", "Monitor bandwidth"],
  permissions: ["Change file permissions", "Set directory ownership", "SUID/SGID explained", "umask usage"],
  packages: ["Update all packages", "Install without prompt", "Remove unused packages", "Search packages"],
  scripting: ["Loop through files", "Parse command output", "Schedule with cron", "Error handling in bash"],
};

const WELCOME_MSG: ChatMessage = {
  role: "assistant",
  content: `Welcome to **LinLearn AI** — your personal Linux tutor! 🐧

I can help you with:
- \`Linux commands\` and their usage
- **File system** navigation and management
- **Networking**, **permissions**, **package management**
- Shell scripting and automation
- Docker, Git, and DevOps tools

💡 *Try clicking a category below or just ask me anything!*`,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseContent(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const codeRegex = /```(\w+)?\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: "text", content: content.slice(lastIndex, match.index) });
    }
    blocks.push({ type: "code", content: match[2].trim(), language: match[1] || "bash" });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    blocks.push({ type: "text", content: content.slice(lastIndex) });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", content }];
}

function renderText(text: string): React.ReactNode[] {
  // Bold: **text**, inline code: `code`
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="text-white font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="px-1.5 py-0.5 rounded text-[#4CAF50] bg-[#4CAF50]/10 font-mono text-xs border border-[#4CAF50]/20">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function extractExplanation(content: string): ExplanationPanel {
  const panel: ExplanationPanel = {};

  // Try to detect command, syntax, danger
  const lines = content.split("\n");
  const codeMatches = content.match(/```[\w]*\n?([\s\S]*?)```/g);

  if (codeMatches && codeMatches.length > 0) {
    const firstCode = codeMatches[0].replace(/```[\w]*\n?/g, "").replace(/```/g, "").trim();
    panel.command = firstCode.split("\n")[0];
    panel.syntax = firstCode;
    if (codeMatches[1]) {
      panel.example = codeMatches[1].replace(/```[\w]*\n?/g, "").replace(/```/g, "").trim();
    }
  }

  // Detect danger keywords
  const dangerKeywords = ["rm -rf", "chmod 777", ":(){ :|:& };:", "dd if=", "mkfs", "> /dev/sda", "sudo rm"];
  const foundDanger = dangerKeywords.find((kw) => content.includes(kw));
  if (foundDanger) {
    panel.danger = `This command contains \`${foundDanger}\` which can be destructive. Use with caution!`;
  }

  // Extract bullet points as mistakes or tips
  const bulletLines = lines.filter((l) => l.trim().startsWith("-") || l.trim().startsWith("•"));
  if (bulletLines.length > 0) {
    panel.mistakes = bulletLines.slice(0, 3).map((l) => l.replace(/^[-•]\s*/, "").trim());
  }

  // Skill level heuristic
  const advancedTerms = ["awk", "sed", "grep -P", "xargs", "strace", "tcpdump", "iptables"];
  const intermediateTerms = ["chmod", "chown", "cron", "systemctl", "find", "tar", "ssh"];
  if (advancedTerms.some((t) => content.includes(t))) panel.level = "Advanced";
  else if (intermediateTerms.some((t) => content.includes(t))) panel.level = "Intermediate";
  else panel.level = "Beginner";

  // Related commands extraction (common patterns)
  const relatedMap: Record<string, string[]> = {
    ls: ["tree", "find", "du", "stat"],
    chmod: ["chown", "umask", "stat", "ls -la"],
    grep: ["awk", "sed", "cut", "sort"],
    ps: ["top", "htop", "kill", "pgrep"],
    ssh: ["scp", "rsync", "sftp", "ssh-keygen"],
    apt: ["dpkg", "snap", "pip", "npm"],
    git: ["gh", "hub", "diff", "log"],
    docker: ["podman", "kubectl", "docker-compose", "skopeo"],
  };

  for (const [cmd, related] of Object.entries(relatedMap)) {
    if (content.toLowerCase().includes(cmd)) {
      panel.related = related;
      break;
    }
  }

  return panel;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <button
      onClick={copy}
      className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      title="Copy"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? "Copied!" : "Copy"}</span>
    </button>
  );
}

function CodeBlock({ content, language }: { content: string; language: string }) {
  return (
    <div className="my-2 rounded-lg overflow-hidden border border-[#4CAF50]/20">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#0d1a0f] border-b border-[#4CAF50]/10">
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <div className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
            <div className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
            <div className="h-2.5 w-2.5 rounded-full bg-green-500/70" />
          </div>
          <span className="text-[10px] font-mono text-gray-500 uppercase">{language}</span>
        </div>
        <CopyBtn text={content} />
      </div>
      <pre className="px-4 py-3 bg-[#0a1208] overflow-x-auto text-xs">
        <code className="text-[#4CAF50] font-mono leading-relaxed">{content}</code>
      </pre>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#4CAF50]/20 shrink-0">
        <Terminal className="h-3.5 w-3.5 text-[#4CAF50]" />
      </div>
      <div className="flex items-center gap-1.5 rounded-lg border border-[#4CAF50]/15 bg-black/30 px-3 py-2.5">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-[#4CAF50]"
            animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.1, 0.8] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
          />
        ))}
        <span className="ml-1 text-xs text-gray-500 font-mono">LinLearn AI is thinking…</span>
      </div>
    </div>
  );
}

function MessageBubble({ message, index }: { message: ChatMessage; index: number }) {
  const isUser = message.role === "user";
  const blocks = parseContent(message.content);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.25, delay: index * 0.03 }}
      className={`mb-4 ${isUser ? "flex justify-end" : "flex justify-start"}`}
    >
      {!isUser && (
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#4CAF50]/20 mr-2.5 mt-0.5 shrink-0">
          <Terminal className="h-3.5 w-3.5 text-[#4CAF50]" />
        </div>
      )}

      <div className={`max-w-[82%] ${isUser ? "" : "flex-1"}`}>
        {isUser ? (
          <div className="inline-block rounded-xl rounded-tr-sm bg-gradient-to-br from-[#E95420]/30 to-[#E95420]/15 px-4 py-2.5 border border-[#E95420]/20">
            <div className="flex items-center gap-1.5 mb-1">
              <Hash className="h-3 w-3 text-[#E95420]/70" />
              <span className="text-[10px] font-mono text-[#E95420]/70">you@linlearn:~$</span>
            </div>
            <p className="text-sm text-white">{message.content}</p>
          </div>
        ) : (
          <div className="rounded-xl rounded-tl-sm border border-white/8 bg-[#0d1017]/70 px-4 py-3">
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-[10px] font-mono text-[#4CAF50]/60">ai@linlearn:~$</span>
            </div>
            <div className="space-y-1 text-sm text-gray-300 leading-relaxed">
              {blocks.map((block, bi) =>
                block.type === "code" ? (
                  <CodeBlock key={bi} content={block.content} language={block.language || "bash"} />
                ) : (
                  <div key={bi}>
                    {block.content.split("\n").map((line, li) => {
                      const trimmed = line.trim();
                      if (trimmed.startsWith("- ") || trimmed.startsWith("• ")) {
                        return (
                          <div key={li} className="flex items-start gap-2 py-0.5">
                            <ChevronRight className="h-3 w-3 text-[#4CAF50] mt-1 shrink-0" />
                            <span>{renderText(trimmed.replace(/^[-•]\s*/, ""))}</span>
                          </div>
                        );
                      }
                      if (trimmed === "") return <div key={li} className="h-1.5" />;
                      return <p key={li}>{renderText(line)}</p>;
                    })}
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>

      {isUser && (
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#E95420]/20 ml-2.5 mt-0.5 shrink-0">
          <span className="text-xs font-bold text-[#E95420]">U</span>
        </div>
      )}
    </motion.div>
  );
}

function ExplanationPanelView({ panel }: { panel: ExplanationPanel | null }) {
  if (!panel || !panel.command) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <div className="h-16 w-16 rounded-full bg-[#4CAF50]/10 flex items-center justify-center mb-4">
          <BookOpen className="h-8 w-8 text-[#4CAF50]/40" />
        </div>
        <h3 className="text-sm font-medium text-gray-400">Linux Explanation Panel</h3>
        <p className="text-xs text-gray-600 mt-2 leading-relaxed">
          Ask about a Linux command and I&apos;ll show a detailed breakdown here with syntax, examples, and tips.
        </p>
      </div>
    );
  }

  const levelColors = {
    Beginner: { bg: "bg-green-500/15", text: "text-green-400", border: "border-green-500/30" },
    Intermediate: { bg: "bg-blue-500/15", text: "text-blue-400", border: "border-blue-500/30" },
    Advanced: { bg: "bg-purple-500/15", text: "text-purple-400", border: "border-purple-500/30" },
  };
  const lc = panel.level ? levelColors[panel.level] : levelColors.Beginner;

  return (
    <div className="space-y-3 overflow-y-auto h-full pr-1">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Command Breakdown</h3>
        {panel.level && (
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${lc.bg} ${lc.text} ${lc.border}`}>
            {panel.level}
          </span>
        )}
      </div>

      {/* Danger Alert */}
      {panel.danger && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3"
        >
          <AlertTriangle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
          <p className="text-xs text-red-300 leading-relaxed">{panel.danger}</p>
        </motion.div>
      )}

      {/* Syntax */}
      {panel.syntax && (
        <div className="rounded-lg border border-[#4CAF50]/20 overflow-hidden">
          <div className="px-3 py-1.5 bg-[#0d1a0f] flex items-center gap-2 border-b border-[#4CAF50]/10">
            <Terminal className="h-3 w-3 text-[#4CAF50]/60" />
            <span className="text-[10px] text-gray-500 font-mono uppercase">Syntax</span>
          </div>
          <pre className="px-3 py-2.5 bg-[#0a1208] text-xs text-[#4CAF50] font-mono overflow-x-auto whitespace-pre-wrap break-all">
            {panel.syntax}
          </pre>
        </div>
      )}

      {/* Example */}
      {panel.example && (
        <div className="rounded-lg border border-blue-500/20 overflow-hidden">
          <div className="px-3 py-1.5 bg-blue-950/30 flex items-center gap-2 border-b border-blue-500/10">
            <Zap className="h-3 w-3 text-blue-400/60" />
            <span className="text-[10px] text-gray-500 font-mono uppercase">Example</span>
          </div>
          <pre className="px-3 py-2.5 bg-blue-950/10 text-xs text-blue-300 font-mono overflow-x-auto whitespace-pre-wrap break-all">
            {panel.example}
          </pre>
        </div>
      )}

      {/* Common Mistakes */}
      {panel.mistakes && panel.mistakes.length > 0 && (
        <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Lightbulb className="h-3.5 w-3.5 text-orange-400" />
            <span className="text-[10px] font-semibold text-orange-400 uppercase tracking-wider">Tips & Notes</span>
          </div>
          <ul className="space-y-1.5">
            {panel.mistakes.map((m, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-gray-400">
                <span className="text-orange-400 mt-0.5 shrink-0">›</span>
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Related Commands */}
      {panel.related && panel.related.length > 0 && (
        <div className="rounded-lg border border-white/8 bg-white/3 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Link2 className="h-3.5 w-3.5 text-gray-400" />
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Related Commands</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {panel.related.map((cmd) => (
              <span
                key={cmd}
                className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-[#4CAF50]/10 text-[#4CAF50] border border-[#4CAF50]/20"
              >
                {cmd}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Chatbot Component ───────────────────────────────────────────────────

export function Chatbot({ onSuccess }: { onSuccess?: () => void }) {
  const [sessions, setSessions] = useState<ChatSession[]>([
    { id: "1", title: "New Chat", messages: [WELCOME_MSG], createdAt: new Date() },
  ]);
  const [activeSessionId, setActiveSessionId] = useState("1");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [explanationPanel, setExplanationPanel] = useState<ExplanationPanel | null>(null);
  const [showExplainPanel, setShowExplainPanel] = useState(true);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId)!;
  const messages = activeSession?.messages ?? [WELCOME_MSG];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const updateSession = useCallback(
    (id: string, updater: (s: ChatSession) => ChatSession) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? updater(s) : s)));
    },
    []
  );

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    const nextMessages = [...messages, userMsg];

    updateSession(activeSessionId, (s) => ({
      ...s,
      messages: nextMessages,
      title: s.messages.length === 1 ? text.slice(0, 32) + (text.length > 32 ? "…" : "") : s.title,
    }));
    setInput("");
    setLoading(true);

    if (textareaRef.current) textareaRef.current.style.height = "44px";

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const aiMsg: ChatMessage = { role: "assistant", content: data.reply };
      updateSession(activeSessionId, (s) => ({
        ...s,
        messages: [...nextMessages, aiMsg],
      }));

      // Update explanation panel
      const parsed = extractExplanation(data.reply);
      setExplanationPanel(parsed);

      onSuccess?.();
    } catch {
      const errMsg: ChatMessage = {
        role: "assistant",
        content: "Sorry, I couldn't respond. Please check your API key or try again.",
      };
      updateSession(activeSessionId, (s) => ({
        ...s,
        messages: [...nextMessages, errMsg],
      }));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const autoResize = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "44px";
    e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
  };

  const newChat = () => {
    const id = Date.now().toString();
    const session: ChatSession = {
      id,
      title: "New Chat",
      messages: [WELCOME_MSG],
      createdAt: new Date(),
    };
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(id);
    setExplanationPanel(null);
    setShowHistory(false);
  };

  const clearCurrentChat = () => {
    updateSession(activeSessionId, (s) => ({
      ...s,
      messages: [WELCOME_MSG],
      title: "New Chat",
    }));
    setExplanationPanel(null);
  };

  const suggestions = activeCategory ? SUGGESTIONS[activeCategory] : [];

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col lg:flex-row gap-0 rounded-xl overflow-hidden border border-white/8 bg-[#0c0f14]">
      {/* ── History Sidebar ── */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-30 bg-black/50 lg:hidden"
              onClick={() => setShowHistory(false)}
            />
            <motion.div
              initial={{ x: -280, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -280, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="fixed left-0 top-0 z-40 h-full w-72 bg-[#0c0f14] border-r border-white/8 p-4 lg:relative lg:z-auto lg:h-auto lg:w-56 lg:shrink-0 overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Chat History</span>
                <button onClick={() => setShowHistory(false)} className="text-gray-500 hover:text-gray-300 lg:hidden">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <button
                onClick={newChat}
                className="flex w-full items-center gap-2 rounded-lg border border-[#4CAF50]/30 bg-[#4CAF50]/10 px-3 py-2.5 text-sm text-[#4CAF50] hover:bg-[#4CAF50]/15 transition-colors mb-3"
              >
                <Plus className="h-4 w-4" />
                New Chat
              </button>

              <div className="space-y-1">
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => {
                      setActiveSessionId(session.id);
                      setShowHistory(false);
                    }}
                    className={`flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                      session.id === activeSessionId
                        ? "bg-[#E95420]/15 text-[#E95420] border border-[#E95420]/20"
                        : "text-gray-400 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    <History className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span className="truncate">{session.title}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── Left: Chat Panel ── */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Chat Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8 bg-[#0e1117]/80 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-gray-400 hover:bg-white/5 hover:text-white transition-colors"
            >
              <History className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">History</span>
            </button>
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                <div className="h-2 w-2 rounded-full bg-red-500" />
                <div className="h-2 w-2 rounded-full bg-yellow-500" />
                <div className="h-2 w-2 rounded-full bg-green-500" />
              </div>
              <span className="text-xs font-mono text-gray-500">linlearn-ai — bash</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowExplainPanel(!showExplainPanel)}
              className="hidden lg:flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-gray-400 hover:bg-white/5 hover:text-white transition-colors"
            >
              <BookOpen className="h-3.5 w-3.5" />
              <span>{showExplainPanel ? "Hide" : "Show"} Panel</span>
              <ChevronDown className={`h-3 w-3 transition-transform ${showExplainPanel ? "" : "-rotate-90"}`} />
            </button>
            <button
              onClick={clearCurrentChat}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-gray-400 hover:bg-white/5 hover:text-red-400 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Clear</span>
            </button>
          </div>
        </div>

        {/* Category Filter Bar */}
        <div className="flex gap-2 px-4 py-2.5 border-b border-white/5 bg-[#0c0f14] overflow-x-auto no-scrollbar">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const active = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(active ? null : cat.id)}
                style={active ? { borderColor: cat.color + "50", backgroundColor: cat.color + "18", color: cat.color } : {}}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all border ${
                  active ? "" : "border-white/8 text-gray-500 hover:text-gray-300 hover:border-white/15"
                }`}
              >
                <Icon className="h-3 w-3" />
                {cat.label}
              </button>
            );
          })}
        </div>

        {/* Suggestions strip */}
        <AnimatePresence>
          {suggestions.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="flex gap-2 px-4 py-2 border-b border-white/5 bg-[#0b0e13] overflow-x-auto no-scrollbar"
            >
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-white/8 bg-white/3 px-3 py-1 text-[11px] text-gray-400 hover:text-white hover:bg-white/8 hover:border-white/15 transition-all"
                >
                  <Zap className="h-3 w-3 text-yellow-500/60" />
                  {s}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1 scroll-smooth">
          {messages.map((m, i) => (
            <MessageBubble key={`${activeSessionId}-${i}`} message={m} index={i} />
          ))}
          {loading && <TypingIndicator />}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-white/8 px-4 py-3 bg-[#0e1117]/80 backdrop-blur-sm">
          <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2 focus-within:border-[#4CAF50]/40 focus-within:ring-1 focus-within:ring-[#4CAF50]/10 transition-all">
            <span className="text-[#4CAF50]/50 font-mono text-xs mb-2.5 shrink-0">$</span>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={autoResize}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder="Ask about any Linux command… (Enter to send, Shift+Enter for new line)"
              className="flex-1 resize-none bg-transparent text-sm text-white placeholder-gray-600 outline-none font-mono leading-relaxed"
              style={{ minHeight: "44px", maxHeight: "140px" }}
            />
            <button
              type="button"
              onClick={() => send()}
              disabled={loading || !input.trim()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#4CAF50]/20 text-[#4CAF50] hover:bg-[#4CAF50]/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all mb-1"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-1.5 text-center text-[10px] text-gray-600">
            <kbd className="px-1 py-0.5 rounded border border-white/10 text-[10px]">Enter</kbd> send ·{" "}
            <kbd className="px-1 py-0.5 rounded border border-white/10 text-[10px]">Shift+Enter</kbd> newline · Commands are educational only
          </p>
        </div>
      </div>

      {/* ── Right: Explanation Panel ── */}
      <AnimatePresence>
        {showExplainPanel && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: "auto", opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 35 }}
            className="hidden lg:flex lg:w-72 xl:w-80 shrink-0 flex-col border-l border-white/8 bg-[#0b0e13]"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-[#4CAF50]/60" />
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Explanation</span>
              </div>
              <button
                onClick={() => setShowExplainPanel(false)}
                className="text-gray-600 hover:text-gray-400 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden px-4 py-4">
              <ExplanationPanelView panel={explanationPanel} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}