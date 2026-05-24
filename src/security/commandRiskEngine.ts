// src/security/commandRiskEngine.ts
import { CommandRiskAnalysis } from "../lib/types";

const BLOCKED_RULES = [
  { pattern: /rm\s+-rf\s+\//i, reason: "Destructive root deletion blocked" },
  { pattern: /rm\s+-[a-z]*r[a-z]*f\s+\//i, reason: "Destructive root deletion blocked" },
  { pattern: /rm\s+-rf\s+\*/i, reason: "Destructive broad deletion blocked" },
  { pattern: /:\(\)\{\s*:\s*\|\s*:\s*&\s*\}\s*;/i, reason: "Fork bomb process exhaustion blocked" },
  { pattern: /fork\s+bomb/i, reason: "Fork bomb keyword blocked" },
  { pattern: /dd\s+if=/i, reason: "Low-level dd disk write operations blocked" },
  { pattern: /mkfs(\.[a-z0-9]+)?\s+/i, reason: "Filesystem creation blocked" },
  { pattern: /chmod\s+([0-7]*7){3}\s+\//i, reason: "Global write permissions on root directory blocked" },
  { pattern: /chmod\s+-R\s+777\s+/i, reason: "Recursive global permission grant blocked" },
  { pattern: /xmrig/i, reason: "Crypto mining utility blocked" },
  { pattern: /minerd/i, reason: "Crypto mining utility blocked" },
  { pattern: /stratum\+tcp/i, reason: "Crypto mining network connections blocked" },
  { pattern: /nc\s+-e\s+/i, reason: "Netcat reverse shell execution blocked" },
  { pattern: /nc\s+-lp\s+/i, reason: "Netcat port binding listener blocked" },
  { pattern: /bash\s+-i\s*>\s*&\s*\/dev\/tcp/i, reason: "TCP device socket redirect shell blocked" },
  { pattern: /wget\s+http/i, reason: "External resource retrieval blocked" },
  { pattern: /curl\s+http/i, reason: "External resource retrieval blocked" },
];

const WARNING_RULES = [
  { pattern: /sudo\s+/i, reason: "Privileged execution warning" },
  { pattern: /chmod\s+777\s+/i, reason: "Wide permission assignment warning" },
  { pattern: /chown\s+/i, reason: "Ownership modification warning" },
  { pattern: /kill\s+-9/i, reason: "Forced process termination warning" },
  { pattern: /shutdown/i, reason: "System power modification warning" },
  { pattern: /reboot/i, reason: "System reboot warning" },
];

export class CommandRiskEngine {
  public static analyze(command: string): CommandRiskAnalysis {
    const cleanCmd = command.trim();

    const blockedKeywords: string[] = [];
    let blockedReason: string | undefined;

    for (const rule of BLOCKED_RULES) {
      if (rule.pattern.test(cleanCmd)) {
        blockedKeywords.push(rule.pattern.source);
        blockedReason = rule.reason;
        break;
      }
    }

    if (blockedKeywords.length > 0) {
      return {
        command: cleanCmd,
        riskLevel: "BLOCKED",
        reason: blockedReason,
        blockedKeywords,
      };
    }

    for (const rule of WARNING_RULES) {
      if (rule.pattern.test(cleanCmd)) {
        return {
          command: cleanCmd,
          riskLevel: "WARNING",
          reason: rule.reason,
        };
      }
    }

    return {
      command: cleanCmd,
      riskLevel: "SAFE",
    };
  }
}
