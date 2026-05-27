// src/vm/recoveryOrchestrator.ts
import { Logger } from "../lib/logger";
import { UnifiedTimeoutManager } from "./timeoutManager";
import { RecoveryState, ProvisioningState } from "./vmLifecycle";
import { VMStateName } from "../lib/types";
import { WorkerBridgeState } from "./workerBridge";

export enum RecoveryStage {
  NONE = 0,
  TTY_REPAIR = 1,
  SHELL_RESTART = 2,
  SERIAL_RECONNECT = 3,
  VM_SOFT_REBOOT = 4,
  COLD_BOOT_FALLBACK = 5,
  PROVISIONING_RECOVERY = 6
}

export type RecoveryActionDecision =
  | "no-op"
  | "tty_repair"
  | "shell_restart"
  | "serial_reconnect"
  | "vm_soft_reboot"
  | "cold_boot_fallback"
  | "provisioning_recovery"
  | "extend_timeout";

export interface VMHealthStatus {
  runtimeState: VMStateName;
  provisioningState: ProvisioningState;
  workerState: WorkerBridgeState;
  hasSerial1: boolean;
  lastHeartbeatAgeMs: number;
  lastSerialOutputAgeMs: number;
  lastInputAgeMs: number;
  cpuRunning: boolean;
  workerResponding: boolean;
}

export interface EscalationTelemetryEntry {
  timestamp: number;
  stage: string;
  decision: string;
  reason: string;
  vmHealth: {
    runtimeState: string;
    provisioningState: string;
    workerState: string;
    cpuRunning: boolean;
    workerResponding: boolean;
  };
  isProvisioningOnly: boolean;
  preventedDestructive: boolean;
}

export interface RecoveryTelemetry {
  escalations: EscalationTelemetryEntry[];
  duplicateStartSuppressions: number;
  preventedDestructiveRecoveries: number;
}

export class RecoveryPolicyEngine {
  public static decide(
    health: VMHealthStatus,
    requestedStage: RecoveryStage,
    reason: string
  ): { decision: RecoveryActionDecision; reason: string } {
    const isBootingOrLoading = health.runtimeState === "loading" || health.runtimeState === "booting";
    const isProvisioning = health.runtimeState === "provisioning" || health.runtimeState === "shell_ready" || health.runtimeState === "terminal_ready";
    
    // Active boot protection: during loading/booting/provisioning, limit destructive actions
    if (isBootingOrLoading || isProvisioning) {
      if (health.workerResponding && health.cpuRunning) {
        if (isProvisioning) {
          // Provisioning timeout but VM runtime itself is healthy: provisioning recovery isolation!
          return {
            decision: "provisioning_recovery",
            reason: `Active boot protection: provisioning timeout but VM runtime is healthy. Triggering non-destructive provisioning recovery. Trigger: ${reason}`
          };
        } else {
          // Stalled during loading/booting, but worker and CPU are alive. Extend timeout/observe.
          return {
            decision: "extend_timeout",
            reason: `Active boot protection: VM booting/loading, worker alive, CPU running. Extending timeout to allow boot to progress. Trigger: ${reason}`
          };
        }
      }
      
      // If worker or emulator is confirmed dead (worker not responding, or CPU halted) during boot/provisioning
      if (!health.workerResponding || !health.cpuRunning) {
        return {
          decision: "cold_boot_fallback",
          reason: `VM is unresponsive during boot (worker responding: ${health.workerResponding}, cpuRunning: ${health.cpuRunning}). Cold boot fallback required. Trigger: ${reason}`
        };
      }
    }

    // Normal running state recovery
    switch (requestedStage) {
      case RecoveryStage.TTY_REPAIR:
        return { decision: "tty_repair", reason: `Normal escalation: repairing terminal settings. Reason: ${reason}` };
        
      case RecoveryStage.SHELL_RESTART:
        return { decision: "shell_restart", reason: `Normal escalation: restarting user shell. Reason: ${reason}` };
        
      case RecoveryStage.SERIAL_RECONNECT:
        return { decision: "serial_reconnect", reason: `Normal escalation: reconnecting serial transport. Reason: ${reason}` };
        
      case RecoveryStage.VM_SOFT_REBOOT:
        // Before destructive soft reboot, verify responsiveness
        if (health.workerResponding && health.cpuRunning) {
          // Suppress soft reboot since the VM is still alive. Retry serial reconnect instead.
          return {
            decision: "serial_reconnect",
            reason: `Suppressing soft reboot: VM runtime is responsive (workerResponding: true, cpuRunning: true). Retrying serial reconnect. Trigger: ${reason}`
          };
        }
        return { decision: "vm_soft_reboot", reason: `VM CPU/worker verified unresponsive. Soft rebooting VM. Reason: ${reason}` };
        
      case RecoveryStage.COLD_BOOT_FALLBACK:
        // Before destructive cold boot, verify responsiveness
        if (health.workerResponding && health.cpuRunning) {
          // Suppress cold boot since the VM is still alive. Retry serial reconnect instead.
          return {
            decision: "serial_reconnect",
            reason: `Suppressing cold boot: VM runtime is responsive. Retrying serial reconnect. Trigger: ${reason}`
          };
        }
        return { decision: "cold_boot_fallback", reason: `All recovery stages exhausted and VM is unresponsive. Cold booting guest VM. Reason: ${reason}` };
        
      default:
        return { decision: "no-op", reason: "No recovery action specified or stage NONE." };
    }
  }
}

export class RecoveryOrchestrator {
  private stage: RecoveryStage = RecoveryStage.NONE;
  private recoveryState: RecoveryState = "healthy";
  private rebootAttempts: number[] = [];
  private lastRecoveryTimestamp = 0;
  private recoveryCooldownMs = 15000; // 15s cooldown between recovery actions
  
  private timeouts: UnifiedTimeoutManager;
  private getHealth: () => VMHealthStatus;
  private onAction: (stage: RecoveryStage) => Promise<boolean>;
  private onStateChange: (state: RecoveryState) => void;

  private telemetry: RecoveryTelemetry = {
    escalations: [],
    duplicateStartSuppressions: 0,
    preventedDestructiveRecoveries: 0,
  };

  constructor(
    timeouts: UnifiedTimeoutManager,
    getHealth: () => VMHealthStatus,
    onAction: (stage: RecoveryStage) => Promise<boolean>,
    onStateChange: (state: RecoveryState) => void
  ) {
    this.timeouts = timeouts;
    this.getHealth = getHealth;
    this.onAction = onAction;
    this.onStateChange = onStateChange;
  }

  public getStage(): RecoveryStage {
    return this.stage;
  }

  public getRecoveryState(): RecoveryState {
    return this.recoveryState;
  }

  public getTelemetry(): RecoveryTelemetry {
    return { ...this.telemetry };
  }

  public recordDuplicateStartSuppression(): void {
    this.telemetry.duplicateStartSuppressions++;
  }

  public recordPreventedDestructiveRecovery(): void {
    this.telemetry.preventedDestructiveRecoveries++;
  }

  public reset(): void {
    this.stage = RecoveryStage.NONE;
    this.recoveryState = "healthy";
    this.recoveryCooldownMs = 15000;
    this.onStateChange("healthy");
    this.timeouts.cancel("recovery_escalation");
  }

  public triggerRecovery(reason: string): void {
    const now = Date.now();
    if (now - this.lastRecoveryTimestamp < this.recoveryCooldownMs) {
      Logger.warn("VM", `Skipping recovery trigger: in cooldown period (${Math.round((this.recoveryCooldownMs - (now - this.lastRecoveryTimestamp)) / 1000)}s remaining). Reason: ${reason}`);
      return;
    }

    if (this.recoveryState === "crashloop" || this.recoveryState === "degraded") {
      Logger.warn("VM", `Skipping recovery trigger: VM is in ${this.recoveryState} state.`);
      return;
    }

    Logger.warn("VM", `Triggering recovery flow due to: ${reason}`);
    this.lastRecoveryTimestamp = now;
    
    // Exponential backoff for the next cooldown check
    this.recoveryCooldownMs = Math.min(this.recoveryCooldownMs * 1.5, 60000);

    this.recoveryState = "recovering";
    this.onStateChange("recovering");

    // Start escalation from Stage 1 (TTY repair)
    this.stage = RecoveryStage.TTY_REPAIR;
    this.executeCurrentStage(reason);
  }

  private async executeCurrentStage(triggerReason: string = "unspecified"): Promise<void> {
    const health = this.getHealth();
    
    // Query RecoveryPolicyEngine
    const decisionResult = RecoveryPolicyEngine.decide(health, this.stage, triggerReason);
    const decision = decisionResult.decision;

    Logger.info("VM", `[RecoveryOrchestrator] Recovery decision for stage ${RecoveryStage[this.stage]}: ${decision} (Reason: ${decisionResult.reason})`);

    // Record telemetry
    this.recordEscalationTelemetry(this.stage, decision, health, decisionResult.reason);

    if (decision === "no-op") {
      Logger.info("VM", "[RecoveryOrchestrator] Decision is no-op. Stopping escalation loop.");
      return;
    }

    if (decision === "extend_timeout") {
      Logger.info("VM", "[RecoveryOrchestrator] Active boot protection: extending watchdog timeout.");
      this.timeouts.extend("boot_watchdog", 15000);
      this.timeouts.extend("provisioning_watchdog", 15000);
      
      this.timeouts.register("recovery_escalation", 4000, () => {
        this.executeCurrentStage("timeout extension check");
      });
      return;
    }

    // Track reboot attempts to prevent reboot loops for destructive choices
    if (decision === "vm_soft_reboot" || decision === "cold_boot_fallback") {
      const now = Date.now();
      this.rebootAttempts = this.rebootAttempts.filter(t => now - t < 60000);
      if (this.rebootAttempts.length >= 3) {
        Logger.error("VM", "Crash-loop detected! 3 boot attempts in 60s. Transitioning to crashloop state.");
        this.recoveryState = "crashloop";
        this.onStateChange("crashloop");
        await this.onAction(RecoveryStage.NONE); // suspend/stop
        return;
      }
      this.rebootAttempts.push(now);
    }

    // Map decision to RecoveryStage
    let stageToExecute = RecoveryStage.NONE;
    if (decision === "tty_repair") stageToExecute = RecoveryStage.TTY_REPAIR;
    else if (decision === "shell_restart") stageToExecute = RecoveryStage.SHELL_RESTART;
    else if (decision === "serial_reconnect") stageToExecute = RecoveryStage.SERIAL_RECONNECT;
    else if (decision === "vm_soft_reboot") stageToExecute = RecoveryStage.VM_SOFT_REBOOT;
    else if (decision === "cold_boot_fallback") stageToExecute = RecoveryStage.COLD_BOOT_FALLBACK;
    else if (decision === "provisioning_recovery") stageToExecute = RecoveryStage.PROVISIONING_RECOVERY;

    let success = false;
    try {
      success = await this.onAction(stageToExecute);
    } catch (err) {
      Logger.error("VM", `Recovery stage ${RecoveryStage[stageToExecute]} action threw an error:`, err);
      success = false;
    }

    if (success) {
      // Wait for 4 seconds to see if health returns
      this.timeouts.register("recovery_escalation", 4000, () => {
        Logger.warn("VM", `Stage ${RecoveryStage[this.stage]} did not restore health. Escalating...`);
        this.escalate(triggerReason);
      });
    } else {
      // Action failed immediately, escalate directly
      this.escalate(triggerReason);
    }
  }

  private escalate(triggerReason: string): void {
    if (this.stage < RecoveryStage.COLD_BOOT_FALLBACK) {
      this.stage += 1;
      this.executeCurrentStage(triggerReason);
    } else {
      Logger.error("VM", "All recovery stages exhausted. VM remains unhealthy. Transitioning to degraded state.");
      this.recoveryState = "degraded";
      this.onStateChange("degraded");
    }
  }

  private recordEscalationTelemetry(
    requestedStage: RecoveryStage,
    decision: string,
    health: VMHealthStatus,
    reason: string
  ): void {
    const isProvisioningOnly = (health.runtimeState === "provisioning" || health.runtimeState === "shell_ready" || health.runtimeState === "terminal_ready") && health.workerResponding && health.cpuRunning;
    const preventedDestructive = (decision !== "vm_soft_reboot" && decision !== "cold_boot_fallback") && 
      (requestedStage === RecoveryStage.VM_SOFT_REBOOT || requestedStage === RecoveryStage.COLD_BOOT_FALLBACK);

    if (preventedDestructive) {
      this.recordPreventedDestructiveRecovery();
    }

    this.telemetry.escalations.push({
      timestamp: Date.now(),
      stage: RecoveryStage[requestedStage],
      decision,
      reason,
      vmHealth: {
        runtimeState: health.runtimeState,
        provisioningState: health.provisioningState,
        workerState: health.workerState,
        cpuRunning: health.cpuRunning,
        workerResponding: health.workerResponding,
      },
      isProvisioningOnly,
      preventedDestructive,
    });

    if (this.telemetry.escalations.length > 50) {
      this.telemetry.escalations.shift();
    }
  }

  public reportHealthy(): void {
    if (this.recoveryState !== "healthy") {
      Logger.info("VM", `VM health restored successfully. Prev stage: ${RecoveryStage[this.stage]}`);
      this.reset();
    }
  }
}
