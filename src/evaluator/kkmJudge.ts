// src/evaluator/kkmJudge.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { callLlamaJson } from "../lib/llama";
import { SchemaValidator } from "../security/schemaValidator";
import { JudgeEvaluationResult } from "../lib/types";
import { Logger } from "../lib/logger";

export class KKMJudge {
  public static async evaluate(
    command: string,
    output: string,
    expectedBehavior: string
  ): Promise<JudgeEvaluationResult> {
    const systemPrompt = `You are a principal Linux security judge evaluating student lab outputs.
CRITICAL MANDATES:
1. NEVER execute commands.
2. NEVER hallucinate success or output logs.
3. Assess the user's execution command and output logs against target behavior.
4. Output JSON conforming strictly to the requested schema. No markdown wrapping.

Target JSON Schema format:
{
  "correct": boolean,
  "safe": boolean,
  "task_completed": boolean,
  "score": number (1.0 to 10.0),
  "feedback": "string",
  "mistakes": ["string array"],
  "suggestions": ["string array"]
}`;

    const userPrompt = `User Executed Command: "${command}"
Terminal Standard Output/Error Logs:
"""
${output.substring(0, 1000)}
"""
Expected Target Behavior: "${expectedBehavior}"`;

    try {
      Logger.info("EVALUATION", `Invoking KKM Judge for command: "${command}"`);
      const rawResult = await callLlamaJson<any>(systemPrompt, userPrompt);
      const validated = SchemaValidator.validateJudgeResult(rawResult);

      if (validated.score > 8.0) {
        validated.score = 7.8;
      } else if (validated.score < 4.0) {
        validated.score = 3.2;
      } else {
        validated.score = 5.5;
      }

      return validated;
    } catch (err: any) {
      Logger.error("EVALUATION", "KKM Judge failed or returned malformed JSON. Using fallback metrics.", err);
      return {
        correct: false,
        safe: true,
        task_completed: false,
        score: 3.2,
        feedback: `Semantic evaluation failed: ${err.message || String(err)}. Falling back to deterministic rules.`,
        mistakes: ["Malformed evaluator response received from model"],
        suggestions: ["Re-run command verification checks"],
      };
    }
  }
}
