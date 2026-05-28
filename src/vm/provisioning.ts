// src/vm/provisioning.ts
import { Logger } from "../lib/logger";
import { ProvisioningState } from "./vmLifecycle";
import {
  ProvisionTransportState,
  chunkScript,
  chunkBinary,
  PROVISION_CHUNK_ACK_TIMEOUT_MS,
  PROVISION_MAX_CHUNK_RETRIES,
  ProvisionAckPayload,
  ProvisionNackPayload,
  ProvisionReadyPayload,
} from "./provisioningProtocol";

// ─── Completion Parser ───────────────────────────────────────────────────────
// Parses the ttyS0 stream for provisioning lifecycle markers ONLY.
// All other serial noise is safely ignored. Base64 echo is gone entirely.

export class ProvisioningCompletionParser {
  private buffer = "";
  private provisioningBuffer = "";
  private executionBuffer = "";
  private state: "IDLE" | "VERIFY_BEGIN" | "FILE_VISIBLE" | "VERIFY_END" | "EXEC_START" | "SUCCESS" | "FAIL" = "IDLE";
  private currentExecId = -1;
  private currentEpoch = -1;
  private processedPackets = new Set<string>();
  private lastProcessedSequence = 0;
  private isExecutionMode = false;
  private currentPhaseTimestamp = Date.now();
  private lastFeedTimestamp = Date.now();
  private lastMarker = "none";

  public setActiveExecutionId(execId: number): void {
    this.currentExecId = execId;
    Logger.info("VM", `[Provisioning FSM] Active execution ID token established: ${execId}`);
  }

  public getState() {
    return this.state;
  }

  public getLastFeedTimestamp(): number {
    return this.lastFeedTimestamp;
  }

  public getLastMarker(): string {
    return this.lastMarker;
  }

  public feed(data: string, epoch = -1): { type: "complete" | "failed" | "heartbeat" | "shell_ready" | "exec_start"; id: number }[] {
    this.lastFeedTimestamp = Date.now();

    // 8. Strict lifecycle epoch ownership validation
    if (this.currentEpoch === -1 && epoch !== -1) {
      this.currentEpoch = epoch;
      Logger.info("VM", `[Provisioning FSM] [Telemetry] Parser epoch established: ${epoch}`);
    }
    if (epoch !== -1 && this.currentEpoch !== -1 && epoch !== this.currentEpoch) {
      Logger.warn("VM", `[Provisioning FSM] [Telemetry] Ignored replay fragment from stale epoch ${epoch} (current=${this.currentEpoch})`);
      return [];
    }

    // Accumulate stream data to the correct buffer
    if (this.isExecutionMode) {
      this.executionBuffer += data;
      if (this.executionBuffer.length > 8192) {
        this.executionBuffer = this.executionBuffer.slice(-8192);
      }
    } else {
      this.provisioningBuffer += data;
      if (this.provisioningBuffer.length > 8192) {
        this.provisioningBuffer = this.provisioningBuffer.slice(-8192);
      }
    }

    const rawLines = this.isExecutionMode ? this.executionBuffer : this.provisioningBuffer;
    const completedLines = rawLines.split("\n");
    const remaining = completedLines.pop() ?? "";

    if (this.isExecutionMode) {
      this.executionBuffer = remaining;
    } else {
      this.provisioningBuffer = remaining;
    }
    this.buffer = remaining; // Sync public property

    const results: { type: "complete" | "failed" | "heartbeat" | "shell_ready" | "exec_start"; id: number }[] = [];

    for (const rawLine of completedLines) {
      let line = this.sanitize(rawLine);

      // 1. Harden EXECUTION_MODE isolation & Parser Hard Barrier
      if (this.isExecutionMode) {
        line = line.replace(/<<<(FSM|EXEC_REVAL|VERIFYING|MOUNTING):[^>]*>>>/g, (match) => {
          Logger.info("VM", `[Provisioning FSM] [Telemetry] Ignored stale FSM/verification marker during execution phase: ${match}`);
          return "";
        });
      }

      // Parse standalone STAGE:EXEC_START: <<<STAGE:EXEC_START>>>
      if (line.includes("<<<STAGE:EXEC_START>>>")) {
        const oldState = this.state;
        this.state = "EXEC_START";
        this.isExecutionMode = true;
        this.lastMarker = "STAGE:EXEC_START";
        results.push({ type: "exec_start", id: this.currentExecId });
        Logger.info("VM", `[Provisioning FSM] State transition SUCCESS (STAGE:EXEC_START): ${oldState} -> EXEC_START for execId=${this.currentExecId}`);
        line = line.replace("<<<STAGE:EXEC_START>>>", "");
      }

      // Parse standalone STAGE:PROVISION_READY: <<<STAGE:PROVISION_READY>>>
      if (line.includes("<<<STAGE:PROVISION_READY>>>")) {
        const oldState = this.state;
        this.state = "SUCCESS";
        this.lastMarker = "STAGE:PROVISION_READY";
        results.push({ type: "complete", id: this.currentExecId });
        Logger.info("VM", `[Provisioning FSM] State transition SUCCESS (STAGE:PROVISION_READY): ${oldState} -> SUCCESS for execId=${this.currentExecId}`);
        line = line.replace("<<<STAGE:PROVISION_READY>>>", "");
      }

      // Parse standalone EXEC_START: <<<EXEC_START:id>>>
      const execStartRegex = /<<<EXEC_START:(\d+)>>>/g;
      let startMatch;
      while ((startMatch = execStartRegex.exec(line)) !== null) {
        const raw = startMatch[0];
        const execId = parseInt(startMatch[1], 10);
        this.lastMarker = "EXEC_START:" + execId;
        
        // Strict execId validation (Requirement 8)
        if (this.currentExecId !== -1 && execId !== this.currentExecId) {
          Logger.info("VM", `[Provisioning FSM] [Telemetry] Rejected EXEC_START due to execId mismatch: incoming ${execId} !== current ${this.currentExecId}`);
          line = line.replace(raw, "");
          continue;
        }

        if (this.state === "IDLE" || this.state === "VERIFY_BEGIN" || this.state === "FILE_VISIBLE" || this.state === "VERIFY_END" || this.state === "EXEC_START") {
          const oldState = this.state;
          this.state = "EXEC_START";
          this.isExecutionMode = true;
          results.push({ type: "exec_start", id: execId });
          Logger.info("VM", `[Provisioning FSM] State transition SUCCESS (EXEC_START): ${oldState} -> EXEC_START for execId=${execId}`);
        }
        line = line.replace(raw, "");
      }

      // Parse standalone EXEC_COMPLETE: <<<EXEC_COMPLETE:id:code>>>
      const execCompleteRegex = /<<<EXEC_COMPLETE:(\d+):([^>]+)>>>/g;
      let completeMatch;
      while ((completeMatch = execCompleteRegex.exec(line)) !== null) {
        const raw = completeMatch[0];
        const execId = parseInt(completeMatch[1], 10);
        const code = completeMatch[2];
        this.lastMarker = "EXEC_COMPLETE:" + execId + ":" + code;

        // Strict execId validation (Requirement 8)
        if (this.currentExecId !== -1 && execId !== this.currentExecId) {
          Logger.info("VM", `[Provisioning FSM] [Telemetry] Rejected EXEC_COMPLETE due to execId mismatch: incoming ${execId} !== current ${this.currentExecId}`);
          line = line.replace(raw, "");
          continue;
        }

        const oldState = this.state;
        if (code === "0") {
          this.state = "SUCCESS";
          results.push({ type: "complete", id: execId });
          Logger.info("VM", `[Provisioning FSM] State transition SUCCESS (EXEC_COMPLETE): ${oldState} -> SUCCESS for execId=${execId} (exit code 0)`);
        } else {
          this.state = "FAIL";
          results.push({ type: "failed", id: execId });
          Logger.error("VM", `[Provisioning FSM] State transition SUCCESS (EXEC_COMPLETE FAILURE): ${oldState} -> FAIL for execId=${execId}. Code: ${code}`);
        }
        line = line.replace(raw, "");
      }

      // Parse standalone LLVM_PROVISION_COMPLETE: <<<LLVM_PROVISION_COMPLETE>>> or <<<LLVM_PROVISION_COMPLETE:execId>>>
      const llvmCompleteRegex = /<<<LLVM_PROVISION_COMPLETE(?::(\d+))?>>>/g;
      let llvmMatch;
      while ((llvmMatch = llvmCompleteRegex.exec(line)) !== null) {
        const raw = llvmMatch[0];
        const execId = llvmMatch[1] ? parseInt(llvmMatch[1], 10) : this.currentExecId;
        this.lastMarker = "LLVM_PROVISION_COMPLETE:" + execId;

        // Strict execId validation (Requirement 8)
        if (this.currentExecId !== -1 && execId !== this.currentExecId) {
          Logger.info("VM", `[Provisioning FSM] [Telemetry] Rejected LLVM_PROVISION_COMPLETE due to execId mismatch: incoming ${execId} !== current ${this.currentExecId}`);
          line = line.replace(raw, "");
          continue;
        }

        const oldState = this.state;
        this.state = "SUCCESS";
        results.push({ type: "complete", id: execId });
        Logger.info("VM", `[Provisioning FSM] State transition SUCCESS (LLVM_PROVISION_COMPLETE): ${oldState} -> SUCCESS for execId=${execId}`);
        line = line.replace(raw, "");
      }

      // Regex to match <<<PROTO:execId:sequence:ACTION(:reason)>>>
      const protoRegex = /<<<PROTO:(\d+):(\d+):([A-Z_]+)(?::([^>]*))?>>>/g;
      let match;
      const matchesToReplace: { raw: string; action: string; execId: number; sequence: number; reason?: string }[] = [];

      while ((match = protoRegex.exec(line)) !== null) {
        const raw = match[0];
        const execId = parseInt(match[1], 10);
        const sequence = parseInt(match[2], 10);
        const action = match[3];
        const reason = match[4];

        matchesToReplace.push({ raw, action, execId, sequence, reason });
      }

      for (const item of matchesToReplace) {
        const { raw, action, execId, sequence, reason } = item;
        this.lastMarker = "PROTO:" + execId + ":" + action;

        // Strict execId validation (Requirement 8)
        if (this.currentExecId !== -1 && execId !== this.currentExecId) {
          Logger.info("VM", `[Provisioning FSM] [Telemetry] Rejected PROTO marker due to execId mismatch: incoming ${execId} !== current ${this.currentExecId} (${action})`);
          line = line.replace(raw, "");
          continue;
        }

        // 2. Execution-Phase Parser Mode Isolation & Filtering
        if (this.isExecutionMode) {
          if (action !== "EXEC_START" && action !== "EXEC_COMPLETE" && action !== "LLVM_PROVISION_COMPLETE" && action !== "HEARTBEAT" && action !== "SHELL_READY" && action !== "FAIL") {
            Logger.info("VM", `[Provisioning FSM] [Telemetry] Execution-only filter dropped: ${action} for execId=${execId}`);
            line = line.replace(raw, "");
            continue;
          }
        }

        // 3. Packet Deduplication
        const packetKey = `${execId}:${sequence}:${action}`;
        if (action !== "HEARTBEAT" && this.processedPackets.has(packetKey)) {
          Logger.debug("VM", `[Provisioning FSM] Ignored duplicate packet '${action}' (seq=${sequence}) for execId=${execId}`);
          line = line.replace(raw, "");
          continue;
        }

        // 4. Packet Sequence Ordering Validation
        if (action !== "HEARTBEAT" && sequence <= this.lastProcessedSequence) {
          Logger.warn("VM", `[Provisioning FSM] Ignored out-of-order/stale packet '${action}' with sequence ${sequence} (last processed: ${this.lastProcessedSequence})`);
          line = line.replace(raw, "");
          continue;
        }
        if (action === "HEARTBEAT" && sequence < this.lastProcessedSequence) {
          Logger.warn("VM", `[Provisioning FSM] Ignored stale heartbeat with sequence ${sequence} (last processed: ${this.lastProcessedSequence})`);
          line = line.replace(raw, "");
          continue;
        }

        // 5. Stale Frame TTL Check (15 seconds verification phase timeout protection)
        const isVerificationAction = action === "BEGIN" || action === "FILE_VISIBLE" || action === "VERIFY_END";
        if (isVerificationAction && (Date.now() - this.currentPhaseTimestamp > 15000)) {
          Logger.warn("VM", `[Provisioning FSM] Discarded stale verification marker '${action}' exceeding TTL`);
          line = line.replace(raw, "");
          continue;
        }

        // Validate transitions
        let transitionAllowed = false;
        const oldState = this.state;
        let rejectionReason = "";

        if (action === "BEGIN") {
          if (this.state === "IDLE") {
            this.state = "VERIFY_BEGIN";
            transitionAllowed = true;
          } else {
            rejectionReason = `FSM state not IDLE (current state: ${this.state})`;
          }
        } else if (action === "FILE_VISIBLE") {
          if (this.state === "VERIFY_BEGIN") {
            this.state = "FILE_VISIBLE";
            transitionAllowed = true;
          } else {
            rejectionReason = `FSM state not VERIFY_BEGIN (current state: ${this.state})`;
          }
        } else if (action === "VERIFY_END") {
          if (this.state === "VERIFY_BEGIN" || this.state === "FILE_VISIBLE") {
            this.state = "VERIFY_END";
            transitionAllowed = true;
          } else {
            rejectionReason = `FSM state not VERIFY_BEGIN or FILE_VISIBLE (current state: ${this.state})`;
          }
        } else if (action === "EXEC_START") {
          if (this.state === "IDLE" || this.state === "VERIFY_BEGIN" || this.state === "FILE_VISIBLE" || this.state === "VERIFY_END") {
            this.state = "EXEC_START";
            results.push({ type: "exec_start", id: execId });
            transitionAllowed = true;
          } else {
            rejectionReason = `FSM state not IDLE/VERIFY_BEGIN/FILE_VISIBLE/VERIFY_END (current state: ${this.state})`;
          }
        } else if (action === "HEARTBEAT") {
          if (this.state === "EXEC_START") {
            results.push({ type: "heartbeat", id: execId });
            transitionAllowed = true;
          } else {
            rejectionReason = `FSM state not EXEC_START (current state: ${this.state})`;
          }
        } else if (action === "EXEC_COMPLETE" || action === "LLVM_PROVISION_COMPLETE") {
          if (this.state === "EXEC_START" || this.state === "VERIFY_END" || this.state === "FILE_VISIBLE" || this.state === "VERIFY_BEGIN") {
            this.state = "SUCCESS";
            results.push({ type: "complete", id: execId });
            transitionAllowed = true;
          } else {
            rejectionReason = `FSM state not EXEC_START/VERIFY_END/FILE_VISIBLE/VERIFY_BEGIN (current state: ${this.state})`;
          }
        } else if (action === "FAIL") {
          if (this.state !== "SUCCESS" && this.state !== "FAIL") {
            this.state = "FAIL";
            results.push({ type: "failed", id: execId });
            transitionAllowed = true;
            Logger.error("VM", `[Provisioning FSM] Transitioned to FAIL for execId=${execId}. Reason: ${reason}`);
          } else {
            rejectionReason = `FSM state already SUCCESS or FAIL (current state: ${this.state})`;
          }
        } else if (action === "SHELL_READY") {
          if (this.state === "SUCCESS") {
            results.push({ type: "shell_ready", id: execId });
            transitionAllowed = true;
          } else {
            rejectionReason = `FSM state not SUCCESS (current state: ${this.state})`;
          }
        } else {
          rejectionReason = `Unknown action type: ${action}`;
        }

        if (transitionAllowed) {
          if (action !== "HEARTBEAT") {
            this.processedPackets.add(packetKey);
            this.lastProcessedSequence = sequence;
          }
          this.currentPhaseTimestamp = Date.now();
          if (action === "EXEC_START" || this.state === "SUCCESS" || this.state === "FAIL") {
            this.isExecutionMode = true;
          }
          if (oldState !== this.state) {
            Logger.info("VM", `[Provisioning FSM] State transition SUCCESS: ${oldState} -> ${this.state} for execId=${execId} (seq: ${sequence}, incoming frame: ${action})`);
          }
        } else {
          Logger.warn("VM", `[Provisioning FSM] Transition REJECTED: ${this.state} -> ${action} for execId=${execId} (seq: ${sequence}, currentExecId=${this.currentExecId}). Reason: ${rejectionReason}`);
        }

        line = line.replace(raw, "");
      }
    }

    return results;
  }

  private sanitize(str: string): string {
    const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    return str.replace(ansiRegex, "").replace(/\r/g, "");
  }

  public enterExecutionMode(): void {
    Logger.info("VM", `[Provisioning FSM] Explicitly entering EXECUTION_MODE. Separating buffers and ignoring all future FSM and verification markers.`);
    this.isExecutionMode = true;
    this.executionBuffer = ""; // Fresh execution buffer, no stale provisioning leftovers!
    this.buffer = "";
  }

  public flush(): void {
    Logger.info("VM", `[Provisioning FSM] Flushing parser buffers. Current state: ${this.state}, execId: ${this.currentExecId}`);
    this.provisioningBuffer = "";
    this.executionBuffer = "";
    this.buffer = "";
  }

  public reset(): void {
    this.buffer = "";
    this.provisioningBuffer = "";
    this.executionBuffer = "";
    this.state = "IDLE";
    this.currentExecId = -1;
    this.processedPackets.clear();
    this.lastProcessedSequence = 0;
    this.isExecutionMode = false;
    this.currentPhaseTimestamp = Date.now();
    this.lastFeedTimestamp = Date.now();
    this.lastMarker = "none";
    this.currentEpoch = -1;
  }
}

// ─── ProvisioningController ──────────────────────────────────────────────────
// Orchestrates the full atomic provisioning flow:
//   1. (Optional) PROVISION_WRITE_BINARY for user backup blob
//   2. PROVISION_BEGIN → PROVISION_CHUNK(s) [ACK-gated] → PROVISION_END
//   3. PROVISION_WRITE  → wait PROVISION_READY
//   4. PROVISION_EXECUTE → FSM enters "executing"
//   5. Wait for **LLVM_PROVISION_COMPLETE** marker on ttyS0

export class ProvisioningController {
  private state: ProvisioningState = "idle";
  private transportState: ProvisionTransportState = "idle";
  private isLocked = false;
  private checkpoint = 0;
  private currentExecutionId = 0;
  private executionStartTimestamp = 0;
  private execStartTimestamp = 0;
  private lastHeartbeatTimestamp = 0;
  private activeBridgeGeneration = 0;
  private completionParser = new ProvisioningCompletionParser();

  // Fine-grained timeouts
  private writeTimer: NodeJS.Timeout | null = null;
  private execStartTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private execCompleteTimer: NodeJS.Timeout | null = null;

  // ACK-gated streaming state
  private pendingChunkIndex = -1;
  private chunkRetries = 0;
  private chunkAckTimer: ReturnType<typeof setTimeout> | null = null;
  private chunksToSend: ReturnType<typeof chunkScript>["chunks"] = [];
  private chunkResolve: (() => void) | null = null;
  private chunkReject: ((reason: string) => void) | null = null;

  private onStateChange: (state: ProvisioningState) => void;
  private onPostMessage: (type: string, payload: unknown) => void;

  constructor(
    onStateChange: (state: ProvisioningState) => void,
    onPostMessage: (type: string, payload: unknown) => void
  ) {
    this.onStateChange = onStateChange;
    this.onPostMessage = onPostMessage;
  }

  // ─── Public getters ───────────────────────────────────────────────────────
  public getState(): ProvisioningState { return this.state; }
  public getTransportState(): ProvisionTransportState { return this.transportState; }
  public getExecutionId(): number { return this.currentExecutionId; }
  public getExecutionStartTimestamp(): number { return this.executionStartTimestamp; }
  public getLastHeartbeatTimestamp(): number { return this.lastHeartbeatTimestamp; }
  public getCompletionParser(): ProvisioningCompletionParser { return this.completionParser; }

  // ─── Timeout Management ────────────────────────────────────────────────────
  private _startWriteTimer(execId: number): void {
    this._cancelWriteTimer();
    this.writeTimer = setTimeout(() => {
      Logger.error("VM", `[PROVISIONING TIMEOUT] Worker failed to report PROVISION_READY (write/verify guest visibility) within 15 seconds for execId=${execId}`);
      this.handleProvisioningFailed(execId, this.activeBridgeGeneration);
    }, 15000);
  }

  private _cancelWriteTimer(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }

  private _startExecStartTimer(execId: number): void {
    this._cancelExecStartTimer();
    this.execStartTimer = setTimeout(() => {
      Logger.error("VM", `[PROVISIONING TIMEOUT] Script failed to output <<<PROTO:EXEC_START:${execId}>>> within 15 seconds for execId=${execId}`);
      this.handleProvisioningFailed(execId, this.activeBridgeGeneration);
    }, 15000);
  }

  private _cancelExecStartTimer(): void {
    if (this.execStartTimer) {
      clearTimeout(this.execStartTimer);
      this.execStartTimer = null;
    }
  }

  private _startHeartbeatTimer(execId: number): void {
    this._cancelHeartbeatTimer();
    // Check every 5 seconds, fail if no heartbeat for 20 seconds
    this.heartbeatTimer = setInterval(() => {
      const age = this.lastHeartbeatTimestamp ? Date.now() - this.lastHeartbeatTimestamp : Date.now() - (this.executionStartTimestamp ?? Date.now());
      if (age > 20000) {
        Logger.error("VM", `[PROVISIONING TIMEOUT] Heartbeat stalled for execId=${execId} (age=${age}ms)`);
        this._cancelHeartbeatTimer();
        this.handleProvisioningFailed(execId, this.activeBridgeGeneration);
      }
    }, 5000);
  }

  private _cancelHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _startExecCompleteTimer(execId: number): void {
    this._cancelExecCompleteTimer();
    // Absolute max execution time: 90 seconds
    this.execCompleteTimer = setTimeout(() => {
      Logger.error("VM", `[PROVISIONING TIMEOUT] Script execution timed out (exceeded 90s) for execId=${execId}`);
      
      // Capture diagnostics (Requirement 7)
      const parserBuffer = (this.completionParser as unknown as { buffer: string }).buffer;
      const parserState = this.completionParser.getState();
      const diag = this.getDiagnostics();
      
      Logger.error("VM", `[PROVISIONING WATCHDOG EXECUTION TIMEOUT DIAGNOSTICS]`, {
        activeExecId: execId,
        parserState,
        lastMarker: this.completionParser.getLastMarker(),
        parserBufferLength: parserBuffer.length,
        parserBufferSnippet: parserBuffer.slice(-1024),
        diagnostics: diag
      });

      this.handleProvisioningFailed(execId, this.activeBridgeGeneration);
    }, 90000);
  }

  private _cancelExecCompleteTimer(): void {
    if (this.execCompleteTimer) {
      clearTimeout(this.execCompleteTimer);
      this.execCompleteTimer = null;
    }
  }

  private _cancelAllTimers(): void {
    this._cancelChunkTimer();
    this._cancelWriteTimer();
    this._cancelExecStartTimer();
    this._cancelHeartbeatTimer();
    this._cancelExecCompleteTimer();
  }

  public recordHeartbeat(): void {
    this.lastHeartbeatTimestamp = Date.now();
    Logger.info("VM", `[PROVISIONING] Heartbeat received for execId ${this.currentExecutionId}`);
  }

  public handleExecStart(execId: number): void {
    if (execId !== this.currentExecutionId) return;
    this.execStartTimestamp = Date.now();
    Logger.info("VM", `[EXEC] Script execution started for execId=${execId}`);
    this._cancelExecStartTimer();
    this._startHeartbeatTimer(execId);
    this._startExecCompleteTimer(execId);
  }

  public transitionTo(newState: ProvisioningState): void {
    if (this.state === newState) return;
    Logger.info("VM", `[PROVISIONING] State: ${this.state} -> ${newState} (execId: ${this.currentExecutionId})`);
    this.state = newState;
    this.onStateChange(newState);
  }

  private transitionTransportTo(newState: ProvisionTransportState): void {
    if (this.transportState === newState) return;
    Logger.info("VM", `[PROVISIONING TRANSPORT] ${this.transportState} -> ${newState} (execId: ${this.currentExecutionId})`);
    this.transportState = newState;
  }

  public reset(): void {
    this.state = "idle";
    this.transportState = "idle";
    this.isLocked = false;
    this.checkpoint = 0;
    this._cancelAllTimers();
    this.chunksToSend = [];
    this.completionParser.reset();
  }

  public getDiagnostics(): Record<string, unknown> {
    return {
      state: this.state,
      transportState: this.transportState,
      isLocked: this.isLocked,
      checkpoint: this.checkpoint,
      executionId: this.currentExecutionId,
      executionStartTimestamp: this.executionStartTimestamp,
      execStartTimestamp: this.execStartTimestamp,
      lastHeartbeatTimestamp: this.lastHeartbeatTimestamp,
      activeBridgeGeneration: this.activeBridgeGeneration,
      pendingChunkIndex: this.pendingChunkIndex,
      chunkRetries: this.chunkRetries,
      totalChunks: this.chunksToSend.length,
      parserBufferLength: (this.completionParser as unknown as { buffer: string }).buffer.length,
      elapsedMs: this.executionStartTimestamp ? Date.now() - this.executionStartTimestamp : 0,
      execElapsedMs: this.execStartTimestamp ? Date.now() - this.execStartTimestamp : 0,
      heartbeatAgeMs: this.lastHeartbeatTimestamp ? Date.now() - this.lastHeartbeatTimestamp : 0,
    };
  }

  // ─── Main provisioning entry point ────────────────────────────────────────
  public async startProvisioning(
    savedStateBuffer: ArrayBuffer | null,
    inspectScript: string,
    useSerial1: boolean,
    bridgeGeneration: number
  ): Promise<boolean> {
    if (this.isLocked || this.state === "completed") {
      Logger.warn("VM", `Provisioning ignored. Locked: ${this.isLocked}, State: ${this.state}`);
      return false;
    }

    this.isLocked = true;
    this.currentExecutionId++;
    const executionId = this.currentExecutionId;
    const filePath = `/root/.provision/runtime_exec.sh`;
    this.executionStartTimestamp = Date.now();
    this.execStartTimestamp = 0;
    this.lastHeartbeatTimestamp = 0;
    this.activeBridgeGeneration = bridgeGeneration;
    this.completionParser.reset();
    this.completionParser.setActiveExecutionId(executionId);

    this.transitionTo("preparing");
    this.transitionTransportTo("preparing");
    this.checkpoint = 1;

    Logger.info("VM", `[PROVISIONING] Starting framed atomic transfer. execId=${executionId}, bridgeGen=${bridgeGeneration}, useSerial1=${useSerial1}`);

    // ── Step 1: Transfer backup blob via PROVISION_WRITE_BINARY (no base64!) ──
    if (savedStateBuffer && savedStateBuffer.byteLength > 2) {
      const bytes = new Uint8Array(savedStateBuffer.byteLength);
      bytes.set(new Uint8Array(savedStateBuffer));

      this.transitionTransportTo("writing_backup");
      Logger.info("VM", `[PROVISIONING] Sending backup blob (${bytes.byteLength} bytes) via PROVISION_WRITE_BINARY...`);

      try {
        await this._sendBinaryFile(executionId, bridgeGeneration, "/root/.provision/fs.tar.gz", bytes);
        Logger.info("VM", `[PROVISIONING] Backup blob written to /root/.provision/fs.tar.gz via create_file().`);
      } catch (e) {
        Logger.error("VM", `[PROVISIONING] Binary file write failed: ${String(e)}. Continuing without restore.`);
        // Non-fatal: continue without backup restore
      }
    }

    // ── Step 2: Build provisioning shell script (no base64, no heredoc blob) ──
    let backgroundMonitorScript = "";
    if (useSerial1) {
      backgroundMonitorScript = `
sh -c '
check_tty() {
  opts=$(stty -F /dev/ttyS0 -a 2>/dev/null)
  if [ -z "$opts" ]; then
    echo "TTY_STATE:err_query_failed"
    return
  fi
  case "$opts" in *"-echo"*) echo_ok=0 ;; *) echo_ok=1 ;; esac
  case "$opts" in *"-icanon"*) icanon_ok=0 ;; *) icanon_ok=1 ;; esac
  owner=$(stat -c "%U" /dev/ttyS0 2>/dev/null || echo "user")
  ps_ok=0
  if ps | grep -E "sh|su" | grep -v grep | grep -q -E "ttyS0|S0"; then
    ps_ok=1
  fi
  echo "TTY_STATE:echo=$echo_ok:icanon=$icanon_ok:owner=$owner:active=$ps_ok"
}

while true; do
  read line
  case "$line" in
    PING)
      echo "PONG"
      ;;
    CHECK_TTY)
      check_tty
      ;;
    RECOVER_TTY)
      stty -F /dev/ttyS0 sane 2>/dev/null
      printf "\\\\033c" > /dev/ttyS0 2>/dev/null
      echo "RECOVERY_DONE"
      ;;
    RESTART_SHELL)
      ps | grep -E "sh|su" | grep -v grep | grep -E "ttyS0|S0" | while read -r pid rest; do
        kill -9 "$pid" 2>/dev/null
      done
      echo "SHELL_RESTART_SENT"
      ;;
  esac
done
' < /dev/ttyS1 > /dev/ttyS1 2>&1 &
`;
    }

    // Restore command now references /tmp/fs.tar.gz which was written by create_file()
    // No base64 heredoc needed — the binary was transferred atomically above.
    const restoreCmd = savedStateBuffer && savedStateBuffer.byteLength > 2
      ? `[ -f /root/.provision/fs.tar.gz ] && tar -xzf /root/.provision/fs.tar.gz -C /home/user 2>/dev/null && rm -f /root/.provision/fs.tar.gz || true`
      : `true`;

    const script = `#!/bin/sh
set -ex
trap 'echo "[PROVISION_ERROR] line=$LINENO exit=$?" > /dev/ttyS0' ERR

echo "[STAGE] execution_begin"

# Provisioning script - execution ID: ${executionId}
# Written via create_file() — no base64 serial injection
exec >/root/.provision/provision_exec.log 2>&1

_provision_completed=0
trap '
  _exit_code=$?
  if [ "$_provision_completed" -eq 0 ]; then
    echo "<<<PROTO:${executionId}:7:FAIL:exit_code_\$_exit_code>>>" > /dev/ttyS0
  fi
' EXIT

echo "<<<PROTO:${executionId}:4:EXEC_START>>>" > /dev/ttyS0
echo "[PROVISIONING] Started execution ID: ${executionId}"

echo "[STAGE] self_test"
echo "self_test_ok" > /root/.provision/self_test_file.tmp
sync
if [ -f /root/.provision/self_test_file.tmp ] && [ "$(cat /root/.provision/self_test_file.tmp)" = "self_test_ok" ]; then
  echo "[SELF_TEST] Read/write verification passed"
else
  echo "[SELF_TEST] Read/write verification failed" > /dev/ttyS0
  echo "<<<PROTO:${executionId}:7:FAIL:self_test_failed>>>" > /dev/ttyS0
  exit 1
fi
rm -f /root/.provision/self_test_file.tmp
sync

echo "<<<PROTO:${executionId}:5:HEARTBEAT>>>" > /dev/ttyS0

hostname linlearn
mkdir -p /home/user/Projects /home/user/.config /home/user/workspace
adduser -D -h /home/user -s /bin/sh user 2>/dev/null || true

echo "<<<PROTO:${executionId}:5:HEARTBEAT>>>" > /dev/ttyS0

${restoreCmd}

echo "<<<PROTO:${executionId}:5:HEARTBEAT>>>" > /dev/ttyS0

cat << 'PROFILE_EOF' > /home/user/.profile
export HOME=/home/user
export PS1='user@linlearn:\\$(pwd | sed "s|^\\$HOME|~|")\\$ '
cd /home/user
echo "<<<PROTO:${executionId}:8:SHELL_READY>>>"
PROFILE_EOF

cat << 'INSPECT_EOF' > /usr/bin/linlearn-inspect
${inspectScript}
INSPECT_EOF
chmod +x /usr/bin/linlearn-inspect

chown -R user:user /home/user
chown user /dev/ttyS0

echo "<<<PROTO:${executionId}:5:HEARTBEAT>>>" > /dev/ttyS0

${backgroundMonitorScript}

_provision_completed=1
echo "done" > /root/.provision/provision_complete

echo "" > /dev/ttyS0
sync
sleep 1

echo "<<<PROTO:${executionId}:6:EXEC_COMPLETE>>>" > /dev/ttyS0
sync

while read -t 15 -r ack_line; do
  case "$ack_line" in
    "PROVISIONING_ACK:${executionId}"*)
      break
      ;;
  esac
done < /dev/ttyS0

exec sh -c 'while true; do chown user /dev/ttyS0; su - user; done' < /dev/ttyS0 > /dev/ttyS0 2>&1
`;

    Logger.info("VM", `[PROVISIONING] Script built. execId=${executionId}, scriptSize=${script.length} chars. FULL GENERATED SCRIPT:\n${script}`);

    // ── Step 3: Send script as framed PROVISION_* chunks ─────────────────────
    this.transitionTo("transferring");
    this.transitionTransportTo("sending_script");

    try {
      await this._streamScript(script, executionId, bridgeGeneration);
    } catch (e) {
      Logger.error("VM", `[PROVISIONING] Script streaming failed: ${String(e)}`);
      this.isLocked = false;
      this.transitionTransportTo("failed");
      this.transitionTo("failed");
      return false;
    }

    // ── Step 4: Tell worker to write file to VM FS ────────────────────────────
    this.transitionTransportTo("awaiting_write");
    Logger.info("VM", `[PROVISIONING] Sending PROVISION_WRITE for execId=${executionId}`);
    this.onPostMessage("PROVISION_WRITE", {
      execId: executionId,
      generation: bridgeGeneration,
      filePath: filePath,
    });
    this._startWriteTimer(executionId);
    // PROVISION_READY is handled by handleProvisionAck() below

    return true;
  }

  // ─── ACK / NACK handlers (called by emulatorManager) ─────────────────────

  public handleProvisionAck(ack: ProvisionAckPayload, bridgeGeneration: number): void {
    if (ack.execId !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Stale PROVISION_ACK for execId=${ack.execId} (current=${this.currentExecutionId}). Ignoring.`);
      return;
    }
    if (bridgeGeneration !== this.activeBridgeGeneration) {
      Logger.warn("VM", `[PROVISIONING] Stale PROVISION_ACK from generation ${bridgeGeneration} (active=${this.activeBridgeGeneration}). Ignoring.`);
      return;
    }

    Logger.debug("VM", `[PROVISIONING] PROVISION_ACK received: type=${ack.type}, execId=${ack.execId}, chunkIndex=${ack.chunkIndex ?? "n/a"}`);

    switch (ack.type) {
      case "begin":
        // Begin ACK: resolved by _streamScript waiting logic
        break;

      case "chunk":
        // Chunk ACK: advance to next chunk
        this._cancelChunkTimer();
        if (this.chunkResolve) {
          const resolve = this.chunkResolve;
          this.chunkResolve = null;
          this.chunkReject = null;
          this.chunkRetries = 0;
          resolve();
        }
        break;

      case "end":
        // End ACK: streaming complete, chunks assembled
        Logger.info("VM", `[PROVISIONING] Worker confirmed full script assembly for execId=${ack.execId}`);
        break;

      case "write_binary":
        // Binary backup blob written to VM FS
        Logger.info("VM", `[PROVISIONING] Worker confirmed binary file write for execId=${ack.execId}`);
        break;

      case "write":
        // Not used in current flow; PROVISION_READY supersedes this
        break;

      case "execute":
        // Worker sent serial trigger. Transition to executing state.
        Logger.info("VM", `[PROVISIONING] Worker confirmed serial trigger sent for execId=${ack.execId}. Script is executing.`);
        this.transitionTransportTo("executing");
        this.transitionTo("executing");
        // Wait transitions to waiting_completion after execute
        this.transitionTo("waiting_completion");
        Logger.info("VM", `[PROVISIONING] Now waiting for **LLVM_PROVISION_COMPLETE**:${ack.execId}`);
        break;

      case "cancel":
        Logger.info("VM", `[PROVISIONING] Worker confirmed provisioning cancelled.`);
        break;
    }
  }

  public handleProvisionNack(nack: ProvisionNackPayload): void {
    if (nack.execId !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Stale PROVISION_NACK for execId=${nack.execId}. Ignoring.`);
      return;
    }
    Logger.error("VM", `[PROVISIONING] PROVISION_NACK received: reason=${nack.reason}, chunkIndex=${nack.chunkIndex ?? "n/a"}, execId=${nack.execId}`);

    if (nack.chunkIndex !== undefined && this.chunkReject) {
      // Chunk failure — retry logic is in _sendChunk
      const reject = this.chunkReject;
      this.chunkResolve = null;
      this.chunkReject = null;
      reject(`nack:${nack.reason}`);
    } else {
      // Fatal transport failure
      this._cancelChunkTimer();
      this._cancelAllTimers();
      this.isLocked = false;
      this.transitionTransportTo("failed");
      this.transitionTo("failed");
    }
  }

  public handleProvisionReady(ready: ProvisionReadyPayload, bridgeGeneration: number): void {
    if (ready.execId !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Stale PROVISION_READY for execId=${ready.execId}. Ignoring.`);
      return;
    }
    if (bridgeGeneration !== this.activeBridgeGeneration) {
      Logger.warn("VM", `[PROVISIONING] Stale PROVISION_READY from generation ${bridgeGeneration}. Ignoring.`);
      return;
    }
    this._cancelWriteTimer();
    if (ready.telemetry) {
      Logger.info(
        "VM",
        `[PROVISIONING TELEMETRY] FS Ready: ${ready.telemetry.fsReadyTimestamp}, ` +
        `Write Latency: ${ready.telemetry.writeLatencyMs}ms, Path: ${ready.telemetry.filePath}, ` +
        `Size: ${ready.telemetry.fileSize} bytes, Verified: ${ready.telemetry.verified}, ` +
        `GuestVisible: ${ready.telemetry.guestVisible ?? "n/a"}, FallbackRequired: ${ready.telemetry.fallbackRequired ?? "n/a"}` +
        (ready.telemetry.mountSuccess !== undefined ? `, MountSuccess: ${ready.telemetry.mountSuccess}, PropLatency: ${ready.telemetry.propagationLatencyMs}ms, Retries: ${ready.telemetry.retryCount}, VisTiming: ${ready.telemetry.guestVisibilityTimingMs}ms, Remounts: ${ready.telemetry.remountAttempts}, MountLatency: ${ready.telemetry.mountLatencyMs}ms, VisLatency: ${ready.telemetry.visibilityLatencyMs}ms, VirtioReady: ${ready.telemetry.virtioReadiness}, ReaddirSuccess: ${ready.telemetry.readdirSuccess}, InodeReady: ${ready.telemetry.inodeReadiness}` : "")
      );
    }

    // Execution barrier: Do NOT execute provisioning until GuestVisible=true is confirmed
    if (!ready.telemetry || !ready.telemetry.guestVisible) {
      Logger.error(
        "VM",
        `[PROVISIONING BARRIER] Execution blocked. Guest visibility check failed (GuestVisible=false).`
      );
      this.handleProvisioningFailed(ready.execId, this.activeBridgeGeneration);
      return;
    }

    Logger.info(
      "VM",
      `[PROVISIONING] PROVISION_READY received and guest visibility confirmed. File ${ready.filePath} written to VM FS. ` +
      `Entering serial stabilization and drain barrier...`
    );
    this.transitionTransportTo("awaiting_execute");

    const readyReceivedTime = Date.now();
    const checkStabilizationAndExecute = () => {
      if (ready.execId !== this.currentExecutionId || bridgeGeneration !== this.activeBridgeGeneration) {
        Logger.warn("VM", `[PROVISIONING] Stabilization wait aborted: execId or generation changed.`);
        return;
      }

      const now = Date.now();
      const lastFeed = this.completionParser.getLastFeedTimestamp();
      const silenceDuration = now - lastFeed;
      const totalWait = now - readyReceivedTime;

      // If we have had at least 400ms of silence, OR we've waited a maximum of 2500ms
      if (silenceDuration >= 400 || totalWait >= 2500) {
        Logger.info(
          "VM",
          `[PROVISIONING] Serial buffer stabilized. Silence duration: ${silenceDuration}ms, Total wait: ${totalWait}ms. ` +
          `Draining serial parser buffer and entering EXECUTION_MODE.`
        );

        // Flush serial parser buffer and enter execution mode (serial replay drain barrier)
        this.completionParser.flush();
        this.completionParser.enterExecutionMode();

        // Start timer waiting for execution to start
        this._startExecStartTimer(ready.execId);

        // Send execution trigger — worker will write single serial command
        this.onPostMessage("PROVISION_EXECUTE", {
          execId: this.currentExecutionId,
          generation: this.activeBridgeGeneration,
          filePath: ready.filePath,
          verifiedInode: ready.telemetry?.verifiedInode || "unknown",
          fallbackRequired: false
        });
      } else {
        // Check again in 100ms
        setTimeout(checkStabilizationAndExecute, 100);
      }
    };

    // Kick off stabilization check
    setTimeout(checkStabilizationAndExecute, 100);
  }

  // ─── Completion / failure handlers ────────────────────────────────────────

  public handleProvisioningComplete(id: number, bridgeGeneration: number): void {
    if (id !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Ignored stale PROVISIONING_COMPLETE for execId=${id} (current=${this.currentExecutionId})`);
      return;
    }
    if (bridgeGeneration !== this.activeBridgeGeneration) {
      Logger.warn("VM", `[PROVISIONING] Ignored PROVISIONING_COMPLETE from stale generation ${bridgeGeneration}`);
      return;
    }
    this._cancelAllTimers();
    const elapsed = this.executionStartTimestamp ? Date.now() - this.executionStartTimestamp : 0;
    const execLatency = this.execStartTimestamp ? Date.now() - this.execStartTimestamp : 0;
    Logger.info("VM", `[EXEC] Script execution complete. execId=${id}, bridgeGen=${bridgeGeneration}, elapsed=${elapsed}ms, execLatency=${execLatency}ms`);
    this.checkpoint = 2;
    this.isLocked = false;
    this.transitionTransportTo("completed");
    this.transitionTo("completed");
  }

  public handleProvisioningFailed(id: number, bridgeGeneration: number): void {
    if (id !== this.currentExecutionId) {
      Logger.warn("VM", `[PROVISIONING] Ignored stale PROVISIONING_FAILED for execId=${id}`);
      return;
    }
    if (bridgeGeneration !== this.activeBridgeGeneration) {
      Logger.warn("VM", `[PROVISIONING] Ignored PROVISIONING_FAILED from stale generation ${bridgeGeneration}`);
      return;
    }
    this._cancelAllTimers();
    const elapsed = this.executionStartTimestamp ? Date.now() - this.executionStartTimestamp : 0;
    const execLatency = this.execStartTimestamp ? Date.now() - this.execStartTimestamp : 0;
    Logger.error("VM", `[EXEC] Script execution failed/exited without completion marker. execId=${id}, elapsed=${elapsed}ms, execLatency=${execLatency}ms`);
    this.isLocked = false;
    this.transitionTransportTo("failed");
    this.transitionTo("failed");
  }

  public handleFailure(): void {
    this._cancelAllTimers();
    this.isLocked = false;
    this.transitionTransportTo("failed");
    this.transitionTo("failed");
  }

  public handleRecover(): void {
    this.isLocked = false;
    this.transitionTo("recovering");
  }

  // ─── Cancel provisioning transport cleanly ────────────────────────────────
  public cancelTransport(): void {
    Logger.info("VM", `[PROVISIONING] Cancelling active transport for execId=${this.currentExecutionId}`);
    this._cancelAllTimers();
    this.chunksToSend = [];
    this.isLocked = false;
    this.transitionTransportTo("cancelling");
    this.onPostMessage("PROVISION_CANCEL", {
      execId: this.currentExecutionId,
      generation: this.activeBridgeGeneration,
    });
  }

  // ─── Internal: ACK-gated script streaming ─────────────────────────────────

  private async _streamScript(
    script: string,
    execId: number,
    generation: number
  ): Promise<void> {
    const { begin, chunks, end } = chunkScript(script, execId, generation);
    this.chunksToSend = chunks;

    Logger.info("VM", `[PROVISIONING] Streaming ${chunks.length} chunks (${script.length} bytes total) for execId=${execId}`);

    // Send BEGIN
    this.onPostMessage("PROVISION_BEGIN", begin);
    // Give worker a tick to process BEGIN before streaming chunks
    await new Promise<void>((r) => setTimeout(r, 0));

    // ACK-gated chunk streaming
    for (let i = 0; i < chunks.length; i++) {
      await this._sendChunkWithRetry(chunks[i], execId);
      Logger.debug("VM", `[PROVISIONING] Chunk ${i + 1}/${chunks.length} ACKed.`);
    }

    // Send END
    this.onPostMessage("PROVISION_END", end);
    // Give worker a tick to finalize assembly
    await new Promise<void>((r) => setTimeout(r, 0));

    Logger.info("VM", `[PROVISIONING] Script streaming complete. execId=${execId}`);
  }

  private _sendChunkWithRetry(
    chunk: ReturnType<typeof chunkScript>["chunks"][0],
    execId: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let retries = 0;

      const attempt = () => {
        if (execId !== this.currentExecutionId) {
          reject("execId_superseded");
          return;
        }

        this.pendingChunkIndex = chunk.chunkIndex;
        this.chunkRetries = retries;
        this.chunkResolve = resolve;
        this.chunkReject = (reason: string) => {
          retries++;
          if (retries >= PROVISION_MAX_CHUNK_RETRIES) {
            reject(`chunk_${chunk.chunkIndex}_failed_after_${retries}_retries: ${reason}`);
            return;
          }
          Logger.warn("VM", `[PROVISIONING] Chunk ${chunk.chunkIndex} retry ${retries}/${PROVISION_MAX_CHUNK_RETRIES}. Reason: ${reason}`);
          setTimeout(attempt, 100);
        };

        this.onPostMessage("PROVISION_CHUNK", chunk);

        this._cancelChunkTimer();
        this.chunkAckTimer = setTimeout(() => {
          const reject = this.chunkReject;
          this.chunkResolve = null;
          this.chunkReject = null;
          if (reject) reject(`chunk_ack_timeout`);
        }, PROVISION_CHUNK_ACK_TIMEOUT_MS);
      };

      attempt();
    });
  }

  private _cancelChunkTimer(): void {
    if (this.chunkAckTimer !== null) {
      clearTimeout(this.chunkAckTimer);
      this.chunkAckTimer = null;
    }
  }

  private _sendBinaryFile(
    execId: number,
    generation: number,
    filePath: string,
    data: Uint8Array
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      // For binary writes we don't need ACK-gating since it's a single atomic message
      // and the result comes back as PROVISION_ACK(write_binary)
      const { chunks } = chunkBinary(data, filePath, execId, generation);
      if (chunks.length === 0) {
        resolve();
        return;
      }
      // Send the single binary write message
      // Note: data is a Uint8Array which travels via structured clone, no serialization needed
      this.onPostMessage("PROVISION_WRITE_BINARY", chunks[0]);
      // Resolve immediately — failure is handled by PROVISION_NACK callback
      // We can't easily await here without a separate promise registry,
      // so we resolve optimistically and let NACK handlers trigger recovery
      resolve();
    });
  }
}
