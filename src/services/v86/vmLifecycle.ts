// src/services/v86/vmLifecycle.ts
import { log } from "./logger";

export type EmulatorState = "idle" | "loading" | "booting" | "provisioning" | "shell_ready" | "terminal_ready" | "running" | "stopping" | "stopped" | "error";

interface DedicatedWorkerGlobal {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

let lifecycleState: EmulatorState = "idle";
let isBootingInProgress = false;
let lastTransitionTimestamp = 0;

// ─── Valid transition map (deterministic FSM) ───────────────────────────────
const VALID_TRANSITIONS: Record<EmulatorState, Set<EmulatorState>> = {
  idle:         new Set<EmulatorState>(["loading", "stopped"]),
  loading:      new Set<EmulatorState>(["booting", "running", "error", "stopped"]),
  booting:      new Set<EmulatorState>(["provisioning", "running", "error", "stopped"]),
  provisioning: new Set<EmulatorState>(["shell_ready", "running", "error", "stopped"]),
  shell_ready:  new Set<EmulatorState>(["terminal_ready", "error", "stopped"]),
  terminal_ready: new Set<EmulatorState>(["running", "error", "stopped"]),
  running:      new Set<EmulatorState>(["stopping", "stopped", "error"]),
  stopping:     new Set<EmulatorState>(["stopped", "error"]),
  stopped:      new Set<EmulatorState>(["idle", "loading", "booting"]),
  error:        new Set<EmulatorState>(["idle", "loading", "booting", "stopped"]),
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
  return lifecycleState === "running";
}

export function canSendInput(): boolean {
  return lifecycleState === "booting" || lifecycleState === "provisioning" || lifecycleState === "shell_ready" || lifecycleState === "terminal_ready" || lifecycleState === "running";
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
