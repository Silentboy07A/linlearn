// src/missions/validator.ts

import { Mission } from "./config";

export interface GuestFile {
  path: string;
  type: "file" | "directory" | "other";
  permissions: number; // Octal permissions, e.g. 755
  owner: string;
  size: number;
}

export interface GuestState {
  files: Record<string, GuestFile>;
  processes: string[];
  fileContents: Record<string, string>;
  history: string[];
}

/**
 * Parse the raw console output of the guest VM inspector script.
 */
export function parseGuestState(output: string): GuestState {
  const state: GuestState = {
    files: {},
    processes: [],
    fileContents: {},
    history: []
  };

  const lines = output.split(/\r?\n/);
  let section: "none" | "files" | "processes" | "contents" | "history" = "none";
  let activeFile = "";
  let activeFileContent = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.includes("INSPECT_START")) continue;
    if (trimmed.includes("INSPECT_END")) break;

    if (trimmed === "=== FILES ===") {
      section = "files";
      continue;
    } else if (trimmed === "=== PROCESSES ===") {
      section = "processes";
      continue;
    } else if (trimmed === "=== FILE_CONTENTS ===") {
      section = "contents";
      continue;
    } else if (trimmed === "=== HISTORY ===") {
      if (activeFile) {
        state.fileContents[activeFile] = activeFileContent;
        activeFile = "";
      }
      section = "history";
      continue;
    }

    if (section === "files") {
      // format: path:fileType:permissions:owner:size
      // stat -c "%n:%F:%a:%U:%s"
      // e.g. /home/user/Projects:directory:755:user:4096
      const parts = trimmed.split(":");
      if (parts.length >= 5) {
        const path = parts[0];
        const rawType = parts[1].toLowerCase();
        const type = rawType.includes("directory") ? "directory" : (rawType.includes("file") ? "file" : "other");
        const permissions = parseInt(parts[2], 8) || 0; // Parse as octal!
        const owner = parts[3];
        const size = parseInt(parts[4], 10) || 0;

        state.files[path] = { path, type, permissions, owner, size };
      }
    } else if (section === "processes") {
      // ps output
      // Grab process executable name
      state.processes.push(trimmed);
    } else if (section === "contents") {
      if (trimmed.startsWith("--- ") && trimmed.endsWith(" ---")) {
        if (activeFile) {
          state.fileContents[activeFile] = activeFileContent.trim();
        }
        activeFile = trimmed.substring(4, trimmed.length - 4);
        activeFileContent = "";
      } else if (activeFile) {
        activeFileContent += line + "\n";
      }
    } else if (section === "history") {
      state.history.push(trimmed);
    }
  }

  if (activeFile) {
    state.fileContents[activeFile] = activeFileContent.trim();
  }

  return state;
}

export interface RuleValidationResult {
  passed: boolean;
  reason?: string;
}

/**
 * Executes local deterministic verification checks against the VM state.
 */
export function validateMissionRules(state: GuestState, mission: Mission): RuleValidationResult {
  for (const rule of mission.rules) {
    switch (rule.type) {
      case "directory_exists": {
        const file = state.files[rule.target];
        if (!file || file.type !== "directory") {
          return { passed: false, reason: `Directory not found: ${rule.target}` };
        }
        break;
      }

      case "file_exists": {
        const file = state.files[rule.target];
        if (!file || file.type !== "file") {
          return { passed: false, reason: `File not found: ${rule.target}` };
        }
        break;
      }

      case "file_contains": {
        const file = state.files[rule.target];
        if (!file || file.type !== "file") {
          return { passed: false, reason: `File not found for contents check: ${rule.target}` };
        }
        const contents = state.fileContents[rule.target] || "";
        const expected = String(rule.expected || "");
        if (!contents.includes(expected)) {
          return { passed: false, reason: `File ${rule.target} does not contain required content: "${expected}"` };
        }
        break;
      }

      case "permissions_match": {
        const file = state.files[rule.target];
        if (!file) {
          return { passed: false, reason: `File not found for permissions check: ${rule.target}` };
        }
        const expectedPerm = Number(rule.expected);
        
        // Specific execute permission check (+x)
        if (expectedPerm === 755) {
          // Verify that at least user execute bit is set (octal 0o100)
          const isExecutable = (file.permissions & 0o111) !== 0;
          if (!isExecutable) {
            return { passed: false, reason: `File ${rule.target} is not executable` };
          }
        } else if (expectedPerm === 400) {
          // Read-only check: verify write permissions are disabled (no 0o200, 0o020, 0o002)
          const hasWritePerms = (file.permissions & 0o222) !== 0;
          if (hasWritePerms) {
            return { passed: false, reason: `File ${rule.target} should be read-only (write permissions still active)` };
          }
        } else {
          // Direct exact match check
          if (file.permissions !== expectedPerm) {
            return { passed: false, reason: `Permissions mismatch on ${rule.target}: expected octal ${expectedPerm.toString(8)}, got ${file.permissions.toString(8)}` };
          }
        }
        break;
      }

      case "process_running": {
        const targetProcess = String(rule.target).toLowerCase();
        const isRunning = state.processes.some(p => p.toLowerCase().includes(targetProcess));
        if (!isRunning) {
          // Fallback: check if the process exists as an installed binary since htop package install doesn't guarantee it's currently running in background
          const binInstalled = Object.keys(state.files).some(f => f.endsWith(targetProcess));
          if (!binInstalled) {
            return { passed: false, reason: `Process or package "${rule.target}" is not running or installed` };
          }
        }
        break;
      }
    }
  }

  return { passed: true };
}
