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

  private static readonly VALID_TRANSITIONS: Record<VMState["state"], Set<VMState["state"]>> = {
    idle: new Set<VMState["state"]>(["loading", "stopped"]),
    loading: new Set<VMState["state"]>(["booting", "error", "stopped"]),
    booting: new Set<VMState["state"]>(["provisioning", "running", "error", "stopped"]),
    provisioning: new Set<VMState["state"]>(["running", "error", "stopped"]),
    running: new Set<VMState["state"]>(["stopped", "error"]),
    stopped: new Set<VMState["state"]>(["idle", "loading"]),
    error: new Set<VMState["state"]>(["idle", "loading", "stopped"]),
  };

  public transitionTo(newState: VMState["state"], ramBytes?: number): void {
    const oldState = this.currentState.state;
    if (oldState === newState) return;

    const allowed = VMLifecycleManager.VALID_TRANSITIONS[oldState]?.has(newState);
    if (!allowed) {
      Logger.error("VM", `Lifecycle transition constraint violation: ${oldState} -> ${newState} is blocked.`);
      throw new Error(`Invalid VM Lifecycle Transition: ${oldState} -> ${newState}`);
    }

    this.currentState.state = newState;
    this.currentState.lastActiveTimestamp = Date.now();
    if (ramBytes !== undefined) {
      this.currentState.ramUsageBytes = ramBytes;
    }

    if (newState === "loading") {
      this.bootStartTimestamp = Date.now();
    } else if (newState === "running" && this.bootStartTimestamp) {
      this.currentState.bootTimeMs = Date.now() - this.bootStartTimestamp;
      this.bootStartTimestamp = null;
    }

    Logger.vmLifecycle(`VM Lifecycle transition: ${oldState} -> ${newState}`, this.currentState);
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
