// src/services/v86/vmLifecycle.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { log } from "./logger";

export type EmulatorState = "idle" | "loading" | "booting" | "provisioning" | "running" | "stopped" | "error";

let lifecycleState: EmulatorState = "idle";
let isBootingInProgress = false;

export function getLifecycleState(): EmulatorState {
  return lifecycleState;
}

export function setLifecycleState(newState: EmulatorState) {
  if (lifecycleState !== newState) {
    const oldState = lifecycleState;
    lifecycleState = newState;
    log("debug", `Lifecycle state transitioned: ${oldState} -> ${newState}`);
    (self as any).postMessage({ type: "STATE_CHANGED", payload: newState });
  }
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
  return lifecycleState === "booting" || lifecycleState === "provisioning" || lifecycleState === "running";
}
