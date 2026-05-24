// src/evaluator/ruleEngine.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { RuleEvaluationResult } from "../lib/types";

export interface EvaluationRule {
  type: "file_exists" | "file_contains" | "directory_exists" | "file_deleted" | "file_permissions";
  targetPath: string;
  expectedValue?: string;
  permissions?: number;
}

export class RuleEngine {
  public static evaluate(filesystem: Record<string, any>, rules: EvaluationRule[]): RuleEvaluationResult {
    for (const rule of rules) {
      const normalizedPath = rule.targetPath.startsWith("/") ? rule.targetPath : `/${rule.targetPath}`;

      switch (rule.type) {
        case "file_exists": {
          const file = filesystem[normalizedPath];
          if (!file || file.type !== "file") {
            return { passed: false, reason: `File not found: ${rule.targetPath}` };
          }
          break;
        }

        case "file_contains": {
          const file = filesystem[normalizedPath];
          if (!file || file.type !== "file") {
            return { passed: false, reason: `File not found: ${rule.targetPath}` };
          }
          const content = String(file.content || "");
          if (rule.expectedValue && !content.includes(rule.expectedValue)) {
            return { passed: false, reason: `File content mismatch in ${rule.targetPath}: expected to contain "${rule.expectedValue}"` };
          }
          break;
        }

        case "directory_exists": {
          const dir = filesystem[normalizedPath];
          if (!dir || dir.type !== "directory") {
            return { passed: false, reason: `Directory not found: ${rule.targetPath}` };
          }
          break;
        }

        case "file_deleted": {
          const file = filesystem[normalizedPath];
          if (file) {
            return { passed: false, reason: `File should have been deleted: ${rule.targetPath}` };
          }
          break;
        }

        case "file_permissions": {
          const file = filesystem[normalizedPath];
          if (!file) {
            return { passed: false, reason: `File not found: ${rule.targetPath}` };
          }
          if (rule.permissions !== undefined && file.permissions !== rule.permissions) {
            return { passed: false, reason: `Invalid permissions on ${rule.targetPath}: expected ${rule.permissions.toString(8)}, got ${file.permissions?.toString(8)}` };
          }
          break;
        }

        default:
          return { passed: false, reason: `Unsupported rule type: ${rule.type}` };
      }
    }

    return { passed: true };
  }
}
