// src/vm/recoveryOrchestrator.ts
import { Logger } from "../lib/logger";
import { UnifiedTimeoutManager } from "./timeoutManager";
import { RecoveryState } from "./vmLifecycle";

export enum RecoveryStage {
  NONE = 0,
  TTY_REPAIR = 1,
  SHELL_RESTART = 2,
  SERIAL_RECONNECT = 3,
  VM_SOFT_REBOOT = 4,
  COLD_BOOT_FALLBACK = 5
}

export class RecoveryOrchestrator {
  private stage: RecoveryStage = RecoveryStage.NONE;
  private recoveryState: RecoveryState = "healthy";
  private rebootAttempts: number[] = [];
  private lastRecoveryTimestamp = 0;
  private recoveryCooldownMs = 15000; // 15s cooldown between recovery actions
  
  private timeouts: UnifiedTimeoutManager;
  private onAction: (stage: RecoveryStage) => Promise<boolean>;
  private onStateChange: (state: RecoveryState) => void;

  constructor(
    timeouts: UnifiedTimeoutManager,
    onAction: (stage: RecoveryStage) => Promise<boolean>,
    onStateChange: (state: RecoveryState) => void
  ) {
    this.timeouts = timeouts;
    this.onAction = onAction;
    this.onStateChange = onStateChange;
  }

  public getStage(): RecoveryStage {
    return this.stage;
  }

  public getRecoveryState(): RecoveryState {
    return this.recoveryState;
  }

  public reset(): void {
    this.stage = RecoveryStage.NONE;
    this.recoveryState = "healthy";
    this.onStateChange("healthy");
    this.timeouts.cancel("recovery_escalation");
  }

  public triggerRecovery(reason: string): void {
    const now = Date.now();
    if (now - this.lastRecoveryTimestamp < this.recoveryCooldownMs) {
      Logger.warn("VM", `Skipping recovery trigger: in cooldown period. Reason: ${reason}`);
      return;
    }

    if (this.recoveryState === "crashloop") {
      Logger.error("VM", "VM is in crashloop state. Manual intervention required (Reset VM State).");
      return;
    }

    Logger.warn("VM", `Triggering recovery flow due to: ${reason}`);
    this.lastRecoveryTimestamp = now;
    this.recoveryState = "recovering";
    this.onStateChange("recovering");

    // Start escalation from Stage 1 (TTY repair)
    this.stage = RecoveryStage.TTY_REPAIR;
    this.executeCurrentStage();
  }

  private async executeCurrentStage(): Promise<void> {
    Logger.info("VM", `Executing recovery stage: ${RecoveryStage[this.stage]} (${this.stage})`);
    
    // Track reboot attempts to prevent reboot loops
    if (this.stage === RecoveryStage.VM_SOFT_REBOOT || this.stage === RecoveryStage.COLD_BOOT_FALLBACK) {
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

    const success = await this.onAction(this.stage);
    if (success) {
      // Wait for 4 seconds to see if health returns
      this.timeouts.register("recovery_escalation", 4000, () => {
        Logger.warn("VM", `Stage ${RecoveryStage[this.stage]} did not restore health. Escalating...`);
        this.escalate();
      });
    } else {
      // Action failed immediately, escalate directly
      this.escalate();
    }
  }

  private escalate(): void {
    if (this.stage < RecoveryStage.COLD_BOOT_FALLBACK) {
      this.stage += 1;
      this.executeCurrentStage();
    } else {
      Logger.error("VM", "All recovery stages exhausted. VM remains unhealthy. Transitioning to degraded state.");
      this.recoveryState = "degraded";
      this.onStateChange("degraded");
    }
  }

  public reportHealthy(): void {
    if (this.recoveryState !== "healthy") {
      Logger.info("VM", `VM health restored successfully. Prev stage: ${RecoveryStage[this.stage]}`);
      this.reset();
    }
  }
}
