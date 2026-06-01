// src/security/schemaValidator.ts
import { JudgeEvaluationResult, UserCommandRequest } from "../lib/types";

export class SchemaValidator {
  public static validateJudgeResult(data: unknown): JudgeEvaluationResult {
    if (!data || typeof data !== "object") {
      throw new Error("Invalid schema: KKM Judge result must be a JSON object");
    }

    const obj = data as Record<string, unknown>;

    const requiredKeys = ["correct", "safe", "task_completed", "score", "feedback", "mistakes", "suggestions"];
    for (const key of requiredKeys) {
      if (!(key in obj)) {
        throw new Error(`Invalid schema: Missing required key "${key}"`);
      }
    }

    if (typeof obj.correct !== "boolean") {
      throw new Error("Invalid schema: Property \"correct\" must be a boolean");
    }
    if (typeof obj.safe !== "boolean") {
      throw new Error("Invalid schema: Property \"safe\" must be a boolean");
    }
    if (typeof obj.task_completed !== "boolean") {
      throw new Error("Invalid schema: Property \"task_completed\" must be a boolean");
    }
    if (typeof obj.score !== "number" || isNaN(obj.score)) {
      throw new Error("Invalid schema: Property \"score\" must be a valid number");
    }
    if (typeof obj.feedback !== "string") {
      throw new Error("Invalid schema: Property \"feedback\" must be a string");
    }
    if (!Array.isArray(obj.mistakes) || obj.mistakes.some((m: unknown) => typeof m !== "string")) {
      throw new Error("Invalid schema: Property \"mistakes\" must be an array of strings");
    }
    if (!Array.isArray(obj.suggestions) || obj.suggestions.some((s: unknown) => typeof s !== "string")) {
      throw new Error("Invalid schema: Property \"suggestions\" must be an array of strings");
    }

    return {
      correct: obj.correct,
      safe: obj.safe,
      task_completed: obj.task_completed,
      score: obj.score,
      feedback: obj.feedback.trim(),
      mistakes: obj.mistakes,
      suggestions: obj.suggestions,
    };
  }

  public static validateCommandRequest(data: unknown): UserCommandRequest {
    if (!data || typeof data !== "object") {
      throw new Error("Invalid schema: Request payload must be a JSON object");
    }

    const obj = data as Record<string, unknown>;

    if (typeof obj.command !== "string" || !obj.command.trim()) {
      throw new Error("Invalid schema: Property \"command\" must be a non-empty string");
    }
    if (typeof obj.cwd !== "string") {
      throw new Error("Invalid schema: Property \"cwd\" must be a string");
    }
    if (!obj.filesystem || typeof obj.filesystem !== "object") {
      throw new Error("Invalid schema: Property \"filesystem\" must be a valid object");
    }
    if (typeof obj.userId !== "string" || !obj.userId.trim()) {
      throw new Error("Invalid schema: Property \"userId\" must be a non-empty string");
    }
    if (typeof obj.ipAddress !== "string") {
      throw new Error("Invalid schema: Property \"ipAddress\" must be a string");
    }

    return {
      command: obj.command.trim(),
      cwd: obj.cwd.trim(),
      filesystem: obj.filesystem as Record<string, unknown>,
      userId: obj.userId.trim(),
      ipAddress: obj.ipAddress.trim(),
    };
  }
}
