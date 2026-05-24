// src/security/promptFirewall.ts
import { PromptFirewallResult } from "../lib/types";

interface FirewallRule {
  pattern: RegExp;
  weight: number;
  reason: string;
}

const FIREWALL_RULES: FirewallRule[] = [
  { pattern: /ignore\s+(any|all)?\s*previous\s+instructions/i, weight: 1.0, reason: "Attempt to override previous prompt instructions" },
  { pattern: /disregard\s+(any|all)?\s*previous\s+rules/i, weight: 1.0, reason: "Attempt to override previous prompt instructions" },
  { pattern: /system\s*prompt\s*override/i, weight: 0.9, reason: "Direct override keyword match" },
  { pattern: /reveal\s+(your)?\s*system\s*(prompt|instructions)/i, weight: 1.0, reason: "Request to dump model system prompt" },
  { pattern: /what\s+is\s+your\s+system\s*prompt/i, weight: 0.9, reason: "Request to dump model system prompt" },
  { pattern: /print\s+the\s+above\s+text/i, weight: 0.8, reason: "Common prompt leakage pattern" },
  { pattern: /output\s+the\s+content\s+of\s+your\s+prompt/i, weight: 0.9, reason: "Request to dump model system prompt" },
  { pattern: /bypass\s+grading/i, weight: 1.0, reason: "Attempt to skip grading constraints" },
  { pattern: /disable\s+(restrictions|checks|validations)/i, weight: 0.8, reason: "Attempt to turn off security checks" },
  { pattern: /pretend\s+(the\s+)?(command|execution)\s+succeeded/i, weight: 0.9, reason: "Attempt to simulate fake successful execution" },
  { pattern: /ignore\s+mistakes/i, weight: 0.7, reason: "Attempt to ignore validation failures" },
  { pattern: /force\s+success/i, weight: 0.8, reason: "Attempt to bypass evaluation checks" },
  { pattern: /act\s+as\s+root/i, weight: 0.9, reason: "Request to bypass privilege controls in simulation" },
  { pattern: /you\s+are\s+now\s+(root|admin|superuser)/i, weight: 0.9, reason: "Request to bypass privilege controls in simulation" },
  { pattern: /run\s+without\s+restrictions/i, weight: 0.8, reason: "Request to skip constraints" },
];

export class PromptFirewall {
  public static analyze(prompt: string): PromptFirewallResult {
    let score = 0;
    let flaggedReason: string | undefined;

    for (const rule of FIREWALL_RULES) {
      if (rule.pattern.test(prompt)) {
        score += rule.weight;
        if (!flaggedReason) {
          flaggedReason = rule.reason;
        }
      }
    }

    const finalScore = Math.min(score, 1.0);
    const isClean = finalScore < 0.8;

    return {
      isClean,
      score: finalScore,
      reason: isClean ? undefined : flaggedReason || "Suspicious prompt injection pattern flagged",
    };
  }

  public static sanitizeInput(input: string): string {
    return input
      .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F]/g, "")
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      .trim();
  }
}
