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

  public transitionTo(newState: VMState["state"], ramBytes?: number): void {
    const oldState = this.currentState.state;
    if (oldState === newState) return;

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
      this.currentState.state !== "failed" &&
      this.currentState.state !== "destroyed"
    );
  }
}
