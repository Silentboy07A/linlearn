// src/services/v86/vmLifecycle.ts
import { log } from "./logger";

export type EmulatorState = "idle" | "loading" | "booting" | "provision_preparing" | "provisioning" | "shell_ready" | "terminal_ready" | "ready" | "stopping" | "stopped" | "error";

interface DedicatedWorkerGlobal {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

let lifecycleState: EmulatorState = "idle";
let isBootingInProgress = false;
let lastTransitionTimestamp = 0;

// ─── Valid transition map (deterministic FSM) ───────────────────────────────
const VALID_TRANSITIONS: Record<EmulatorState, Set<EmulatorState>> = {
  idle:                new Set<EmulatorState>(["loading", "stopped"]),
  loading:             new Set<EmulatorState>(["booting", "ready", "error", "stopped"]),
  booting:             new Set<EmulatorState>(["provision_preparing", "ready", "error", "stopped"]),
  provision_preparing: new Set<EmulatorState>(["provisioning", "ready", "error", "stopped"]),
  provisioning:        new Set<EmulatorState>(["shell_ready", "ready", "error", "stopped"]),
  shell_ready:         new Set<EmulatorState>(["terminal_ready", "ready", "error", "stopped"]),
  terminal_ready:      new Set<EmulatorState>(["ready", "error", "stopped"]),
  ready:               new Set<EmulatorState>(["stopping", "stopped", "error", "provisioning"]),
  stopping:            new Set<EmulatorState>(["stopped", "error"]),
  stopped:             new Set<EmulatorState>(["idle", "loading", "booting"]),
  error:               new Set<EmulatorState>(["idle", "loading", "booting", "stopped"]),
};

const DEBOUNCE_MS = 50;

export function getLifecycleState(): EmulatorState {
  return lifecycleState;
}

/**
 * Validated lifecycle transition with debounce and optional echo suppression.
 * @param newState  Target state
 * @param source    Human-readable origin for tracing (e.g. "handleInit", "SET_STATE msg")
 * @param silent    If true, suppress the STATE_CHANGED postMessage (breaks echo loop)
 * @returns true if transition was applied, false if blocked
 */
export function setLifecycleState(
  newState: EmulatorState,
  source: string = "unknown",
  silent: boolean = false
): boolean {
  if (lifecycleState === newState) return false;

  // Prevent backward transitions for the bootstrap-to-ready sequence
  const stateOrder: EmulatorState[] = ["idle", "loading", "booting", "provision_preparing", "provisioning", "shell_ready", "terminal_ready", "ready"];
  const currentIndex = stateOrder.indexOf(lifecycleState);
  const targetIndex = stateOrder.indexOf(newState);
  if (currentIndex !== -1 && targetIndex !== -1 && targetIndex < currentIndex) {
    log("warn", `[TRANSITION BLOCKED] Dropped backward transition: ${lifecycleState} -> ${newState} (source: ${source})`);
    return false;
  }

  // Validate transition
  const allowed = VALID_TRANSITIONS[lifecycleState]?.has(newState) ?? false;
  if (!allowed) {
    log("warn", `[TRANSITION BLOCKED] ${lifecycleState} -> ${newState} (source: ${source})`);
    return false;
  }

  // Debounce rapid duplicate transitions
  const now = Date.now();
  if (now - lastTransitionTimestamp < DEBOUNCE_MS) {
    log("debug", `[TRANSITION DEBOUNCED] ${lifecycleState} -> ${newState} within ${DEBOUNCE_MS}ms (source: ${source})`);
    // Still allow it if it's a genuine new state — debounce only blocks exact same transition bursts
  }

  const oldState = lifecycleState;
  lifecycleState = newState;
  lastTransitionTimestamp = now;
  log("info", `[TRANSITION] ${oldState} -> ${newState} (source: ${source})`);

  // Only broadcast to main thread if not a silent (echo-breaking) call
  if (!silent) {
    (self as unknown as DedicatedWorkerGlobal).postMessage({ type: "STATE_CHANGED", payload: newState });
  }
  return true;
}

export function setBootingInProgress(inProgress: boolean) {
  isBootingInProgress = inProgress;
}

export function isBooting(): boolean {
  return isBootingInProgress;
}

export function canInitialize(): boolean {
  return lifecycleState === "idle" || lifecycleState === "error" || lifecycleState === "stopped";
}

export function canSaveState(): boolean {
  return lifecycleState === "ready";
}

export function canSendInput(): boolean {
  return (
    lifecycleState === "terminal_ready" ||
    lifecycleState === "ready"
  );
}

/**
 * Reset lifecycle to idle (for hard cleanup scenarios).
 * Does NOT broadcast — used internally before re-init.
 */
export function resetLifecycleState(): void {
  const old = lifecycleState;
  lifecycleState = "idle";
  isBootingInProgress = false;
  lastTransitionTimestamp = 0;
  log("info", `[LIFECYCLE RESET] ${old} -> idle (hard reset)`);
}
