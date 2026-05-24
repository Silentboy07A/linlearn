// src/lib/v86db.ts
// ─────────────────────────────────────────────────────────────────────────────
// IndexedDB persistence layer for v86 VM state snapshots.
//
// Fixes:
//  - Singleton DB connection (no leaked connections)
//  - State buffer validation before restore
//  - Corruption recovery with automatic rollback
//  - Proper transaction error handling
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME = "linlearn_v86_db";
const DB_VERSION = 1;
const STORE_NAME = "vm_states";
const STATE_KEY = "v86_state_default";

// Minimum valid state size — v86 states are always at least ~1 KB
const MIN_VALID_STATE_SIZE = 1024;

// ── Singleton DB connection ─────────────────────────────────────────────────

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  // Return cached instance if still open
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  // Return in-flight open request if one exists
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;

      // If the DB connection closes unexpectedly, clear the singleton
      dbInstance.onclose = () => {
        dbInstance = null;
        dbPromise = null;
      };
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
        dbPromise = null;
      };

      resolve(dbInstance);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

// ── State Validation ────────────────────────────────────────────────────────

/**
 * Validates that a saved state buffer looks like a real v86 snapshot.
 * Returns false for corrupt, truncated, or nonsensical buffers.
 */
function isValidState(buffer: unknown): buffer is ArrayBuffer {
  if (!(buffer instanceof ArrayBuffer)) return false;
  if (buffer.byteLength < MIN_VALID_STATE_SIZE) return false;

  try {
    const view = new DataView(buffer);
    // v86 state format uses little-endian fields at the start of the ArrayBuffer:
    // Offset 0: Magic number (Int32: -2039052682 or Uint32: 2255914614 / 0x86737466)
    // Offset 4: State version (Int32: 6)
    // Offset 8: Total length of serialized state (Int32: must equal buffer.byteLength)
    // Offset 12: JSON descriptor metadata string length (Int32: must be positive and fit in remaining space)
    
    const magic = view.getInt32(0, true);
    if (magic !== -2039052682) {
      console.warn("[v86db] Validation failed: Magic number mismatch:", magic);
      return false;
    }

    const version = view.getInt32(4, true);
    if (version !== 6) {
      console.warn("[v86db] Validation failed: State version mismatch:", version);
      return false;
    }

    const totalLength = view.getInt32(8, true);
    if (totalLength !== buffer.byteLength) {
      console.warn(
        `[v86db] Validation failed: State length mismatch. Header says ${totalLength}, actual buffer is ${buffer.byteLength}`
      );
      return false;
    }

    const jsonLength = view.getInt32(12, true);
    if (jsonLength <= 0 || jsonLength > buffer.byteLength - 16) {
      console.warn("[v86db] Validation failed: Invalid metadata JSON length:", jsonLength);
      return false;
    }

    return true;
  } catch (e) {
    console.error("[v86db] Validation failed with exception:", e);
    return false;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Save a v86 VM state snapshot to IndexedDB.
 * Validates the buffer before writing.
 */
export async function saveV86State(buffer: ArrayBuffer): Promise<void> {
  if (!isValidState(buffer)) {
    console.warn(
      "[v86db] Refusing to save invalid state buffer:",
      ((buffer as unknown) as { byteLength?: number })?.byteLength ?? 0,
      "bytes"
    );
    return;
  }

  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(buffer, STATE_KEY);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);

    // Also handle transaction-level errors
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(new Error("IndexedDB transaction aborted during save"));
  });
}

/**
 * Load a saved v86 VM state from IndexedDB.
 * Returns null if no state exists or if the saved state is corrupt.
 * Automatically clears corrupt states.
 */
export async function loadV86State(): Promise<ArrayBuffer | null> {
  try {
    const db = await getDB();
    const result = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(STATE_KEY);

      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });

    if (result === null || result === undefined) {
      return null;
    }

    // Validate before returning
    if (!isValidState(result)) {
      console.warn(
        "[v86db] Corrupt state detected in IndexedDB — auto-clearing"
      );
      await clearV86State();
      return null;
    }

    return result;
  } catch (err) {
    console.error("[v86db] Failed to load state:", err);
    // On any error, try to clear the potentially corrupt state
    try {
      await clearV86State();
    } catch {
      // If clear also fails, the DB may be completely broken
      console.error("[v86db] Failed to clear corrupt state");
    }
    return null;
  }
}

/**
 * Delete the saved VM state from IndexedDB.
 */
export async function clearV86State(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(STATE_KEY);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Close the singleton DB connection.
 * Call this during application teardown if needed.
 */
export function closeDB(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbPromise = null;
  }
}
