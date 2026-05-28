// src/vm/vmLifecycle.ts
import { VMState, VMStateName, VMTransitionTrace, VMSnapshotMetadata } from "../lib/types";
import { Logger } from "../lib/logger";

export type VMRuntimeState = VMStateName;
export type ProvisioningState = "idle" | "preparing" | "transferring" | "executing" | "waiting_completion" | "completed" | "failed" | "recovering";
export type TerminalState = "detached" | "attached" | "interactive" | "recovering";
export type RecoveryState = "healthy" | "recovering" | "degraded" | "crashloop" | "info" | "fatal";

export interface VMFullState {
  runtime: VMRuntimeState;
  provisioning: ProvisioningState;
  terminal: TerminalState;
  recovery: RecoveryState;
  bootComplete: boolean;
}

export class VMLifecycleManager {
  private currentState: VMState = {
    state: "idle",
    lastActiveTimestamp: Date.now(),
    ramUsageBytes: 0,
    bootComplete: false,
  };

  private provisioningState: ProvisioningState = "idle";
  private terminalState: TerminalState = "detached";
  private recoveryState: RecoveryState = "healthy";

  private bootStartTimestamp: number | null = null;
  private lastTransitionTimestamp: number = 0;
  private transitionHistory: VMTransitionTrace[] = [];

  private static readonly DEBOUNCE_MS = 50;
  private static readonly MAX_HISTORY = 50;

  private static readonly VALID_TRANSITIONS: Record<VMStateName, Set<VMStateName>> = {
    idle:                new Set<VMStateName>(["loading", "stopped"]),
    loading:             new Set<VMStateName>(["booting", "ready", "error", "stopped"]),
    booting:             new Set<VMStateName>(["interactive", "fs9p_ready", "ready", "error", "stopped"]),
    interactive:         new Set<VMStateName>(["fs9p_ready", "provisioning", "ready", "error", "stopped"]),
    fs9p_ready:          new Set<VMStateName>(["provisioning", "ready", "error", "stopped"]),
    provisioning:        new Set<VMStateName>(["shell_ready", "ready", "error", "stopped"]),
    shell_ready:         new Set<VMStateName>(["terminal_ready", "ready", "error", "stopped"]),
    terminal_ready:      new Set<VMStateName>(["ready", "error", "stopped"]),
    ready:               new Set<VMStateName>(["stopping", "stopped", "error", "provisioning"]),
    stopping:            new Set<VMStateName>(["stopped", "error"]),
    stopped:             new Set<VMStateName>(["idle", "loading", "booting"]),
    error:               new Set<VMStateName>(["idle", "loading", "booting", "stopped"]),
  };

  private static readonly VALID_PROVISIONING_TRANSITIONS: Record<ProvisioningState, Set<ProvisioningState>> = {
    idle:               new Set<ProvisioningState>(["preparing", "failed"]),
    preparing:          new Set<ProvisioningState>(["transferring", "failed"]),
    transferring:       new Set<ProvisioningState>(["executing", "failed"]),
    executing:          new Set<ProvisioningState>(["waiting_completion", "failed"]),
    waiting_completion: new Set<ProvisioningState>(["completed", "failed", "recovering"]),
    completed:          new Set<ProvisioningState>(["idle"]),
    failed:             new Set<ProvisioningState>(["idle", "preparing", "recovering"]),
    recovering:         new Set<ProvisioningState>(["preparing", "completed", "failed"])
  };

  private static readonly VALID_TERMINAL_TRANSITIONS: Record<TerminalState, Set<TerminalState>> = {
    detached:    new Set<TerminalState>(["attached", "recovering"]),
    attached:    new Set<TerminalState>(["interactive", "detached", "recovering"]),
    interactive: new Set<TerminalState>(["detached", "recovering"]),
    recovering:  new Set<TerminalState>(["attached", "interactive", "detached"])
  };

  private static readonly VALID_RECOVERY_TRANSITIONS: Record<RecoveryState, Set<RecoveryState>> = {
    healthy:    new Set<RecoveryState>(["recovering", "degraded", "info", "fatal"]),
    recovering: new Set<RecoveryState>(["healthy", "degraded", "crashloop", "info", "fatal"]),
    degraded:   new Set<RecoveryState>(["healthy", "recovering", "crashloop", "info", "fatal"]),
    crashloop:  new Set<RecoveryState>(["healthy"]),
    info:       new Set<RecoveryState>(["healthy", "recovering", "degraded", "fatal"]),
    fatal:      new Set<RecoveryState>(["healthy", "recovering", "degraded", "crashloop"]),
  };

  public transitionTo(
    newState: VMStateName,
    ramBytes?: number,
    source?: string,
    workerEvent?: string,
    snapshot?: VMSnapshotMetadata,
  ): boolean {
    const oldState = this.currentState.state;

    if (oldState === newState) return true;

    const allowed = VMLifecycleManager.VALID_TRANSITIONS[oldState]?.has(newState) ?? false;

    const trace: VMTransitionTrace = {
      timestamp: Date.now(),
      from: oldState,
      to: newState,
      source: source ?? "unknown",
      allowed,
      workerEvent,
      snapshot,
    };
    this.transitionHistory.push(trace);
    if (this.transitionHistory.length > VMLifecycleManager.MAX_HISTORY) {
      this.transitionHistory.shift();
    }

    Logger.vmTransition(oldState, newState, allowed, source, workerEvent);

    if (!allowed) {
      Logger.warn(
        "VM",
        `[FSM REJECT] ${oldState} -> ${newState} is not a valid transition. ` +
        `Allowed targets from '${oldState}': [${Array.from(VMLifecycleManager.VALID_TRANSITIONS[oldState]).join(", ")}]`,
        { source, workerEvent },
      );
      return false;
    }

    const now = Date.now();
    if (now - this.lastTransitionTimestamp < VMLifecycleManager.DEBOUNCE_MS) {
      Logger.debug(
        "VM",
        `Rapid transition: ${oldState} -> ${newState} within ${VMLifecycleManager.DEBOUNCE_MS}ms (source: ${source})`,
      );
    }

    this.currentState.state = newState;
    this.currentState.lastActiveTimestamp = now;
    this.lastTransitionTimestamp = now;

    if (ramBytes !== undefined) {
      this.currentState.ramUsageBytes = ramBytes;
    }

    if (newState === "loading") {
      this.bootStartTimestamp = now;
    } else if (newState === "ready" && this.bootStartTimestamp) {
      this.currentState.bootTimeMs = now - this.bootStartTimestamp;
      this.bootStartTimestamp = null;
    }

    return true;
  }

  public transitionRuntimeTo(newState: VMRuntimeState, source?: string): boolean {
    return this.transitionTo(newState, undefined, source);
  }

  public transitionProvisioningTo(newState: ProvisioningState, source?: string): boolean {
    const oldState = this.provisioningState;
    if (oldState === newState) return true;

    const allowed = VMLifecycleManager.VALID_PROVISIONING_TRANSITIONS[oldState]?.has(newState) ?? false;
    if (!allowed) {
      Logger.warn("VM", `[FSM REJECT] Provisioning substate transition: ${oldState} -> ${newState} rejected. (source: ${source})`);
      return false;
    }

    Logger.info("VM", `[FSM transition] Provisioning substate: ${oldState} -> ${newState} (source: ${source})`);
    this.provisioningState = newState;
    return true;
  }

  public transitionTerminalTo(newState: TerminalState, source?: string): boolean {
    const oldState = this.terminalState;
    if (oldState === newState) return true;

    const allowed = VMLifecycleManager.VALID_TERMINAL_TRANSITIONS[oldState]?.has(newState) ?? false;
    if (!allowed) {
      Logger.warn("VM", `[FSM REJECT] Terminal substate transition: ${oldState} -> ${newState} rejected. (source: ${source})`);
      return false;
    }

    Logger.info("VM", `[FSM transition] Terminal substate: ${oldState} -> ${newState} (source: ${source})`);
    this.terminalState = newState;
    return true;
  }

  public transitionRecoveryTo(newState: RecoveryState, source?: string): boolean {
    const oldState = this.recoveryState;
    if (oldState === newState) return true;

    const allowed = VMLifecycleManager.VALID_RECOVERY_TRANSITIONS[oldState]?.has(newState) ?? false;
    if (!allowed) {
      Logger.warn("VM", `[FSM REJECT] Recovery substate transition: ${oldState} -> ${newState} rejected. (source: ${source})`);
      return false;
    }

    Logger.info("VM", `[FSM transition] Recovery substate: ${oldState} -> ${newState} (source: ${source})`);
    this.recoveryState = newState;
    return true;
  }

  public setBootComplete(val: boolean): void {
    this.currentState.bootComplete = val;
  }

  public getFullState(): VMFullState {
    return {
      runtime: this.currentState.state,
      provisioning: this.provisioningState,
      terminal: this.terminalState,
      recovery: this.recoveryState,
      bootComplete: !!this.currentState.bootComplete
    };
  }

  public getState(): VMState {
    return { ...this.currentState };
  }

  public getTransitionHistory(): Readonly<VMTransitionTrace[]> {
    return this.transitionHistory;
  }

  public isAlive(): boolean {
    return (
      this.currentState.state !== "idle" &&
      this.currentState.state !== "error" &&
      this.currentState.state !== "stopped"
    );
  }

  public isRunning(): boolean {
    return this.currentState.state === "ready";
  }

  public isBooting(): boolean {
    return (
      this.currentState.state === "loading" ||
      this.currentState.state === "booting" ||
      this.currentState.state === "interactive" ||
      this.currentState.state === "fs9p_ready" ||
      this.currentState.state === "provisioning" ||
      this.currentState.state === "shell_ready" ||
      this.currentState.state === "terminal_ready"
    );
  }
}
