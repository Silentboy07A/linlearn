// src/vm/ttyStateGuard.ts
import { Logger } from "../lib/logger";

export interface TTYState {
  echoEnabled: boolean;
  icanonEnabled: boolean;
  stdinAttached: boolean;
  shellParserHealthy: boolean;
}

export class TTYStateGuard {
  public static parse(statusStr: string): TTYState | null {
    if (!statusStr.startsWith("TTY_STATE:")) {
      return null;
    }

    try {
      // Format: TTY_STATE:echo=1:icanon=1:owner=user:active=1
      const parts = statusStr.replace("TTY_STATE:", "").split(":");
      const stateMap: Record<string, string> = {};
      for (const part of parts) {
        const index = part.indexOf("=");
        if (index !== -1) {
          const key = part.substring(0, index);
          const val = part.substring(index + 1);
          stateMap[key] = val;
        }
      }

      return {
        echoEnabled: stateMap["echo"] === "1",
        icanonEnabled: stateMap["icanon"] === "1",
        stdinAttached: stateMap["owner"] === "user" || stateMap["owner"] === "root",
        shellParserHealthy: stateMap["active"] === "1",
      };
    } catch (e) {
      Logger.error("VM", "Error parsing TTY state string: " + statusStr, e);
      return null;
    }
  }

  public static validate(state: TTYState): { healthy: boolean; reason?: string } {
    if (!state.echoEnabled) {
      return { healthy: false, reason: "echo disabled" };
    }
    if (!state.icanonEnabled) {
      return { healthy: false, reason: "canonical mode inactive" };
    }
    if (!state.stdinAttached) {
      return { healthy: false, reason: "stdin detached (wrong owner)" };
    }
    if (!state.shellParserHealthy) {
      return { healthy: false, reason: "shell parser inactive" };
    }
    return { healthy: true };
  }
}
