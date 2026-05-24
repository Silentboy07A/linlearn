// src/api/evaluateCommand.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { EvaluationPipeline } from "../evaluator/evaluationPipeline";
import { EvaluationRule } from "../evaluator/ruleEngine";
import { RateLimiter } from "../security/rateLimiter";
import { AbuseDetector } from "../security/abuseDetector";
import { FinalEvaluationResult } from "../lib/types";
import { Logger } from "../lib/logger";

export async function evaluateCommandService(params: {
  missionId: string;
  command: string;
  output: string;
  filesystem: Record<string, any>;
  rules: EvaluationRule[];
  expectedBehavior: string;
  userId: string;
  ipAddress: string;
}): Promise<FinalEvaluationResult> {
  const { missionId, command, output, filesystem, rules, expectedBehavior, userId, ipAddress } = params;

  AbuseDetector.checkIP(ipAddress);

  RateLimiter.check(`eval:${ipAddress}:${userId}`, { limit: 15, windowMs: 60 * 1000 });

  Logger.info("EVALUATION", `Starting evaluation request for user ${userId} on mission ${missionId}`);

  const result = await EvaluationPipeline.run({
    missionId,
    command,
    output,
    filesystem,
    rules,
    expectedBehavior,
    ipAddress,
  });

  return result;
}
