// src/vm/vmLifecycle.ts
import { VMState, VMStateName, VMTransitionTrace, VMSnapshotMetadata } from "../lib/types";
import { Logger } from "../lib/logger";

export class VMLifecycleManager {
  private currentState: VMState = {
    state: "idle",
    lastActiveTimestamp: Date.now(),
    ramUsageBytes: 0,
  };

  private bootStartTimestamp: number | null = null;
  private lastTransitionTimestamp: number = 0;
  private transitionHistory: VMTransitionTrace[] = [];

  private static readonly DEBOUNCE_MS = 50;
  private static readonly MAX_HISTORY = 50;

  /**
   * Corrected FSM transition map.
   *
   * Key additions over the previous strict version:
   *  - loading -> running   : instant snapshot restore path (INIT_SUCCESS with initialState)
   *  - loading -> booting   : normal cold-boot path (already existed)
   *  - error   -> booting   : retry after failure
   *  - stopped -> booting   : direct restart without going back to idle
   *
   * All states can still reach "stopped" or "error" as emergency exits.
   */
  private static readonly VALID_TRANSITIONS: Record<VMStateName, Set<VMStateName>> = {
    idle:         new Set<VMStateName>(["loading", "stopped"]),
    loading:      new Set<VMStateName>(["booting", "running", "error", "stopped"]),
    booting:      new Set<VMStateName>(["provisioning", "running", "error", "stopped"]),
    provisioning: new Set<VMStateName>(["running", "error", "stopped"]),
    running:      new Set<VMStateName>(["stopping", "stopped", "error"]),
    stopping:     new Set<VMStateName>(["stopped", "error"]),
    stopped:      new Set<VMStateName>(["idle", "loading", "booting"]),
    error:        new Set<VMStateName>(["idle", "loading", "booting", "stopped"]),
  };

  /**
   * Attempt a validated lifecycle transition.
   * Returns true if the transition succeeded, false if it was rejected.
   * Never throws — callers should handle false gracefully.
   *
   * @param newState       Target state
   * @param ramBytes       Optional RAM usage update
   * @param source         Human-readable source for structured logging
   * @param workerEvent    Optional originating worker message type
   * @param snapshot       Optional snapshot metadata for trace
   */
  public transitionTo(
    newState: VMStateName,
    ramBytes?: number,
    source?: string,
    workerEvent?: string,
    snapshot?: VMSnapshotMetadata,
  ): boolean {
    const oldState = this.currentState.state;

    // Silently ignore same-state no-ops (prevents log spam)
    if (oldState === newState) return true;

    const allowed = VMLifecycleManager.VALID_TRANSITIONS[oldState]?.has(newState) ?? false;

    // Record into rolling trace history (capped at MAX_HISTORY)
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

    // Structured transition log
    Logger.vmTransition(oldState, newState, allowed, source, workerEvent);

    if (!allowed) {
      // Warn, but do NOT throw — let the caller decide how to handle the rejection
      Logger.warn(
        "VM",
        `[FSM REJECT] ${oldState} -> ${newState} is not a valid transition. ` +
        `Allowed targets from '${oldState}': [${Array.from(VMLifecycleManager.VALID_TRANSITIONS[oldState]).join(", ")}]`,
        { source, workerEvent },
      );
      return false;
    }

    // Debounce: warn on suspiciously rapid transitions but still allow them
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

    // Boot timing
    if (newState === "loading") {
      this.bootStartTimestamp = now;
    } else if (newState === "running" && this.bootStartTimestamp) {
      this.currentState.bootTimeMs = now - this.bootStartTimestamp;
      this.bootStartTimestamp = null;
    }

    return true;
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

  /** True only while actively executing guest code */
  public isRunning(): boolean {
    return this.currentState.state === "running";
  }

  /** True while any boot/provision phase is active */
  public isBooting(): boolean {
    return (
      this.currentState.state === "loading" ||
      this.currentState.state === "booting" ||
      this.currentState.state === "provisioning"
    );
  }
}
