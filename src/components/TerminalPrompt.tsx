"use client";

import { cn } from "@/lib/utils";

interface TerminalPromptProps {
  children?:  React.ReactNode;
  className?: string;
  username?:  string;
  hostname?:  string;
  path?:      string;
  /** "default" | "root" — root shows red username + # prompt */
  variant?:   "default" | "root";
}

export function TerminalPrompt({
  children,
  className,
  username = "student",
  hostname = "linlearn",
  path = "~",
  variant = "default",
}: TerminalPromptProps) {
  const isRoot = variant === "root";

  return (
    <div className={cn("font-mono text-t-sm leading-relaxed", className)}>
      {/* user@host */}
      <span className={cn("font-semibold", isRoot ? "text-rose-400" : "text-brand-400")}>
        {username}
      </span>
      <span className="text-ink-muted">@</span>
      <span className="font-semibold text-terminal-400">{hostname}</span>
      {/* path */}
      <span className="text-ink-muted">:</span>
      <span className="font-medium text-sky-400">{path}</span>
      {/* prompt char */}
      <span className={cn("font-bold", isRoot ? "text-rose-400" : "text-ink-primary")}>
        {isRoot ? "#" : "$"}
      </span>
      {" "}
      {children}
    </div>
  );
}
