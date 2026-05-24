// src/security/schemaValidator.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { JudgeEvaluationResult, UserCommandRequest } from "../lib/types";

export class SchemaValidator {
  public static validateJudgeResult(data: any): JudgeEvaluationResult {
    if (!data || typeof data !== "object") {
      throw new Error("Invalid schema: KKM Judge result must be a JSON object");
    }

    const requiredKeys = ["correct", "safe", "task_completed", "score", "feedback", "mistakes", "suggestions"];
    for (const key of requiredKeys) {
      if (!(key in data)) {
        throw new Error(`Invalid schema: Missing required key "${key}"`);
      }
    }

    if (typeof data.correct !== "boolean") {
      throw new Error("Invalid schema: Property \"correct\" must be a boolean");
    }
    if (typeof data.safe !== "boolean") {
      throw new Error("Invalid schema: Property \"safe\" must be a boolean");
    }
    if (typeof data.task_completed !== "boolean") {
      throw new Error("Invalid schema: Property \"task_completed\" must be a boolean");
    }
    if (typeof data.score !== "number" || isNaN(data.score)) {
      throw new Error("Invalid schema: Property \"score\" must be a valid number");
    }
    if (typeof data.feedback !== "string") {
      throw new Error("Invalid schema: Property \"feedback\" must be a string");
    }
    if (!Array.isArray(data.mistakes) || data.mistakes.some((m: any) => typeof m !== "string")) {
      throw new Error("Invalid schema: Property \"mistakes\" must be an array of strings");
    }
    if (!Array.isArray(data.suggestions) || data.suggestions.some((s: any) => typeof s !== "string")) {
      throw new Error("Invalid schema: Property \"suggestions\" must be an array of strings");
    }

    return {
      correct: data.correct,
      safe: data.safe,
      task_completed: data.task_completed,
      score: data.score,
      feedback: data.feedback.trim(),
      mistakes: data.mistakes,
      suggestions: data.suggestions,
    };
  }

  public static validateCommandRequest(data: any): UserCommandRequest {
    if (!data || typeof data !== "object") {
      throw new Error("Invalid schema: Request payload must be a JSON object");
    }

    if (typeof data.command !== "string" || !data.command.trim()) {
      throw new Error("Invalid schema: Property \"command\" must be a non-empty string");
    }
    if (typeof data.cwd !== "string") {
      throw new Error("Invalid schema: Property \"cwd\" must be a string");
    }
    if (!data.filesystem || typeof data.filesystem !== "object") {
      throw new Error("Invalid schema: Property \"filesystem\" must be a valid object");
    }
    if (typeof data.userId !== "string" || !data.userId.trim()) {
      throw new Error("Invalid schema: Property \"userId\" must be a non-empty string");
    }
    if (typeof data.ipAddress !== "string") {
      throw new Error("Invalid schema: Property \"ipAddress\" must be a string");
    }

    return {
      command: data.command.trim(),
      cwd: data.cwd.trim(),
      filesystem: data.filesystem,
      userId: data.userId.trim(),
      ipAddress: data.ipAddress.trim(),
    };
  }
}
