// src/lib/types.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

export type RiskLevel = "SAFE" | "WARNING" | "BLOCKED";

export interface CommandRiskAnalysis {
  command: string;
  riskLevel: RiskLevel;
  reason?: string;
  blockedKeywords?: string[];
}

export interface PromptFirewallResult {
  isClean: boolean;
  reason?: string;
  score: number;
}

export interface OutputSanitizerResult {
  sanitizedOutput: string;
  isTruncated: boolean;
  originalSize: number;
  sanitizedSize: number;
}

export interface VMSessionConfig {
  memoryLimitBytes: number;
  vgaMemoryLimitBytes: number;
  cpuThrottlePercent: number;
  timeoutMs: number;
}

export type VMStateName = "idle" | "loading" | "booting" | "interactive" | "provisioning" | "shell_ready" | "terminal_ready" | "ready" | "stopping" | "stopped" | "error";

export interface VMState {
  state: VMStateName;
  bootTimeMs?: number;
  lastActiveTimestamp: number;
  ramUsageBytes: number;
  bootComplete?: boolean;
}

export interface VMSnapshotMetadata {
  hasSnapshot: boolean;
  snapshotSizeBytes?: number;
}

export interface VMTransitionTrace {
  timestamp: number;
  from: VMStateName;
  to: VMStateName;
  source: string;
  allowed: boolean;
  workerEvent?: string;
  snapshot?: VMSnapshotMetadata;
}

export interface RuleEvaluationResult {
  passed: boolean;
  reason?: string;
  details?: Record<string, any>;
}

export interface JudgeEvaluationResult {
  correct: boolean;
  safe: boolean;
  task_completed: boolean;
  score: number;
  feedback: string;
  mistakes: string[];
  suggestions: string[];
}

export interface FinalEvaluationResult {
  missionId: string;
  success: boolean;
  ruleValidation: RuleEvaluationResult;
  judgeValidation: JudgeEvaluationResult;
  riskAnalysis: CommandRiskAnalysis;
  finalScore: number;
  timestamp: string;
}

export interface UserCommandRequest {
  command: string;
  cwd: string;
  filesystem: Record<string, any>;
  userId: string;
  ipAddress: string;
}

export interface UserCommandResponse {
  output: string;
  error?: string;
  fsUpdate: Record<string, any> | null;
  riskAnalysis: CommandRiskAnalysis;
  executionTimeMs: number;
}
