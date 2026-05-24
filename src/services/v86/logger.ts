// src/services/v86/logger.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

export type LogLevel = "info" | "debug" | "error" | "warn";

export function log(level: LogLevel, msg: string) {
  const formattedLevel = level.toUpperCase();
  const prefix = `[v86-worker] [${formattedLevel}]`;
  let cleanMsg = msg;
  if (msg.indexOf(prefix) !== 0) {
    cleanMsg = `${prefix} ${msg}`;
  }
  (self as any).postMessage({
    type: "LOG",
    payload: { level: level.toLowerCase(), msg: cleanMsg },
  });
}
