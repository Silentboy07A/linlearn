// src/services/v86/emulatorManager.ts
import { log } from "./logger";

export interface V86StarterConfig {
  wasm_path: string;
  bios?: { buffer: ArrayBuffer };
  vga_bios?: { buffer: ArrayBuffer };
  bzimage?: { buffer: ArrayBuffer };
  initrd?: { buffer: ArrayBuffer };
  cmdline?: string;
  autostart: boolean;
  memory_size?: number;
  vga_memory_size?: number;
  filesystem?: unknown;
  initial_state?: { buffer: ArrayBuffer };
}

export interface V86StarterInstance {
  serial0_send: (data: string) => void;
  add_listener: (event: string, cb: (...args: unknown[]) => void) => void;
  remove_listener: (event: string, cb: (...args: unknown[]) => void) => void;
  destroy: () => void | Promise<void>;
  stop: () => Promise<void>;
  restart: () => void;
  save_state: () => Promise<ArrayBuffer>;
}

export interface WindowWithV86 {
  V86: new (config: V86StarterConfig) => V86StarterInstance;
}

interface DedicatedWorkerGlobal {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

let emulator: V86StarterInstance | null = null;

export function getEmulator(): V86StarterInstance | null {
  return emulator;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function createEmulator(config: V86StarterConfig, win: WindowWithV86) {
  if (emulator) {
    log("warn", "Pre-existing emulator instance found. Destroying it first to avoid memory leaks.");
    await destroyEmulator();
  }

  log("info", "Instantiating v86 emulator...");
  try {
    const finalConfig: V86StarterConfig = {
      ...config,
      memory_size: Math.min(config.memory_size || 64 * 1024 * 1024, 128 * 1024 * 1024),
      vga_memory_size: Math.min(config.vga_memory_size || 8 * 1024 * 1024, 16 * 1024 * 1024),
      autostart: true,
    };

    log("debug", `Configuring VM: RAM=${finalConfig.memory_size! / (1024 * 1024)}MB, VGA RAM=${finalConfig.vga_memory_size! / (1024 * 1024)}MB`);
    
    const inst = new win.V86(finalConfig);
    emulator = inst;

    inst.add_listener("serial0-output-byte", (byte: unknown) => {
      (self as unknown as DedicatedWorkerGlobal).postMessage({ type: "SERIAL_OUT", payload: byte });
    });

    log("info", "v86 emulator successfully created.");
  } catch (err: unknown) {
    emulator = null;
    const msg = `Failed to create emulator instance: ${getErrorMessage(err)}`;
    log("error", msg);
    throw new Error(msg);
  }
}

export async function destroyEmulator() {
  if (emulator) {
    log("info", "Destroying active emulator instance...");
    try {
      await emulator.destroy();
      log("info", "Emulator instance destroyed successfully.");
    } catch (err: unknown) {
      log("warn", `Error while destroying emulator (non-fatal): ${getErrorMessage(err)}`);
    }
    emulator = null;
  }
}
