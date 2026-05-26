// src/lib/logger.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

export type LogCategory = "SYSTEM" | "SECURITY" | "VM" | "EVALUATION" | "ABUSE";

export class Logger {
  private static format(category: LogCategory, level: string, msg: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` | Meta: ${JSON.stringify(meta)}` : "";
    return `[${timestamp}] [${category}] [${level.toUpperCase()}] ${msg}${metaStr}`;
  }

  public static info(category: LogCategory, msg: string, meta?: any) {
    console.log(this.format(category, "info", msg, meta));
  }

  public static debug(category: LogCategory, msg: string, meta?: any) {
    if (process.env.NODE_ENV !== "production") {
      console.log(this.format(category, "debug", msg, meta));
    }
  }

  public static warn(category: LogCategory, msg: string, meta?: any) {
    console.warn(this.format(category, "warn", msg, meta));
  }

  public static error(category: LogCategory, msg: string, meta?: any) {
    console.error(this.format(category, "error", msg, meta));
  }

  public static securityEvent(msg: string, meta?: any) {
    this.warn("SECURITY", `[EVENT] ${msg}`, meta);
  }

  public static promptInjectionTrace(prompt: string, score: number, details?: any) {
    this.warn("SECURITY", `[PROMPT_INJECTION_TRACE] Suspicious prompt detected. Score: ${score}`, {
      promptPreview: prompt.substring(0, 100) + (prompt.length > 100 ? "..." : ""),
      details,
    });
  }

  public static vmLifecycle(msg: string, meta?: any) {
    this.info("VM", msg, meta);
  }

  public static vmTransition(from: string, to: string, allowed: boolean, source?: string) {
    const status = allowed ? "ALLOWED" : "BLOCKED";
    const meta = { from, to, status, source: source || "unknown", ts: Date.now() };
    if (allowed) {
      this.info("VM", `[TRANSITION] ${from} -> ${to} [${status}] (source: ${meta.source})`, meta);
    } else {
      this.warn("VM", `[TRANSITION] ${from} -> ${to} [${status}] (source: ${meta.source})`, meta);
    }
  }

  public static evaluationAudit(missionId: string, command: string, success: boolean, score: number) {
    this.info("EVALUATION", `[AUDIT] Mission: ${missionId} | Command: "${command}" | Success: ${success} | Score: ${score}`);
  }

  public static abuseDetected(ip: string, reason: string, meta?: any) {
    this.error("ABUSE", `[MONITOR] Abuse detected from IP: ${ip} | Reason: ${reason}`, meta);
  }
}
