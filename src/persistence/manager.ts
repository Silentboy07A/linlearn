// src/persistence/manager.ts

import { PersistenceDB, VMSnapshot } from "./db";
import { compressBuffer, decompressBuffer } from "./compressor";
import { Logger } from "../lib/logger";

export class PersistenceManager {
  private db: PersistenceDB;
  private lastSaveTime = 0;
  private saveThrottleMs = 15000; // Throttle: max once per 15s
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  private isSaving = false;

  constructor() {
    this.db = new PersistenceDB();
  }

  /**
   * Generates a SHA-256 hash of the buffer.
   */
  private async calculateChecksum(buffer: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Compress and save the current VM memory state.
   */
  public async saveState(id: string, rawState: ArrayBuffer): Promise<boolean> {
    if (this.isSaving) {
      Logger.warn("VM", "Skipping save: Save operation already in progress.");
      return false;
    }

    const now = Date.now();
    if (now - this.lastSaveTime < this.saveThrottleMs) {
      Logger.debug("VM", `Skipping save: Throttled (last save was ${((now - this.lastSaveTime) / 1000).toFixed(1)}s ago)`);
      return false;
    }

    this.isSaving = true;
    Logger.info("VM", `Initiating VM state persistence for session "${id}"`);

    try {
      const checksum = await this.calculateChecksum(rawState);
      const compressed = await compressBuffer(rawState);

      const snapshot: VMSnapshot = {
        id,
        version: "1.0",
        timestamp: Date.now(),
        data: compressed,
        checksum,
      };

      await this.db.saveSnapshot(snapshot);
      this.lastSaveTime = Date.now();
      Logger.info("VM", `VM state persisted successfully. Compressed size: ${(compressed.byteLength / 1024 / 1024).toFixed(2)}MB`);
      return true;
    } catch (err: unknown) {
      Logger.error("VM", "Failed to persist VM state", err);
      return false;
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Load and decompress the saved VM memory state.
   */
  public async loadState(id: string): Promise<ArrayBuffer | null> {
    Logger.info("VM", `Loading VM state snapshot for session "${id}"`);
    try {
      const snapshot = await this.db.getSnapshot(id);
      if (!snapshot) {
        Logger.info("VM", `No saved VM snapshot found for session "${id}"`);
        return null;
      }

      // Check version compatibility
      if (snapshot.version !== "1.0") {
        Logger.warn("VM", `Incompatible snapshot version: ${snapshot.version}. Discarding state.`);
        await this.db.deleteSnapshot(id);
        return null;
      }

      const decompressed = await decompressBuffer(snapshot.data);
      const computedChecksum = await this.calculateChecksum(decompressed);

      // Verify integrity checksum
      if (computedChecksum !== snapshot.checksum) {
        Logger.error("VM", `VM state snapshot integrity validation failed. Checksum mismatch!`);
        await this.db.deleteSnapshot(id);
        return null;
      }

      Logger.info("VM", `VM state snapshot successfully loaded and validated. Size: ${(decompressed.byteLength / 1024 / 1024).toFixed(2)}MB`);
      return decompressed;
    } catch (err: unknown) {
      Logger.error("VM", "Failed to load VM state snapshot due to runtime error", err);
      return null;
    }
  }

  /**
   * Clear any saved snapshot for a VM.
   */
  public async clearState(id: string): Promise<void> {
    Logger.info("VM", `Clearing persistent VM state for session "${id}"`);
    try {
      await this.db.deleteSnapshot(id);
    } catch (err: unknown) {
      Logger.error("VM", `Failed to delete VM snapshot "${id}"`, err);
    }
  }

  /**
   * Throttled & debounced autosave trigger to prevent lockouts while typing.
   */
  public triggerAutosave(id: string, saveCallback: () => Promise<ArrayBuffer | null>): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    this.saveDebounceTimer = setTimeout(async () => {
      const now = Date.now();
      if (now - this.lastSaveTime < this.saveThrottleMs) {
        return; // Throttled
      }

      try {
        const rawBuffer = await saveCallback();
        if (rawBuffer) {
          await this.saveState(id, rawBuffer);
        }
      } catch (err: unknown) {
        Logger.error("VM", "Autosave sequence failed", err);
      }
    }, 5000); // Debounce: 5 seconds after last activity
  }

  public cancelPendingSaves(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
  }

  public getSavingStatus(): boolean {
    return this.isSaving;
  }
}
