// src/vm/provisioningProtocol.ts
// ─── Provisioning Transport Protocol ─────────────────────────────────────────
// Defines the structured framing protocol for atomic provisioning.
// All large payloads travel as PROVISION_* messages over the host↔worker
// message bus — NOT over the serial PTY. Only a single short trigger command
// (≤ 16 bytes) is ever written to ttyS0.

// ─── Constants ─────────────────────────────────────────────────────────────
// Max bytes per text chunk sent to the worker.
// 4KB is safely below the v86 postMessage copy overhead and keeps latency low.
export const PROVISION_CHUNK_SIZE = 4096;

// Max binary chunk size for backup blob transfers (must fit in structured clone)
export const PROVISION_BINARY_CHUNK_SIZE = 32768; // 32KB

// Max number of ACK retries per chunk before declaring transfer failure
export const PROVISION_MAX_CHUNK_RETRIES = 3;

// Timeout (ms) to receive PROVISION_ACK for a single chunk
export const PROVISION_CHUNK_ACK_TIMEOUT_MS = 5000;

// ─── Transport FSM States ───────────────────────────────────────────────────
export type ProvisionTransportState =
  | "idle"
  | "preparing"           // Building chunk list on the host
  | "writing_backup"      // Sending binary restore backup to worker FS
  | "sending_script"      // ACK-gated chunk streaming to worker
  | "awaiting_write"      // Waiting for worker to write script to VM FS
  | "awaiting_execute"    // Waiting for worker to confirm serial trigger sent
  | "executing"           // Shell script running in VM
  | "awaiting_complete"   // Waiting for completion marker from ttyS0
  | "completed"
  | "failed"
  | "cancelling";

// ─── Protocol Message Payloads ─────────────────────────────────────────────

export interface ProvisionBeginPayload {
  execId: number;
  generation: number;
  totalChunks: number;
  totalBytes: number;
}

export interface ProvisionChunkPayload {
  execId: number;
  generation: number;
  chunkIndex: number;
  totalChunks: number;
  data: string;
  checksum: number;
}

export interface ProvisionEndPayload {
  execId: number;
  generation: number;
  chunkCount: number;
}

export interface ProvisionWritePayload {
  execId: number;
  generation: number;
  filePath: string;
}

export interface ProvisionWriteBinaryPayload {
  execId: number;
  generation: number;
  filePath: string;
  // Binary data as Uint8Array — travels via structured clone (no base64)
  data: Uint8Array;
}

export interface ProvisionExecutePayload {
  execId: number;
  generation: number;
  filePath: string;
  verifiedInode?: string;
  fallbackRequired?: boolean;
}

export interface ProvisionCancelPayload {
  execId: number;
  generation: number;
}

export interface ProvisionAckPayload {
  type: "begin" | "chunk" | "end" | "write" | "write_binary" | "execute" | "cancel";
  execId: number;
  chunkIndex?: number;
}

export interface ProvisionNackPayload {
  execId: number;
  chunkIndex?: number;
  reason: string;
}

export interface ProvisionReadyPayload {
  execId: number;
  generation: number;
  filePath: string;
  telemetry?: {
    fsReadyTimestamp: number;
    writeLatencyMs: number;
    filePath: string;
    fileSize: number;
    verified: boolean;
    guestVisible?: boolean;
    fallbackRequired?: boolean;
    mountSuccess?: boolean;
    propagationLatencyMs?: number;
    retryCount?: number;
    guestVisibilityTimingMs?: number;
    remountAttempts?: number;
    verifiedInode?: string;
  };
}

// ─── Utility: XOR checksum ─────────────────────────────────────────────────
// Fast, cheap integrity check for each text chunk.
// Not cryptographic — purely for corruption detection on the message bus.
export function computeChecksum(data: string): number {
  let cs = 0;
  for (let i = 0; i < data.length; i++) {
    cs ^= data.charCodeAt(i);
  }
  return cs;
}

// ─── Utility: Script chunker ───────────────────────────────────────────────
// Splits a script string into a framed chunk list ready for streaming.
export interface ChunkedScript {
  begin: ProvisionBeginPayload;
  chunks: ProvisionChunkPayload[];
  end: ProvisionEndPayload;
}

export function chunkScript(
  script: string,
  execId: number,
  generation: number
): ChunkedScript {
  const chunks: ProvisionChunkPayload[] = [];
  const totalChunks = Math.max(1, Math.ceil(script.length / PROVISION_CHUNK_SIZE));

  for (let i = 0; i < totalChunks; i++) {
    const segment = script.slice(i * PROVISION_CHUNK_SIZE, (i + 1) * PROVISION_CHUNK_SIZE);
    chunks.push({
      execId,
      generation,
      chunkIndex: i,
      totalChunks,
      data: segment,
      checksum: computeChecksum(segment),
    });
  }

  return {
    begin: {
      execId,
      generation,
      totalChunks,
      totalBytes: script.length,
    },
    chunks,
    end: {
      execId,
      generation,
      chunkCount: totalChunks,
    },
  };
}

// ─── Utility: Binary chunker ────────────────────────────────────────────────
// Splits a binary backup blob into transfer chunks.
// Each chunk carries a Uint8Array slice (structured clone, no base64).
export interface BinaryChunkResult {
  filePath: string;
  chunks: ProvisionWriteBinaryPayload[];
}

export function chunkBinary(
  data: Uint8Array,
  filePath: string,
  execId: number,
  generation: number
): BinaryChunkResult {
  const chunks: ProvisionWriteBinaryPayload[] = [];
  const totalChunks = Math.max(1, Math.ceil(data.byteLength / PROVISION_BINARY_CHUNK_SIZE));

  // For simplicity we send the entire binary as a single write since
  // create_file() on the worker side accepts a complete Uint8Array.
  // The structured clone algorithm handles the transfer efficiently.
  chunks.push({
    execId,
    generation,
    filePath,
    data,
  });

  void totalChunks; // Reserved for future multi-chunk binary streaming

  return { filePath, chunks };
}
