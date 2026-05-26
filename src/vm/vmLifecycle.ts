// src/vm/vmLifecycle.ts
import { VMState } from "../lib/types";
import { Logger } from "../lib/logger";

export class VMLifecycleManager {
  private currentState: VMState = {
    state: "idle",
    lastActiveTimestamp: Date.now(),
    ramUsageBytes: 0,
  };

  private bootStartTimestamp: number | null = null;
  private lastTransitionTimestamp: number = 0;

  private static readonly DEBOUNCE_MS = 50;

  private static readonly VALID_TRANSITIONS: Record<VMState["state"], Set<VMState["state"]>> = {
    idle: new Set<VMState["state"]>(["loading", "stopped"]),
    loading: new Set<VMState["state"]>(["booting", "error", "stopped"]),
    booting: new Set<VMState["state"]>(["provisioning", "running", "error", "stopped"]),
    provisioning: new Set<VMState["state"]>(["running", "error", "stopped"]),
    running: new Set<VMState["state"]>(["stopping", "stopped", "error"]),
    stopping: new Set<VMState["state"]>(["stopped", "error"]),
    stopped: new Set<VMState["state"]>(["idle", "loading"]),
    error: new Set<VMState["state"]>(["idle", "loading", "stopped"]),
  };

  /**
   * Attempt a validated lifecycle transition.
   * @param newState   Target state
   * @param ramBytes   Optional RAM usage update
   * @param source     Human-readable source for structured logging
   * @throws Error if the transition is not allowed by the FSM
   */
  public transitionTo(newState: VMState["state"], ramBytes?: number, source?: string): void {
    const oldState = this.currentState.state;
    if (oldState === newState) return;

    const allowed = VMLifecycleManager.VALID_TRANSITIONS[oldState]?.has(newState);

    // Structured transition log
    Logger.vmTransition(oldState, newState, !!allowed, source);

    if (!allowed) {
      throw new Error(`Invalid VM Lifecycle Transition: ${oldState} -> ${newState}`);
    }

    // Debounce: warn on rapid transitions but still allow them
    const now = Date.now();
    if (now - this.lastTransitionTimestamp < VMLifecycleManager.DEBOUNCE_MS) {
      Logger.debug("VM", `Rapid transition detected: ${oldState} -> ${newState} within ${VMLifecycleManager.DEBOUNCE_MS}ms`);
    }

    this.currentState.state = newState;
    this.currentState.lastActiveTimestamp = now;
    this.lastTransitionTimestamp = now;

    if (ramBytes !== undefined) {
      this.currentState.ramUsageBytes = ramBytes;
    }

    if (newState === "loading") {
      this.bootStartTimestamp = Date.now();
    } else if (newState === "running" && this.bootStartTimestamp) {
      this.currentState.bootTimeMs = Date.now() - this.bootStartTimestamp;
      this.bootStartTimestamp = null;
    }
  }

  public getState(): VMState {
    return { ...this.currentState };
  }

  public isAlive(): boolean {
    return (
      this.currentState.state !== "idle" &&
      this.currentState.state !== "error" &&
      this.currentState.state !== "stopped"
    );
  }
}
