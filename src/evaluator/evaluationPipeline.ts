// src/evaluator/evaluationPipeline.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { CommandRiskEngine } from "../security/commandRiskEngine";
import { RuleEngine, EvaluationRule } from "./ruleEngine";
import { KKMJudge } from "./kkmJudge";
import { OutputSanitizer } from "../security/outputSanitizer";
import { FinalEvaluationResult, JudgeEvaluationResult, RuleEvaluationResult } from "../lib/types";
import { Logger } from "../lib/logger";
import { CommandBlockedError } from "../lib/errors";

export class EvaluationPipeline {
  public static async run(params: {
    missionId: string;
    command: string;
    output: string;
    filesystem: Record<string, any>;
    rules: EvaluationRule[];
    expectedBehavior: string;
    ipAddress: string;
  }): Promise<FinalEvaluationResult> {
    const { missionId, command, output, filesystem, rules, expectedBehavior, ipAddress } = params;

    const riskAnalysis = CommandRiskEngine.analyze(command);
    if (riskAnalysis.riskLevel === "BLOCKED") {
      Logger.securityEvent(`Pipeline blocked dangerous command for IP ${ipAddress}: "${command}"`, riskAnalysis);
      throw new CommandBlockedError("Execution prohibited", riskAnalysis.reason);
    }

    const sanitizedOutput = OutputSanitizer.sanitize(output).sanitizedOutput;

    let ruleValidation: RuleEvaluationResult;
    try {
      ruleValidation = RuleEngine.evaluate(filesystem, rules);
    } catch (err: any) {
      Logger.error("EVALUATION", "Deterministic Rule Engine failed during check", err);
      ruleValidation = { passed: false, reason: `Rule engine error: ${err.message || String(err)}` };
    }

    let judgeValidation: JudgeEvaluationResult;
    if (ruleValidation.passed) {
      judgeValidation = await KKMJudge.evaluate(command, sanitizedOutput, expectedBehavior);
    } else {
      judgeValidation = {
        correct: false,
        safe: true,
        task_completed: false,
        score: 3.2,
        feedback: `Deterministic checks failed: ${ruleValidation.reason}`,
        mistakes: [ruleValidation.reason || "Rule validation failed"],
        suggestions: ["Modify command options or inputs to meet goals"],
      };
    }

    const success = ruleValidation.passed && judgeValidation.correct;
    const finalScore = success ? judgeValidation.score : 3.2;

    Logger.evaluationAudit(missionId, command, success, finalScore);

    return {
      missionId,
      success,
      ruleValidation,
      judgeValidation,
      riskAnalysis,
      finalScore,
      timestamp: new Date().toISOString(),
    };
  }
}
