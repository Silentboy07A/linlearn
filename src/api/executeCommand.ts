// src/api/executeCommand.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { PromptFirewall } from "../security/promptFirewall";
import { CommandRiskEngine } from "../security/commandRiskEngine";
import { RateLimiter } from "../security/rateLimiter";
import { AbuseDetector } from "../security/abuseDetector";
import { OutputSanitizer } from "../security/outputSanitizer";
import { UserCommandRequest, UserCommandResponse } from "../lib/types";
import { Logger } from "../lib/logger";
import { PromptInjectionError, CommandBlockedError } from "../lib/errors";

export async function executeCommandService(
  request: UserCommandRequest,
  simulateCallback: (command: string, cwd: string, fs: Record<string, any>) => Promise<{ output: string; fsUpdate: Record<string, any> | null }>
): Promise<UserCommandResponse> {
  const startTime = Date.now();
  const { command, cwd, filesystem, userId, ipAddress } = request;

  try {
    AbuseDetector.checkIP(ipAddress);

    RateLimiter.check(`cmd:${ipAddress}:${userId}`, { limit: 30, windowMs: 60 * 1000 });

    const firewallResult = PromptFirewall.analyze(command);
    if (!firewallResult.isClean) {
      AbuseDetector.recordPromptInjection(ipAddress, firewallResult.reason || "Prompt injection");
      Logger.promptInjectionTrace(command, firewallResult.score, firewallResult);
      throw new PromptInjectionError(firewallResult.reason);
    }

    const riskAnalysis = CommandRiskEngine.analyze(command);
    if (riskAnalysis.riskLevel === "BLOCKED") {
      AbuseDetector.recordCommandBlock(ipAddress, riskAnalysis.reason || "Dangerous command");
      throw new CommandBlockedError("Dangerous command execution blocked", riskAnalysis.reason);
    }

    const sanitizedCommand = PromptFirewall.sanitizeInput(command);
    const result = await simulateCallback(sanitizedCommand, cwd, filesystem);

    const sanitizerResult = OutputSanitizer.sanitize(result.output);

    const executionTimeMs = Date.now() - startTime;

    return {
      output: sanitizerResult.sanitizedOutput,
      fsUpdate: result.fsUpdate,
      riskAnalysis,
      executionTimeMs,
    };
  } catch (err: any) {
    const executionTimeMs = Date.now() - startTime;
    Logger.error("SYSTEM", `Command execution failed: ${err.message || String(err)}`);
    return {
      output: "",
      error: err.message || String(err),
      fsUpdate: null,
      riskAnalysis: { command, riskLevel: "BLOCKED", reason: err.message || String(err) },
      executionTimeMs,
    };
  }
}
