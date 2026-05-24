// src/vm/resourceLimits.ts
import { VMSessionConfig } from "../lib/types";

export const DEFAULT_RESOURCE_LIMITS: VMSessionConfig = {
  memoryLimitBytes: 64 * 1024 * 1024,
  vgaMemoryLimitBytes: 8 * 1024 * 1024,
  cpuThrottlePercent: 50,
  timeoutMs: 15000,
};

export class ResourceLimitsValidator {
  public static validate(config: Partial<VMSessionConfig>): VMSessionConfig {
    const memory = config.memoryLimitBytes ?? DEFAULT_RESOURCE_LIMITS.memoryLimitBytes;
    const vgaMemory = config.vgaMemoryLimitBytes ?? DEFAULT_RESOURCE_LIMITS.vgaMemoryLimitBytes;
    const cpu = config.cpuThrottlePercent ?? DEFAULT_RESOURCE_LIMITS.cpuThrottlePercent;
    const timeout = config.timeoutMs ?? DEFAULT_RESOURCE_LIMITS.timeoutMs;

    if (memory > 128 * 1024 * 1024) {
      throw new Error("Memory limit exceeds max allowed system limit (128MB)");
    }
    if (vgaMemory > 8 * 1024 * 1024) {
      throw new Error("VGA memory limit exceeds max allowed system limit (8MB)");
    }
    if (cpu < 10 || cpu > 100) {
      throw new Error("CPU throttling percentage must be between 10% and 100%");
    }
    if (timeout < 5000 || timeout > 60000) {
      throw new Error("VM execution timeout must be between 5s and 60s");
    }

    return {
      memoryLimitBytes: memory,
      vgaMemoryLimitBytes: vgaMemory,
      cpuThrottlePercent: cpu,
      timeoutMs: timeout,
    };
  }
}
