"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CommandSource } from "@/lib/commandDB";
import { sourceTag, type SessionCommand, type TerminalPrefs } from "@/lib/session";
import { getHfHeaders } from "@/lib/utils";

interface DirNode {
  type: "dir";
  children: Record<string, FsNode>;
}

interface FileNode {
  type: "file";
  content: string;
}

type FsNode = DirNode | FileNode;

interface TerminalEntry {
  id: string;
  command: string;
  output: string;
  source: CommandSource;
  cwd: string;
}

interface TerminalSimulatorProps {
  prefs: TerminalPrefs;
  clearSignal: number;
  onCommandLogged: (item: SessionCommand) => void;
  onDbFallback: () => void;
}

const LOCAL_BASE_COMMANDS = new Set([
  "ls",
  "cd",
  "pwd",
  "mkdir",
  "touch",
  "rm",
  "cat",
  "echo",
  "whoami",
  "date",
  "clear",
  "history",
  "help",
]);

const fontClassMap = {
  small: "text-xs",
  medium: "text-sm",
  large: "text-base",
} satisfies Record<TerminalPrefs["fontSize"], string>;

const terminalThemeMap = {
  green: {
    prompt: "text-green-300",
    path: "text-emerald-400",
    command: "text-white",
    output: "text-gray-200",
  },
  amber: {
    prompt: "text-amber-300",
    path: "text-orange-300",
    command: "text-white",
    output: "text-gray-200",
  },
  cyan: {
    prompt: "text-cyan-300",
    path: "text-sky-300",
    command: "text-white",
    output: "text-gray-200",
  },
  white: {
    prompt: "text-gray-200",
    path: "text-gray-100",
    command: "text-white",
    output: "text-gray-200",
  },
} satisfies Record<TerminalPrefs["theme"], Record<"prompt" | "path" | "command" | "output", string>>;

function initialFs(): DirNode {
  return {
    type: "dir",
    children: {
      home: {
        type: "dir",
        children: {
          user: {
            type: "dir",
            children: {
              Documents: { type: "dir", children: {} },
              Projects: { type: "dir", children: {} },
              "notes.txt": { type: "file", content: "Welcome to LinLearn Terminal Simulator." },
            },
          },
        },
      },
    },
  };
}

function cloneFs<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

function normalizePath(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized;
}

function resolvePath(cwd: string, rawPath: string): string {
  if (!rawPath || rawPath === "~") return "/home/user";
  if (rawPath.startsWith("/")) {
    const parts = normalizePath(rawPath);
    return `/${parts.join("/")}`.replace(/\/+$/, "") || "/";
  }
  if (rawPath === ".") return cwd;
  const current = cwd === "/" ? "" : cwd;
  const parts = normalizePath(`${current}/${rawPath}`);
  return `/${parts.join("/")}`.replace(/\/+$/, "") || "/";
}

function getNode(root: DirNode, path: string): FsNode | null {
  const parts = normalizePath(path);
  let pointer: FsNode = root;
  for (const part of parts) {
    if (pointer.type !== "dir") return null;
    const next: FsNode | undefined = pointer.children[part];
    if (!next) return null;
    pointer = next;
  }
  return pointer;
}

function setNode(root: DirNode, path: string, node: FsNode): DirNode {
  const draft = cloneFs(root);
  const parts = normalizePath(path);
  if (parts.length === 0) return draft;

  let pointer: FsNode = draft;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i];
    if (pointer.type !== "dir") return draft;
    if (!pointer.children[segment]) {
      pointer.children[segment] = { type: "dir", children: {} };
    }
    pointer = pointer.children[segment];
  }

  if (pointer.type === "dir") {
    pointer.children[parts[parts.length - 1]] = node;
  }
  return draft;
}

function deleteNode(root: DirNode, path: string): DirNode {
  const draft = cloneFs(root);
  const parts = normalizePath(path);
  if (parts.length === 0) return draft;

  let pointer: FsNode = draft;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i];
    if (pointer.type !== "dir") return draft;
    const next: FsNode | undefined = pointer.children[segment];
    if (!next) return draft;
    pointer = next;
  }

  if (pointer.type === "dir") {
    delete pointer.children[parts[parts.length - 1]];
  }
  return draft;
}

function promptPath(cwd: string): string {
  return cwd.startsWith("/home/user") ? cwd.replace("/home/user", "~") || "~" : cwd;
}

function nextId() {
  return Math.random().toString(36).slice(2, 10);
}

export function TerminalSimulator({
  prefs,
  clearSignal,
  onCommandLogged,
  onDbFallback,
}: TerminalSimulatorProps) {
  const [filesystem, setFilesystem] = useState<DirNode>(initialFs);
  const [cwd, setCwd] = useState("/home/user");
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const theme = terminalThemeMap[prefs.theme];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, loading]);

  useEffect(() => {
    if (clearSignal === 0) return;
    setEntries([]);
  }, [clearSignal]);

  const availableCommands = useMemo(
    () => [
      ...Array.from(LOCAL_BASE_COMMANDS),
      "uname -a",
      "Ctrl+L clears terminal",
      "Ctrl+K opens command search",
      "Ctrl+B opens bookmarks",
    ],
    []
  );

  function pushEntry(command: string, output: string, source: CommandSource, entryCwd: string) {
    const item: TerminalEntry = {
      id: nextId(),
      command,
      output,
      source,
      cwd: entryCwd,
    };
    setEntries((previous) => [...previous, item]);
    onCommandLogged({
      id: item.id,
      input: command,
      output,
      source,
      createdAt: new Date().toISOString(),
    });
  }

  function executeLocal(commandLine: string): { handled: boolean; output: string; source: CommandSource } {
    if (commandLine === "uname -a") {
      return {
        handled: true,
        output: "Linux linlearn 5.15.0-ubuntu #1 SMP x86_64 GNU/Linux",
        source: "local",
      };
    }

    const [baseCommand, ...args] = commandLine.split(/\s+/);
    if (!LOCAL_BASE_COMMANDS.has(baseCommand)) {
      return { handled: false, output: "", source: "local" };
    }

    if (baseCommand === "clear") {
      setEntries([]);
      return { handled: true, output: "", source: "local" };
    }

    if (baseCommand === "help") {
      return { handled: true, output: availableCommands.join("\n"), source: "local" };
    }

    if (baseCommand === "history") {
      const output = commandHistory.map((value, index) => `${index + 1}  ${value}`).join("\n");
      return { handled: true, output, source: "local" };
    }

    if (baseCommand === "pwd") {
      return { handled: true, output: cwd, source: "local" };
    }

    if (baseCommand === "whoami") {
      return { handled: true, output: "user", source: "local" };
    }

    if (baseCommand === "date") {
      return { handled: true, output: new Date().toString(), source: "local" };
    }

    if (baseCommand === "echo") {
      return { handled: true, output: args.join(" "), source: "local" };
    }

    if (baseCommand === "ls") {
      const target = args[0] ? resolvePath(cwd, args[0]) : cwd;
      const node = getNode(filesystem, target);
      if (!node) {
        return {
          handled: true,
          output: `ls: cannot access '${args[0]}': No such file or directory`,
          source: "local",
        };
      }
      if (node.type !== "dir") {
        return { handled: true, output: args[0], source: "local" };
      }
      return { handled: true, output: Object.keys(node.children).join("  "), source: "local" };
    }

    if (baseCommand === "cd") {
      const target = resolvePath(cwd, args[0] || "~");
      const node = getNode(filesystem, target);
      if (!node || node.type !== "dir") {
        return {
          handled: true,
          output: `bash: cd: ${args[0] || "~"}: No such file or directory`,
          source: "local",
        };
      }
      setCwd(target);
      return { handled: true, output: "", source: "local" };
    }

    if (baseCommand === "mkdir") {
      const name = args[0];
      if (!name) {
        return { handled: true, output: "mkdir: missing operand", source: "local" };
      }
      const target = resolvePath(cwd, name);
      if (getNode(filesystem, target)) {
        return {
          handled: true,
          output: `mkdir: cannot create directory '${name}': File exists`,
          source: "local",
        };
      }
      setFilesystem((previous) => setNode(previous, target, { type: "dir", children: {} }));
      return { handled: true, output: "", source: "local" };
    }

    if (baseCommand === "touch") {
      const name = args[0];
      if (!name) {
        return { handled: true, output: "touch: missing file operand", source: "local" };
      }
      const target = resolvePath(cwd, name);
      setFilesystem((previous) => {
        const existing = getNode(previous, target);
        if (existing && existing.type === "file") {
          return previous;
        }
        return setNode(previous, target, { type: "file", content: "" });
      });
      return { handled: true, output: "", source: "local" };
    }

    if (baseCommand === "rm") {
      const name = args[0];
      if (!name) {
        return { handled: true, output: "rm: missing operand", source: "local" };
      }
      const target = resolvePath(cwd, name);
      const existing = getNode(filesystem, target);
      if (!existing) {
        return {
          handled: true,
          output: `rm: cannot remove '${name}': No such file or directory`,
          source: "local",
        };
      }
      setFilesystem((previous) => deleteNode(previous, target));
      return { handled: true, output: "", source: "local" };
    }

    if (baseCommand === "cat") {
      const name = args[0];
      if (!name) {
        return { handled: true, output: "cat: missing file operand", source: "local" };
      }
      const target = resolvePath(cwd, name);
      const node = getNode(filesystem, target);
      if (!node) {
        return {
          handled: true,
          output: `cat: ${name}: No such file or directory`,
          source: "local",
        };
      }
      if (node.type === "dir") {
        return {
          handled: true,
          output: `cat: ${name}: Is a directory`,
          source: "local",
        };
      }
      return { handled: true, output: node.content, source: "local" };
    }

    return { handled: false, output: "", source: "local" };
  }

  async function runCommand(commandLine: string) {
    const localResult = executeLocal(commandLine);
    if (localResult.handled) {
      if (commandLine !== "clear") {
        pushEntry(commandLine, localResult.output, localResult.source, cwd);
      }
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/terminal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getHfHeaders(),
        },
        body: JSON.stringify({ command: commandLine, cwd, filesystem }),
      });
      const data = (await response.json()) as {
        output: string;
        source: CommandSource;
        fsUpdate?: DirNode | null;
      };

      if (data.fsUpdate) {
        setFilesystem(data.fsUpdate);
      }
      if (data.source === "db") {
        onDbFallback();
      }
      pushEntry(commandLine, data.output, data.source, cwd);
    } catch {
      const fallback = `bash: ${commandLine.split(" ")[0]}: command not found`;
      pushEntry(commandLine, fallback, "db", cwd);
      onDbFallback();
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const commandLine = input.trim();
    if (!commandLine || loading) return;

    setInput("");
    setCommandHistory((previous) => [...previous, commandLine]);
    setHistoryIndex(null);
    setHistoryDraft("");
    await runCommand(commandLine);
  }

  function handleHistoryNavigation(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.ctrlKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      setEntries([]);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!commandHistory.length) return;
      setHistoryIndex((previous) => {
        const next = previous === null ? commandHistory.length - 1 : Math.max(0, previous - 1);
        if (previous === null) {
          setHistoryDraft(input);
        }
        setInput(commandHistory[next]);
        return next;
      });
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= commandHistory.length) {
        setHistoryIndex(null);
        setInput(historyDraft);
      } else {
        setHistoryIndex(next);
        setInput(commandHistory[next]);
      }
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold text-white">Terminal Simulator</h2>
        <p className="mt-1 text-sm text-gray-400">
          Three-tier simulation with local execution, AI runtime, and DB fallback.
        </p>
      </div>

      <div
        className={`flex min-h-[540px] flex-col rounded-xl border border-white/10 bg-[#06070b] p-4 font-mono ${fontClassMap[prefs.fontSize]}`}
      >
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pr-1">
          {entries.map((entry) => (
            <div key={entry.id} className="space-y-1">
              <div className={theme.command}>
                <span className={theme.prompt}>user@linlearn</span>
                <span className="text-gray-600">:</span>
                <span className={theme.path}>{promptPath(entry.cwd)}</span>$ {entry.command}
              </div>

              <div className="space-y-0.5">
                {(entry.output || "").split("\n").map((line, lineIndex) => (
                  <div key={`${entry.id}-${lineIndex}`} className="flex gap-2">
                    {prefs.showSourceTags && (
                      <span className="w-10 shrink-0 text-[10px] uppercase tracking-wide text-gray-600">
                        {sourceTag(entry.source)}
                      </span>
                    )}
                    <span className={`${theme.output} whitespace-pre-wrap break-words`}>{line}</span>
                  </div>
                ))}
                {!entry.output && (
                  <div className="flex gap-2">
                    {prefs.showSourceTags && (
                      <span className="w-10 shrink-0 text-[10px] uppercase tracking-wide text-gray-700">
                        {sourceTag(entry.source)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="mt-3 border-t border-white/10 pt-3">
          <div className="flex items-center gap-2">
            <span className={theme.prompt}>user@linlearn</span>
            <span className="text-gray-600">:</span>
            <span className={theme.path}>{promptPath(cwd)}</span>
            <span className="text-gray-500">$</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleHistoryNavigation}
              disabled={loading}
              className={`w-full bg-transparent ${theme.command} focus:outline-none`}
              autoComplete="off"
              spellCheck={false}
            />
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
            ) : (
              <span className="terminal-cursor text-gray-400">|</span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
