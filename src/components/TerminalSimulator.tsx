"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { RefreshCw, Terminal as TermIcon, BookOpen, Award, CheckCircle, HelpCircle } from "lucide-react";
import type { Terminal } from "xterm";
import type { FitAddon } from "xterm-addon-fit";
import type { TerminalPrefs, SessionCommand } from "@/lib/session";
import { 
  getInitialState, 
  executeCommand, 
  getNode, 
  resolvePath, 
  type VirtualSystemState 
} from "@/lib/virtualOs";

import { updateMastery, DEFAULT_BKT_PARAMS, type LinuxTopic } from "@/lib/bkt";
import { VMController } from "@/vm/emulatorManager";
import { PersistenceManager } from "@/persistence/manager";
import { parseGuestState, GuestState } from "@/missions/validator";
import { getMissionsByCategory, type MissionCategory } from "@/missions/config";

interface CustomTerminal extends Terminal {
  _simDisposable?: { dispose: () => void };
  _v86Disposable?: { dispose: () => void };
  _handleFocus?: () => void;
  _handleBlur?: () => void;
  _rafId?: number;
}

interface TerminalSimulatorProps {
  prefs: TerminalPrefs;
  clearSignal: number;
  onCommandLogged: (item: SessionCommand) => void;
  onDbFallback: () => void;
}

const themeColors = {
  green: { background: "#06070a", foreground: "#4ade80", cursor: "#4ade80" },
  amber: { background: "#06070a", foreground: "#fbbf24", cursor: "#fbbf24" },
  cyan: { background: "#06070a", foreground: "#22d3ee", cursor: "#22d3ee" },
  white: { background: "#06070a", foreground: "#f3f4f6", cursor: "#f3f4f6" },
};

// Local checks replaced by server-side deterministic rule verification engine

const MISSION_TOPICS: Record<string, LinuxTopic> = {
  pwd_ls: "navigation",
  mkdir_proj: "files",
  touch_config: "files",
  nginx: "networking",
  logs: "files",
  htop: "processes",
  permissions: "permissions",
  lock_config: "permissions",
  audit_dangerous: "permissions",
  sysinfo: "navigation",
  services: "processes",
  processes: "processes"
};

const COMMAND_TOPICS: Record<string, LinuxTopic> = {
  ls: "navigation",
  cd: "navigation",
  pwd: "navigation",
  mkdir: "files",
  touch: "files",
  cat: "files",
  echo: "files",
  chmod: "permissions",
  chown: "permissions",
  docker: "networking",
  systemctl: "processes",
  service: "processes",
  ps: "processes",
  top: "processes",
  kill: "processes",
  apt: "packages",
  man: "navigation"
};

// Helper function to calculate HMAC-SHA256 in the browser using the Web Cryptography API
async function computeHMAC(keyStr: string, dataStr: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await window.crypto.subtle.importKey(
    "raw",
    enc.encode(keyStr),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  const signature = await window.crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(dataStr)
  );
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}


function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// Help dictionary for command metadata, difficulty levels, related commands, and flags
const COMMAND_HELP_INFO: Record<string, {
  name: string;
  difficulty: "Beginner" | "Intermediate" | "Advanced";
  desc: string;
  flags: Record<string, string>;
  related: string[];
}> = {
  ls: {
    name: "ls",
    difficulty: "Beginner",
    desc: "Lists files and directories in the current folder.",
    flags: {
      "-l": "Long format, showing file permissions, owner, size, and modified date.",
      "-a": "Shows all files, including hidden ones (starting with a dot).",
      "-la": "Combines long format and lists hidden files."
    },
    related: ["cd", "pwd", "mkdir"]
  },
  cd: {
    name: "cd",
    difficulty: "Beginner",
    desc: "Changes the current working directory.",
    flags: {
      "~": "Changes directory to user's home folder.",
      "..": "Moves up one level to the parent directory.",
      "/": "Moves to the root directory."
    },
    related: ["pwd", "ls"]
  },
  pwd: {
    name: "pwd",
    difficulty: "Beginner",
    desc: "Prints the absolute path of the current working directory.",
    flags: {},
    related: ["cd", "ls"]
  },
  mkdir: {
    name: "mkdir",
    difficulty: "Beginner",
    desc: "Creates a new folder at the specified path.",
    flags: {},
    related: ["touch", "rm"]
  },
  touch: {
    name: "touch",
    difficulty: "Beginner",
    desc: "Creates an empty file or updates the timestamp of an existing file.",
    flags: {},
    related: ["mkdir", "cat", "rm"]
  },
  cat: {
    name: "cat",
    difficulty: "Beginner",
    desc: "Concatenates and displays file contents in the terminal.",
    flags: {},
    related: ["echo", "nano", "grep"]
  },
  echo: {
    name: "echo",
    difficulty: "Beginner",
    desc: "Prints the input arguments to standard output.",
    flags: {
      ">": "Redirects output to create/overwrite a file.",
      ">>": "Redirects output to append to an existing file."
    },
    related: ["cat", "grep"]
  },
  chmod: {
    name: "chmod",
    difficulty: "Intermediate",
    desc: "Modifies read, write, and execute permissions of files and directories.",
    flags: {
      "755": "Read/Write/Execute for owner, Read/Execute for group and others.",
      "644": "Read/Write for owner, Read-only for group and others.",
      "+x": "Makes the file executable."
    },
    related: ["chown", "ls"]
  },
  chown: {
    name: "chown",
    difficulty: "Intermediate",
    desc: "Changes file owner and group ownership properties.",
    flags: {
      "owner:group": "Sets both user owner and group owner."
    },
    related: ["chmod", "ls"]
  },
  docker: {
    name: "docker",
    difficulty: "Advanced",
    desc: "Manages images, containers, and configurations on the Docker virtual engine.",
    flags: {
      "ps": "Lists running containers. Add '-a' or '--all' to show all containers.",
      "images": "Lists local cached images.",
      "run -d -p 80:80 nginx": "Starts nginx container in background (detached) mapping port 80.",
      "stop <id>": "Gracefully halts a running container instance.",
      "rm <id>": "Permanently deletes a stopped container."
    },
    related: ["systemctl", "ps"]
  },
  systemctl: {
    name: "systemctl",
    difficulty: "Intermediate",
    desc: "Controls and views services, daemons, and systemd units.",
    flags: {
      "status <service>": "Inspects whether a service is running or stopped.",
      "start <service>": "Activates a service daemon.",
      "stop <service>": "Halts a running service daemon.",
      "restart <service>": "Restarts a service instance."
    },
    related: ["service", "ps"]
  },
  service: {
    name: "service",
    difficulty: "Intermediate",
    desc: "Runs System V init service scripts.",
    flags: {
      "--status-all": "Lists status of all registered system services."
    },
    related: ["systemctl"]
  },
  ps: {
    name: "ps",
    difficulty: "Intermediate",
    desc: "Lists active processes running in the current shell context.",
    flags: {
      "aux": "Lists all processes running on the OS with detailed CPU/Mem stats."
    },
    related: ["top", "kill"]
  },
  top: {
    name: "top",
    difficulty: "Intermediate",
    desc: "Displays an interactive, real-time list of active processes.",
    flags: {},
    related: ["ps", "kill"]
  },
  kill: {
    name: "kill",
    difficulty: "Intermediate",
    desc: "Sends termination signals to processes by PID.",
    flags: {
      "-9": "Forces process termination (SIGKILL) immediately."
    },
    related: ["ps", "top"]
  },
  apt: {
    name: "apt",
    difficulty: "Intermediate",
    desc: "Advanced Package Tool (apt) manages installation/removal of software packages.",
    flags: {
      "update": "Fetches database information of latest repository packages.",
      "install <pkg>": "Downloads and installs a software package (e.g., htop, tmux).",
      "remove <pkg>": "Uninstalls a package from the system."
    },
    related: ["systemctl", "service"]
  },
  man: {
    name: "man",
    difficulty: "Beginner",
    desc: "Displays the reference manual page for a command.",
    flags: {},
    related: ["help"]
  }
};

// Simulated Interview flashcards
const INTERVIEW_PREP_DATA = [
  {
    q: "How do you check running containers and start a new one in the background?",
    a: "Use `docker ps` to view containers and `docker run -d -p 80:80 nginx` to start a new container in detached (-d) mode."
  },
  {
    q: "What command shows all active services and their status?",
    a: "Use `systemctl status` to view active units or `service --status-all` to list System V init service status mappings."
  },
  {
    q: "How do you check process lists sorted by CPU or memory usage?",
    a: "Run `top` for a live process monitor, or `ps aux` to get a formatted snapshot of all active processes."
  },
  {
    q: "How do you create a file and make it read-write-execute for owners, but read-only for others?",
    a: "Use `touch script.sh` followed by `chmod 744 script.sh` or `chmod u+x script.sh`."
  },
  {
    q: "How do you download and install software packages on Debian-based Ubuntu?",
    a: "Run `apt update` first to fetch the package definitions, then run `apt install <package_name>`."
  }
];

export function TerminalSimulator({
  prefs,
  clearSignal,
  onCommandLogged,
  onDbFallback,
}: TerminalSimulatorProps) {
  // Virtual System State
  const [osState, setOsState] = useState<VirtualSystemState>(getInitialState);
  const [activeTab, setActiveTab] = useState<"explanations" | "missions" | "interview">("missions");
  const [learningMode, setLearningMode] = useState<"Beginner" | "DevOps" | "Security" | "Interview Prep">("Beginner");
  const [lastCommand, setLastCommand] = useState<string>("");
  const [isV86Mode, setIsV86Mode] = useState<boolean>(false);
  const [v86Booting, setV86Booting] = useState<boolean>(false);

  const [isV86Running, setIsV86Running] = useState<boolean>(false);
  const [vmStateName, setVmStateName] = useState<string>("idle");
  const [bootComplete, setBootComplete] = useState<boolean>(false);
  const [provisioningState, setProvisioningState] = useState<string>("idle");
  const [terminalState, setTerminalState] = useState<string>("detached");
  const [recoveryState, setRecoveryState] = useState<string>("healthy");
  const activeTermRef = useRef<Terminal | null>(null);

  const [isFocused, setIsFocused] = useState<boolean>(false);
  const [termResetCounter, setTermResetCounter] = useState<number>(0);

  const [masteryState, setMasteryState] = useState<Record<LinuxTopic, number>>(() => {
    return {
      navigation: DEFAULT_BKT_PARAMS.navigation.pL0,
      files: DEFAULT_BKT_PARAMS.files.pL0,
      permissions: DEFAULT_BKT_PARAMS.permissions.pL0,
      networking: DEFAULT_BKT_PARAMS.networking.pL0,
      processes: DEFAULT_BKT_PARAMS.processes.pL0,
      packages: DEFAULT_BKT_PARAMS.packages.pL0,
    };
  });

  useEffect(() => {
    const saved = localStorage.getItem("linlearn_mastery");
    if (saved) {
      try {
        setMasteryState(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to restore BKT mastery state:", e);
      }
    }
  }, []);

  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<Terminal | null>(null);
  const v86EmulatorRef = useRef<VMController | null>(null);
  const persistenceManagerRef = useRef<PersistenceManager>(new PersistenceManager());
  const [isPersistenceSaving, setIsPersistenceSaving] = useState<boolean>(false);
  const [hasSavedState, setHasSavedState] = useState<boolean>(false);
  const bootTimeRef = useRef<number | null>(null);
  const lastCommandRef = useRef<string>("");
  const lastOutputRef = useRef<string>("");
  const savedStateRef = useRef<ArrayBuffer | null>(null);

  const validationResolverRef = useRef<((val: boolean) => void) | null>(null);
  const validationBufferRef = useRef("");
  
  const isCapturingBackupRef = useRef<boolean>(false);
  const backupBufferRef = useRef("");
  const backupResolverRef = useRef<((val: boolean) => void) | null>(null);

  const [completedVasmMissions, setCompletedVasmMissions] = useState<Record<string, boolean>>({});
  const [validatingMissions, setValidatingMissions] = useState<Record<string, boolean>>({});
  const isCapturingValidationRef = useRef<boolean>(false);

  const updateBKT = (topic: LinuxTopic, correct: boolean) => {
    setMasteryState(prev => {
      const pLCurrent = prev[topic] !== undefined ? prev[topic] : DEFAULT_BKT_PARAMS[topic].pL0;
      const pLNext = updateMastery(pLCurrent, correct, topic);
      const updated = { ...prev, [topic]: pLNext };
      localStorage.setItem("linlearn_mastery", JSON.stringify(updated));

      if (activeTermRef.current) {
        const diff = pLNext - pLCurrent;
        const indicator = diff >= 0 ? `\x1b[1;32m+${(diff*100).toFixed(1)}%\x1b[0m` : `\x1b[1;31m${(diff*100).toFixed(1)}%\x1b[0m`;
        activeTermRef.current.write(`\r\n\x1b[1;90m[Telemetry] BKT Mastery for ${topic} updated to ${(pLNext*100).toFixed(1)}% (${indicator})\x1b[0m\r\n`);
      }
      return updated;
    });
  };



  const handleResetV86State = async () => {
    if (window.confirm("Are you sure you want to reset the Virtual Machine? This will delete all saved snapshots and restore a clean environment.")) {
      setIsV86Running(false);
      setV86Booting(true);
      setVmStateName("loading");
      
      // Cancel autosave loops
      persistenceManagerRef.current.cancelPendingSaves();
      
      // Stop the VM emulator completely (kills worker)
      if (v86EmulatorRef.current) {
        await v86EmulatorRef.current.stop();
        v86EmulatorRef.current = null;
      }
      
      // Clear IndexedDB snapshot
      await persistenceManagerRef.current.clearState("default_session");
      setHasSavedState(false);
      lastOutputRef.current = ""; // Clear command history rolling log!

      // Use counter-based re-init instead of toggling isV86Mode off/on
      // which causes a dangerous unmount+remount race condition
      setTermResetCounter(prev => prev + 1);
    }
  };

  const runV86Validation = (): Promise<GuestState | null> => {
    return new Promise((resolve) => {
      const emulator = v86EmulatorRef.current;
      if (!emulator) {
        resolve(null);
        return;
      }

      isCapturingValidationRef.current = true;
      validationBufferRef.current = "";
      validationResolverRef.current = (done) => {
        if (done) {
          try {
            const parsed = parseGuestState(validationBufferRef.current);
            resolve(parsed);
          } catch (e) {
            console.error("Failed to parse guest state:", e);
            resolve(null);
          }
        } else {
          resolve(null);
        }
      };

      // Send silent inspection command sequence
      emulator.sendInput("\nstty -echo\n/usr/bin/linlearn-inspect\nstty echo\n");

      // 6 second timeout guard
      setTimeout(() => {
        if (validationResolverRef.current) {
          isCapturingValidationRef.current = false;
          validationResolverRef.current = null;
          // Force-send stty echo to recover terminal in guest
          emulator.sendInput("\nstty echo\n");
          resolve(null);
        }
      }, 6000);
    });
  };

  const runV86Backup = (): Promise<string | null> => {
    return new Promise((resolve) => {
      const emulator = v86EmulatorRef.current;
      if (!emulator) {
        resolve(null);
        return;
      }

      console.log("[VM DEBUG] Triggering silent filesystem backup inside guest...");
      isCapturingBackupRef.current = true;
      backupBufferRef.current = "";
      backupResolverRef.current = (done) => {
        if (done) {
          const output = backupBufferRef.current;
          const startIndex = output.indexOf("BACKUP_START");
          const endIndex = output.indexOf("BACKUP_END");
          if (startIndex !== -1 && endIndex !== -1) {
            const b64Data = output.substring(startIndex + "BACKUP_START".length, endIndex)
              .replace(/\r?\n/g, "")
              .trim();
            console.log("[VM DEBUG] Filesystem backup captured successfully. Base64 length:", b64Data.length);
            resolve(b64Data);
          } else {
            console.warn("[VM DEBUG] BACKUP delimiters not found in output:", output);
            resolve(null);
          }
        } else {
          resolve(null);
        }
      };

      // Send silent backup command sequence: stty -echo, print delimiters, tar + base64, restore stty echo
      emulator.sendInput("\nstty -echo\necho \"BACKUP_START\"\ntar -czf - -C /home/user . 2>/dev/null | base64\necho \"BACKUP_END\"\nstty echo\n");

      // 10 second timeout guard
      setTimeout(() => {
        if (backupResolverRef.current) {
          isCapturingBackupRef.current = false;
          backupResolverRef.current = null;
          // Force-send stty echo to recover terminal in guest
          emulator.sendInput("\nstty echo\n");
          console.warn("[VM DEBUG] Filesystem backup request timed out after 10s.");
          resolve(null);
        }
      }, 10000);
    });
  };
  
  // Create refs to access the latest state in the event loop callbacks
  const stateRef = useRef(osState);
  useEffect(() => {
    stateRef.current = osState;
  }, [osState]);

  const onCommandLoggedRef = useRef(onCommandLogged);
  const onDbFallbackRef = useRef(onDbFallback);
  useEffect(() => {
    onCommandLoggedRef.current = onCommandLogged;
    onDbFallbackRef.current = onDbFallback;
  }, [onCommandLogged, onDbFallback]);

  // Auto-save WASM VM state periodically (disabled for reliability)
  useEffect(() => {
    // Snapshots/autosave disabled for reliability.
  }, [isV86Mode, v86Booting, isV86Running]);

  // Handle clearSignal from parent
  useEffect(() => {
    if (clearSignal === 0) return;
    if (activeTermRef.current) {
      activeTermRef.current.clear();
      activeTermRef.current.write(getPromptString(stateRef.current));
    }
  }, [clearSignal]);

  // Load state from local storage on mount (hydration)
  useEffect(() => {
    const saved = localStorage.getItem("linlearn_virtual_os");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        parsed.packages = new Set(parsed.packages);
        setOsState(parsed);
      } catch (e) {
        console.error("Failed to restore virtual OS state:", e);
      }
    }
  }, []);

  // Persist state on change
  useEffect(() => {
    const serialized = {
      ...osState,
      packages: Array.from(osState.packages),
    };
    localStorage.setItem("linlearn_virtual_os", JSON.stringify(serialized));
  }, [osState]);

  // Reset function
  const handleResetSandbox = () => {
    const confirmed = window.confirm("Are you sure you want to reset the Virtual Linux Sandbox? This will restore initial files, containers, and services.");
    if (confirmed) {
      const fresh = getInitialState();
      setOsState(fresh);
      setLastCommand("");
      if (activeTermRef.current) {
        activeTermRef.current.clear();
        activeTermRef.current.write("\r\n\x1b[1;33mSystem restored. Virtual filesystem, Docker, and services refreshed.\x1b[0m\r\n\r\n");
        activeTermRef.current.write(getPromptString(fresh));
      }
    }
  };

  // Helper to get prompt string
  const getPromptString = (state: VirtualSystemState) => {
    const promptPath = state.cwd.startsWith("/home/user")
      ? state.cwd.replace("/home/user", "~")
      : state.cwd;
    const symbol = state.currentUser === "root" ? "#" : "$";
    return `\x1b[1;32m${state.currentUser}@linlearn\x1b[0m:\x1b[1;34m${promptPath}\x1b[0m${symbol} `;
  };

  // Missions completion checks
  const missions = useMemo(() => {
    if (isV86Mode) {
      const categoryMap: Record<string, string> = {
        "Beginner": "Beginner",
        "DevOps": "DevOps",
        "Security": "Security",
        "Interview Prep": "Interview"
      };
      const cat = (categoryMap[learningMode] || "Beginner") as MissionCategory;
      const list = getMissionsByCategory(cat);
      return list.map(m => ({
        id: m.id,
        title: m.title,
        desc: m.desc,
        hint: m.hint,
        completed: !!completedVasmMissions[m.id]
      }));
    }

    const history = osState.history;
    const containers = osState.containers;
    const fs = osState.fs;
    const packages = osState.packages;

    if (learningMode === "Beginner") {
      const m1Complete = history.some((h) => h.trim() === "pwd" || h.trim() === "ls" || h.trim().startsWith("ls "));
      const ProjectsNode = getNode(fs, "/home/user/Projects");
      const m2Complete = !!ProjectsNode && ProjectsNode.type === "dir";
      const configNode = getNode(fs, "/home/user/Projects/config.txt");
      const m3Complete = !!configNode && configNode.type === "file";

      return [
        {
          id: "pwd_ls",
          title: "Explore Directories",
          desc: "Execute 'pwd' and 'ls' to identify active path mappings.",
          hint: "pwd && ls",
          completed: m1Complete
        },
        {
          id: "mkdir_proj",
          title: "Create Work Directory",
          desc: "Create a new sub-folder directory at /home/user/Projects.",
          hint: "mkdir -p /home/user/Projects",
          completed: m2Complete
        },
        {
          id: "touch_config",
          title: "Create Configuration File",
          desc: "Initialize an empty file at /home/user/Projects/config.txt.",
          hint: "touch /home/user/Projects/config.txt",
          completed: m3Complete
        }
      ];
    }

    if (learningMode === "DevOps") {
      const m1Complete = containers.some(
        (c) => c.image.includes("nginx") && c.status.startsWith("Up") && c.ports.includes("80")
      );
      const m2Complete = history.some(
        (h) => h.includes("cat ") && h.includes("access.log")
      );
      const m3Complete = packages.has("htop");

      return [
        {
          id: "nginx",
          title: "Deploy Nginx Container",
          desc: "Start a Docker container running Nginx on port 80.",
          hint: "docker run -d -p 80:80 nginx",
          completed: m1Complete
        },
        {
          id: "logs",
          title: "Investigate Access Logs",
          desc: "Inspect the Nginx access log file to see recent client hits.",
          hint: "cat /var/log/nginx/access.log",
          completed: m2Complete
        },
        {
          id: "htop",
          title: "Install htop Tool",
          desc: "Install the system resource monitor package 'htop' using the package manager.",
          hint: "apt install htop",
          completed: m3Complete
        }
      ];
    }

    if (learningMode === "Security") {
      const deployNode = getNode(fs, "/home/user/Projects/deploy.sh");
      const m1Complete = !!deployNode && deployNode.type === "file" && deployNode.permissions.includes("x");
      const configNode = getNode(fs, "/home/user/Projects/config.txt");
      const m2Complete = !!configNode && !configNode.permissions.includes("w");
      const m3Complete = history.some((h) => h.includes("rm -rf") || h.includes("chmod 777 /") || h.includes("mkfs"));

      return [
        {
          id: "permissions",
          title: "Create Executable Script",
          desc: "Create a file at /home/user/Projects/deploy.sh and make it executable.",
          hint: "touch /home/user/Projects/deploy.sh && chmod +x /home/user/Projects/deploy.sh",
          completed: m1Complete
        },
        {
          id: "lock_config",
          title: "Lock Config Permissions",
          desc: "Remove write access permissions from /home/user/Projects/config.txt.",
          hint: "chmod 400 /home/user/Projects/config.txt",
          completed: m2Complete
        },
        {
          id: "audit_dangerous",
          title: "Audit Sandbox Safeguards",
          desc: "Test security safeguards by executing a dangerous command (e.g. rm -rf /).",
          hint: "rm -rf /",
          completed: m3Complete
        }
      ];
    }

    // Interview Prep
    const m1Complete = history.some((h) => h.includes("uname") || h.includes("whoami"));
    const m2Complete = history.some((h) => h.includes("systemctl") || h.includes("service"));
    const m3Complete = history.some((h) => h.includes("ps") || h.includes("top"));

    return [
      {
        id: "sysinfo",
        title: "Query System Info",
        desc: "Query virtual hostname and current user login context.",
        hint: "whoami && uname -a",
        completed: m1Complete
      },
      {
        id: "services",
        title: "Review systemd Status",
        desc: "Inspect active service configurations on the system.",
        hint: "systemctl status nginx.service",
        completed: m2Complete
      },
      {
        id: "processes",
        title: "Inspect Process Tree",
        desc: "Query standard process listing tables.",
        hint: "ps aux",
        completed: m3Complete
      }
    ];
  }, [osState, learningMode, isV86Mode, completedVasmMissions]);

  // Track completed missions count
  const completedCount = useMemo(() => missions.filter((m) => m.completed).length, [missions]);

  // Command explanation extraction based on last run command
  const commandExpl = useMemo(() => {
    if (!lastCommand) return null;
    const baseCmd = lastCommand.trim().split(/\s+/)[0];
    const match = COMMAND_HELP_INFO[baseCmd];
    if (!match) return null;

    // Match active flags in lastCommand
    const flagsUsed: { flag: string; desc: string }[] = [];
    Object.keys(match.flags).forEach((f) => {
      if (lastCommand.includes(f)) {
        flagsUsed.push({ flag: f, desc: match.flags[f] });
      }
    });

    return {
      ...match,
      flagsUsed
    };
  }, [lastCommand]);

  // Initialize xterm.js instance
  useEffect(() => {
    const persistenceManager = persistenceManagerRef.current;
    let isMounted = true;
    let term: Terminal;
    let fitAddon: FitAddon;

    const initTerm = async () => {
      // Dynamic import to prevent Node.js environment build errors
      const { Terminal } = await import("xterm");
      const { FitAddon } = await import("xterm-addon-fit");

      if (!isMounted) return;

      const theme = themeColors[prefs.theme] || themeColors.green;
      const fontSizeMap = { small: 12, medium: 14, large: 16 };

      term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        theme: {
          background: theme.background,
          foreground: theme.foreground,
          cursor: theme.cursor,
          cursorAccent: theme.background,
          selectionBackground: "rgba(233,84,32,0.3)",
        },
        fontSize: fontSizeMap[prefs.fontSize] || 14,
        fontFamily: "JetBrains Mono, Ubuntu Mono, Courier New, monospace",
        convertEol: true,
        rows: 25,
        disableStdin: false, // Explicitly enable stdin input capture
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      if (terminalRef.current) {
        // Prevent duplicate terminal container leak
        terminalRef.current.innerHTML = "";
        term.open(terminalRef.current);
        fitAddon.fit();

        const handleFocus = () => {
          console.log("[xterm DEBUG] Focus event detected on term.element");
          setIsFocused(true);
        };
        const handleBlur = () => {
          console.log("[xterm DEBUG] Blur event detected on term.element");
          setIsFocused(false);
        };

        if (term.element) {
          term.element.addEventListener("focus", handleFocus);
          term.element.addEventListener("blur", handleBlur);
        }

        const customTerm = term as unknown as CustomTerminal;
        customTerm._handleFocus = handleFocus;
        customTerm._handleBlur = handleBlur;
      }

      const localForceFocus = () => {
        if (!isMounted) return;
        console.log("[xterm DEBUG] Forcing local terminal focus on term and helper textarea...");
        term.focus();
        const textarea = terminalRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
        if (textarea) {
          console.log("[xterm DEBUG] Directly focusing helper textarea element.");
          textarea.focus();
        }
      };

      xtermInstance.current = term;
      activeTermRef.current = term;

      if (isV86Mode) {
        // --- WASM v86 VM Mode ---
        term.write("\x1b[1;36mInitializing v86 WebAssembly x86 Virtual Machine...\x1b[0m\r\n");
        term.write(" * Checking for saved state snapshot in local storage...\r\n");
        
        setV86Booting(true);
        setIsV86Running(false);

        let emulator = VMController.getActiveInstance();
        const isReattached = !!emulator;
        if (!emulator) {
          emulator = new VMController();
          VMController.setActiveInstance(emulator);
        }
        v86EmulatorRef.current = emulator;

        // Frame-batched serial output rendering for butter smooth performance
        let serialBuffer = "";
        let rafId: number | null = null;

        const flushSerial = () => {
          if (!isMounted) return;
          if (serialBuffer.length > 0 && activeTermRef.current) {
            activeTermRef.current.write(serialBuffer);
            serialBuffer = "";
          }
          rafId = requestAnimationFrame(flushSerial);
        };
        rafId = requestAnimationFrame(flushSerial);

        // Store rafId on custom terminal properties to cancel it on unmount
        (term as CustomTerminal)._rafId = rafId;

        const onSerial = (char: string) => {
          if (!isMounted) return;

          // Maintain rolling logs of command output
          lastOutputRef.current += char;
          if (lastOutputRef.current.length > 5000) {
            lastOutputRef.current = lastOutputRef.current.substring(lastOutputRef.current.length - 5000);
          }

          // Intercept output during silent validation
          if (isCapturingValidationRef.current && validationResolverRef.current) {
            validationBufferRef.current += char;
            if (validationBufferRef.current.includes("INSPECT_END")) {
              const resolve = validationResolverRef.current;
              validationResolverRef.current = null;
              isCapturingValidationRef.current = false;
              resolve(true); // Signal inspect done
            }
            return;
          }

          // Intercept output during silent backup
          if (isCapturingBackupRef.current && backupResolverRef.current) {
            backupBufferRef.current += char;
            if (backupBufferRef.current.includes("BACKUP_END")) {
              const resolve = backupResolverRef.current;
              backupResolverRef.current = null;
              isCapturingBackupRef.current = false;
              resolve(true); // Signal backup done
            }
            return;
          }

          // Standard terminal bridge
          serialBuffer += char;
        };

        const onState = (newState: string) => {
          if (!isMounted) return;
          setVmStateName(newState);

          let isBooted = false;
          if (v86EmulatorRef.current) {
            const fullState = v86EmulatorRef.current.getFullLifecycleState();
            setProvisioningState(fullState.provisioning);
            setTerminalState(fullState.terminal);
            setRecoveryState(fullState.recovery);
            setBootComplete(fullState.bootComplete);
            isBooted = fullState.bootComplete;

            if (fullState.recovery === "recovering" && fullState.bootComplete) {
              if (activeTermRef.current) {
                activeTermRef.current.write(`\r\n\x1b[1;33m[VM] Filesystem synchronization recovering...\x1b[0m\r\n`);
              }
            }
          }

          if (newState === "error") {
            if (activeTermRef.current) {
              if (isBooted) {
                activeTermRef.current.write(`\r\n\x1b[1;33mWarning: Provisioning recovery in progress...\x1b[0m\r\n`);
              } else {
                activeTermRef.current.write(`\r\n\x1b[1;31mError: Failed to boot guest virtual machine.\x1b[0m\r\n`);
                setV86Booting(false);
                setIsV86Running(false);
              }
            }
          } else if (newState === "ready" || (isBooted && (newState === "provision_preparing" || newState === "provisioning" || newState === "shell_ready" || newState === "terminal_ready"))) {
            setV86Booting(false);
            setIsV86Running(true);
            setTimeout(() => {
              localForceFocus();
            }, 200);
          } else if (newState === "provisioning") {
            setV86Booting(true);
            setIsV86Running(false);
          } else if (newState === "stopping") {
            // Graceful shutdown in progress — show as not running
            setV86Booting(false);
            setIsV86Running(false);
          } else if (newState === "stopped") {
            setV86Booting(false);
            setIsV86Running(false);
          } else if (newState === "booting" || newState === "loading") {
            setV86Booting(true);
            setIsV86Running(false);
          }
        };

        if (isReattached) {
          term.write(" * Reattaching to active VM session...\r\n");
          emulator.reattach(onSerial, onState);
          
          // Re-sync local flags from emulator state
          const currentVmState = emulator.getLifecycleState().state;
          setVmStateName(currentVmState);
          const fullState = emulator.getFullLifecycleState();
          setProvisioningState(fullState.provisioning);
          setTerminalState(fullState.terminal);
          setRecoveryState(fullState.recovery);
          setBootComplete(fullState.bootComplete);

          const isBooted = fullState.bootComplete;
          if (currentVmState === "ready" || (isBooted && (currentVmState === "provision_preparing" || currentVmState === "provisioning" || currentVmState === "shell_ready" || currentVmState === "terminal_ready"))) {
            setV86Booting(false);
            setIsV86Running(true);
            setTimeout(() => {
              localForceFocus();
            }, 150);
          } else if (currentVmState === "provisioning") {
            setV86Booting(true);
            setIsV86Running(false);
          } else {
            setV86Booting(true);
            setIsV86Running(false);
          }
        } else {
          try {
            // 1. Fetch saved state snapshot
            const savedState = await persistenceManager.loadState("default_session");
            savedStateRef.current = savedState;
            if (!isMounted) {
              term.dispose();
              if (rafId !== null) cancelAnimationFrame(rafId);
              return;
            }

            if (savedState) {
              term.write(" * Found saved snapshot. Restoring VM state...\r\n");
              setHasSavedState(true);
            } else {
              term.write(" * No snapshot found. Performing cold boot...\r\n");
              setHasSavedState(false);
              lastOutputRef.current = "";
              emulator.clearSerialHistory();
            }

            // 2. Start VM
            try {
              await emulator.start(window.location.origin, onSerial, onState, savedState || undefined);
              if (!isMounted) {
                term.dispose();
                if (rafId !== null) cancelAnimationFrame(rafId);
                return;
              }
            } catch (bootErr) {
              if (!isMounted) {
                term.dispose();
                if (rafId !== null) cancelAnimationFrame(rafId);
                return;
              }
              if (savedState) {
                term.write("\r\n\x1b[1;33m[VM] Snapshot restoration failed. Clearing corrupted state and performing cold boot...\x1b[0m\r\n");
                await persistenceManager.clearState("default_session");
                setHasSavedState(false);
                // Fallback to cold boot
                await emulator.start(window.location.origin, onSerial, onState, undefined);
                if (!isMounted) {
                  term.dispose();
                  if (rafId !== null) cancelAnimationFrame(rafId);
                  return;
                }
              } else {
                throw bootErr;
              }
            }
          } catch (err: unknown) {
            if (!isMounted) {
              term.dispose();
              if (rafId !== null) cancelAnimationFrame(rafId);
              return;
            }
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error("Failed to load v86 VM:", err);
            term.write(`\r\n\x1b[1;31mError: Failed to load VM. ${errMsg}\x1b[0m\r\n`);
            setV86Booting(false);
          }
        }

        // 3. Setup client key handler to bridge typed commands
        let currentLine = "";
        const dataDisposable = term.onData((data) => {
          console.log("[xterm DEBUG] onData event:", { data, charCodes: Array.from(data).map(c => c.charCodeAt(0)) });
          if (isCapturingValidationRef.current) {
            console.log("[xterm DEBUG] onData skipped: validation in progress");
            return;
          }
          if (!v86EmulatorRef.current) return;
          const fullState = v86EmulatorRef.current.getFullLifecycleState();
          const vmState = fullState.runtime;
          const provState = fullState.provisioning;
          const isProvisioningActive = provState === "preparing" || provState === "transferring" || provState === "executing" || provState === "waiting_completion";
          
          if (isProvisioningActive) {
            console.warn("[xterm DEBUG] onData ignored: provisioning in progress");
            return;
          }

          if (vmState !== "ready" && vmState !== "provision_preparing" && vmState !== "provisioning" && vmState !== "booting" && vmState !== "shell_ready" && vmState !== "terminal_ready") {
            console.warn("[xterm DEBUG] onData ignored: VM not in interactive state:", vmState);
            return;
          }

          if (data === "\r" || data === "\n") {
            if (currentLine.trim()) {
              lastCommandRef.current = currentLine.trim();
              
              // Trigger auto-save debounced snapshot loop!
              persistenceManager.triggerAutosave("default_session", async () => {
                if (v86EmulatorRef.current) {
                  setIsPersistenceSaving(true);
                  try {
                    const b64Backup = await runV86Backup();
                    if (b64Backup) {
                      const rawSnapshot = base64ToArrayBuffer(b64Backup);
                      savedStateRef.current = rawSnapshot;
                      setHasSavedState(true);
                      return rawSnapshot;
                    }
                  } catch (e) {
                    console.error("Autosave backup failed:", e);
                  } finally {
                    setIsPersistenceSaving(false);
                  }
                }
                return null;
              });
            }
            currentLine = "";
          } else if (data === "\x7f" || data === "\b") {
            currentLine = currentLine.slice(0, -1);
          } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
            currentLine += data;
          }
          if (v86EmulatorRef.current) {
            v86EmulatorRef.current.sendInput(data);
          }
        });

        term.attachCustomKeyEventHandler((ev) => {
          console.log("[xterm DEBUG] attachCustomKeyEventHandler event:", ev.type, ev.key, "keyCode:", ev.keyCode);
          if (isCapturingValidationRef.current) {
            return false;
          }
          if (!v86EmulatorRef.current) return false;
          const vmState = v86EmulatorRef.current.getLifecycleState().state;
          if (vmState !== "ready" && vmState !== "provision_preparing" && vmState !== "provisioning" && vmState !== "booting" && vmState !== "shell_ready" && vmState !== "terminal_ready") {
            console.warn("[xterm DEBUG] attachCustomKeyEventHandler rejected: VM not in interactive state:", vmState);
            return false;
          }
          if (ev.ctrlKey && ev.type === "keydown") {
            const code = ev.key.toLowerCase();
            if (code === "c") {
              if (v86EmulatorRef.current) v86EmulatorRef.current.sendInput("\x03");
              return false;
            }
            if (code === "z") {
              if (v86EmulatorRef.current) v86EmulatorRef.current.sendInput("\x1a");
              return false;
            }
            if (code === "d") {
              if (v86EmulatorRef.current) v86EmulatorRef.current.sendInput("\x04");
              return false;
            }
          }
          return true;
        });

        const customTerm = term as unknown as CustomTerminal;
        customTerm._v86Disposable = dataDisposable;
      } else {
        // --- Standard JS Simulation Mode ---
        term.write("\x1b[1;36mWelcome to the LinLearn Virtual Training Environment!\x1b[0m\r\n");
        term.write(" * Documentation:  \x1b[4mhttps://linlearn.dev/docs\x1b[0m\r\n");
        term.write(" * System Sandbox: \x1b[1;32mActive (100% Secure, No host access)\x1b[0m\r\n\r\n");
        term.write("Virtual subsystems hydrated. Try running: \x1b[1;33mdocker ps\x1b[0m, \x1b[1;33mps aux\x1b[0m, or \x1b[1;33mapt install htop\x1b[0m.\r\n");
        term.write("Type \x1b[1;32mhelp\x1b[0m or \x1b[1;32mman\x1b[0m for commands lists.\r\n\r\n");
        term.write(getPromptString(stateRef.current));

        let inputBuffer = "";
        let cursorIndex = 0;
        let historyIndex: number | null = null;
        let historyDraft = "";

        const keyDisposable = term.onKey((e: { key: string; domEvent: KeyboardEvent }) => {
          const char = e.key;
          const domEvent = e.domEvent;

          if (domEvent.keyCode === 13) {
            // Enter key
            term.write("\r\n");
            const cmd = inputBuffer.trim();
            if (cmd) {
              // Process command
              const result = executeCommand(cmd, stateRef.current);
              
              // Format and print output
              if (result.shouldClear) {
                term.clear();
              } else {
                term.write(result.output.replace(/\r?\n/g, "\r\n"));
                if (result.output && !result.output.endsWith("\n")) {
                  term.write("\r\n");
                }
              }

              // Save in history
              const nextHistory = [...stateRef.current.history, cmd];
              const updatedState = {
                ...result.newState,
                history: nextHistory
              };

              setOsState(updatedState);
              setLastCommand(cmd);

              // Update BKT cognitive modeling
              const baseCmd = cmd.trim().split(/\s+/)[0];
              const isCorrect = !result.output.includes("command not found") && !result.output.toLowerCase().includes("error");
              const topic = COMMAND_TOPICS[baseCmd];
              if (topic) {
                updateBKT(topic, isCorrect);
              }

              // Log command (for XP and DB record syncing)
              onCommandLoggedRef.current({
                id: Math.random().toString(36).substring(2, 10),
                input: cmd,
                output: result.output,
                source: "local",
                createdAt: new Date().toISOString()
              });

              // Trigger fallback check if command not found
              if (result.output.includes("command not found")) {
                onDbFallbackRef.current();
              }
            } else {
              term.write("\r");
            }

            inputBuffer = "";
            cursorIndex = 0;
            historyIndex = null;
            historyDraft = "";
            term.write(getPromptString(stateRef.current));

          } else if (domEvent.keyCode === 8) {
            // Backspace key
            if (cursorIndex > 0) {
              inputBuffer = inputBuffer.slice(0, cursorIndex - 1) + inputBuffer.slice(cursorIndex);
              cursorIndex--;
              term.write("\b");
              term.write(inputBuffer.slice(cursorIndex) + " ");
              const moveBack = inputBuffer.length - cursorIndex + 1;
              term.write("\x1b[" + moveBack + "D");
            }

          } else if (domEvent.keyCode === 46) {
            // Delete key
            if (cursorIndex < inputBuffer.length) {
              inputBuffer = inputBuffer.slice(0, cursorIndex) + inputBuffer.slice(cursorIndex + 1);
              term.write(inputBuffer.slice(cursorIndex) + " ");
              const moveBack = inputBuffer.length - cursorIndex + 1;
              term.write("\x1b[" + moveBack + "D");
            }

          } else if (domEvent.keyCode === 37) {
            // Left Arrow
            if (cursorIndex > 0) {
              cursorIndex--;
              term.write("\x1b[D");
            }

          } else if (domEvent.keyCode === 39) {
            // Right Arrow
            if (cursorIndex < inputBuffer.length) {
              cursorIndex++;
              term.write("\x1b[C");
            }

          } else if (domEvent.keyCode === 36) {
            // Home key
            if (cursorIndex > 0) {
              term.write("\x1b[" + cursorIndex + "D");
              cursorIndex = 0;
            }

          } else if (domEvent.keyCode === 35) {
            // End key
            const diff = inputBuffer.length - cursorIndex;
            if (diff > 0) {
              term.write("\x1b[" + diff + "C");
              cursorIndex = inputBuffer.length;
            }

          } else if (domEvent.keyCode === 38) {
            // Arrow Up (History Navigation)
            domEvent.preventDefault();
            const hist = stateRef.current.history;
            if (hist.length === 0) return;

            if (historyIndex === null) {
              historyDraft = inputBuffer;
              historyIndex = hist.length - 1;
            } else {
              historyIndex = Math.max(0, historyIndex - 1);
            }

            if (cursorIndex > 0) {
              term.write("\x1b[" + cursorIndex + "D");
            }
            term.write("\x1b[K"); // Clear to end of line
            
            inputBuffer = hist[historyIndex];
            term.write(inputBuffer);
            cursorIndex = inputBuffer.length;

          } else if (domEvent.keyCode === 40) {
            // Arrow Down
            domEvent.preventDefault();
            const hist = stateRef.current.history;
            if (historyIndex === null) return;

            if (cursorIndex > 0) {
              term.write("\x1b[" + cursorIndex + "D");
            }
            term.write("\x1b[K"); // Clear to end of line

            if (historyIndex === hist.length - 1) {
              historyIndex = null;
              inputBuffer = historyDraft;
            } else {
              historyIndex += 1;
              inputBuffer = hist[historyIndex];
            }
            
            term.write(inputBuffer);
            cursorIndex = inputBuffer.length;

          } else if (domEvent.keyCode === 9) {
            // Tab (Autocomplete)
            domEvent.preventDefault();
            const parts = inputBuffer.split(/\s+/);
            const lastWord = parts[parts.length - 1] || "";
            
            const dirNode = getNode(stateRef.current.fs, stateRef.current.cwd);
            if (dirNode && dirNode.type === "dir") {
              const options = [
                ...Object.keys(dirNode.children),
                ...Object.keys(COMMAND_HELP_INFO)
              ];
              const matches = Array.from(new Set(options)).filter((opt) => opt.startsWith(lastWord));

              if (matches.length === 1) {
                const matchNode = getNode(stateRef.current.fs, resolvePath(stateRef.current.cwd, matches[0]));
                const suffix = matchNode && matchNode.type === "dir" ? "/" : "";
                const completion = matches[0].substring(lastWord.length) + suffix;
                
                const prefix = inputBuffer.slice(0, cursorIndex);
                const suffixStr = inputBuffer.slice(cursorIndex);
                inputBuffer = prefix + completion + suffixStr;
                term.write(completion + suffixStr);
                if (suffixStr.length > 0) {
                  term.write("\x1b[" + suffixStr.length + "D");
                }
                cursorIndex += completion.length;
              } else if (matches.length > 1) {
                term.write("\r\n" + matches.join("    ") + "\r\n");
                term.write(getPromptString(stateRef.current) + inputBuffer);
                const diff = inputBuffer.length - cursorIndex;
                if (diff > 0) {
                  term.write("\x1b[" + diff + "D");
                }
              }
            }

          } else if (domEvent.ctrlKey && domEvent.key.toLowerCase() === "c") {
            term.write("^C\r\n");
            inputBuffer = "";
            cursorIndex = 0;
            historyIndex = null;
            term.write(getPromptString(stateRef.current));

          } else if (domEvent.ctrlKey && domEvent.key.toLowerCase() === "l") {
            domEvent.preventDefault();
            term.clear();
            term.write(getPromptString(stateRef.current) + inputBuffer);
            const diff = inputBuffer.length - cursorIndex;
            if (diff > 0) {
              term.write("\x1b[" + diff + "D");
            }

          } else {
            if (char.length === 1 && !domEvent.altKey && !domEvent.ctrlKey && !domEvent.metaKey) {
              if (cursorIndex === inputBuffer.length) {
                inputBuffer += char;
                cursorIndex++;
                term.write(char);
              } else {
                inputBuffer = inputBuffer.slice(0, cursorIndex) + char + inputBuffer.slice(cursorIndex);
                term.write(inputBuffer.slice(cursorIndex));
                cursorIndex++;
                const moveBack = inputBuffer.length - cursorIndex;
                if (moveBack > 0) {
                  term.write("\x1b[" + moveBack + "D");
                }
              }
            }
          }
        });

        const customTerm = term as unknown as CustomTerminal;
        customTerm._simDisposable = keyDisposable;
      }
    };

    initTerm();

    const resizeObserver = new ResizeObserver(() => {
      if (fitAddon && term) {
        try {
          fitAddon.fit();
        } catch {}
      }
    });

    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    return () => {
      isMounted = false;
      resizeObserver.disconnect();
      if (term) {
        const customTerm = term as unknown as CustomTerminal;
        if (customTerm._simDisposable) {
          customTerm._simDisposable.dispose();
        }
        if (customTerm._v86Disposable) {
          customTerm._v86Disposable.dispose();
        }
        if (customTerm._rafId) {
          cancelAnimationFrame(customTerm._rafId);
        }
        if (term.element) {
          if (customTerm._handleFocus) {
            term.element.removeEventListener("focus", customTerm._handleFocus);
          }
          if (customTerm._handleBlur) {
            term.element.removeEventListener("blur", customTerm._handleBlur);
          }
        }
        term.dispose();
      }
      activeTermRef.current = null;
      setIsV86Running(false);
      if (v86EmulatorRef.current) {
        v86EmulatorRef.current.detach();
      }
      persistenceManager.cancelPendingSaves();
    };
  }, [prefs.theme, prefs.fontSize, isV86Mode, termResetCounter]);

  return (
    <div className="space-y-4">
      {/* Title & Control Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
            <TermIcon className="h-6 w-6 text-[#E95420]" />
            Immersive Ubuntu Terminal
          </h2>
          <p className="mt-1 text-sm text-gray-400">
            Learn commands safely via an interactive sandbox environment with live state tracking.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setIsV86Mode(!isV86Mode)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all ${
              isV86Mode 
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20" 
                : "border-white/10 bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            <TermIcon className="h-3.5 w-3.5" />
            {isV86Mode ? "Simulation Mode" : "WASM VM Mode"}
          </button>
          {isV86Mode && (
            <>
              <button
                onClick={() => setTermResetCounter(prev => prev + 1)}
                className="flex items-center gap-2 rounded-lg border border-[#E95420]/35 bg-[#E95420]/10 px-3 py-1.5 text-xs font-semibold text-[#E95420] transition-all hover:bg-[#E95420]/20 hover:text-white"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reconnect Terminal
              </button>
              <button
                onClick={handleResetV86State}
                className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-400 transition-all hover:bg-rose-500/20 hover:text-white"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reset VM State
              </button>
            </>
          )}
          {!isV86Mode && (
            <button
              onClick={handleResetSandbox}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-300 transition-all hover:bg-white/10 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reset Sandbox VM
            </button>
          )}
        </div>
      </div>

      {/* Main Layout Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-10">
        
        {/* Left: Terminal container (70% width) */}
        <div 
          onClick={() => {
            if (xtermInstance.current) {
              console.log("[xterm DEBUG] Container click detected. Forcing focus...");
              xtermInstance.current.focus();
              const textarea = terminalRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
              if (textarea) {
                console.log("[xterm DEBUG] Directly focusing helper textarea element on click.");
                textarea.focus();
              }
            }
          }}
          className={`lg:col-span-7 flex flex-col rounded-xl border transition-all duration-200 bg-[#06070a] overflow-hidden shadow-2xl cursor-text ${
            isFocused 
              ? "border-[#E95420] ring-1 ring-[#E95420]/35 shadow-lg shadow-[#E95420]/5" 
              : "border-white/10"
          }`}
        >
          {/* Simulated Ubuntu window header */}
          <div className="flex items-center justify-between bg-[#15161c] px-4 py-2 border-b border-white/5">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full bg-rose-500/80" />
              <div className="h-3 w-3 rounded-full bg-amber-500/80" />
              <div className="h-3 w-3 rounded-full bg-emerald-500/80" />
              <span className="ml-2 text-xs font-semibold text-gray-400 font-mono select-none">
                {isV86Mode ? "user@linlearn: ~" : `user@linlearn: ${osState.cwd} (virtual OS)`}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono text-gray-500">
              <span>bash</span>
            </div>
          </div>
          
          {/* Terminal Canvas Container */}
          <div className="p-2 min-h-[500px] flex-1 flex flex-col justify-stretch relative">
            {isV86Mode && (
              vmStateName === "loading" || 
              vmStateName === "booting" || 
              (vmStateName === "provisioning" && !bootComplete) || 
              (vmStateName === "shell_ready" && !bootComplete) || 
              (vmStateName === "terminal_ready" && !bootComplete) || 
              vmStateName === "idle" || 
              vmStateName === "stopping" ||
              (recoveryState === "recovering" && !bootComplete) ||
              recoveryState === "crashloop"
            ) && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#06070a]/90 gap-3">
                <RefreshCw className="h-8 w-8 text-[#E95420] animate-spin" />
                <span className="text-sm font-mono text-gray-400">
                  {recoveryState === "crashloop" ? "Virtual Machine in Crash Loop!" :
                   recoveryState === "recovering" ? "Attempting Self-Healing Recovery..." :
                   vmStateName === "loading" ? "Downloading WebAssembly & Linux Kernel..." :
                   vmStateName === "booting" ? "Booting Real Linux Kernel in WASM..." :
                   vmStateName === "provision_preparing" ? "Preparing Environment Configuration..." :
                   vmStateName === "provisioning" ? "Provisioning User Environment Silently..." :
                   vmStateName === "shell_ready" ? "Verifying Shell Readiness..." :
                   vmStateName === "terminal_ready" ? "Synchronizing Terminal Interface..." :
                   "Initializing Virtual Machine..."}
                </span>
                <span className="text-xs font-mono text-gray-600">
                  {recoveryState === "crashloop" ? "Please click 'Reset VM State' to restore factory settings." :
                   recoveryState === "recovering" ? "Running recovery escalation routines..." :
                   vmStateName === "loading" ? "Downloading Buildroot disk image (~10MB)" :
                   vmStateName === "booting" ? "Decompressing kernel & starting x86 CPU" :
                   vmStateName === "provision_preparing" ? "Initializing atomic transport layer" :
                   vmStateName === "provisioning" ? "Configuring user login & inspect hooks" :
                   vmStateName === "shell_ready" ? "Establishing deterministic login shell handshake" :
                   vmStateName === "terminal_ready" ? "Draining stdout buffers & running health checks" :
                   "Configuring virtual resources (96MB RAM)"}
                </span>
              </div>
            )}
            <div 
              ref={terminalRef} 
              className="w-full flex-1 overflow-hidden cursor-text" 
              style={{ minHeight: "480px" }}
            />
            {isV86Mode && (
              <div className="flex items-center justify-between bg-black/40 border-t border-white/5 px-4 py-2 text-xs font-mono text-gray-500 rounded-b-lg">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${
                      recoveryState === "crashloop" ? "bg-rose-600 animate-ping" :
                      recoveryState === "recovering" ? "bg-amber-500 animate-ping" :
                      vmStateName === "ready" ? "bg-emerald-500 animate-pulse" : 
                      (vmStateName === "booting" || vmStateName === "provision_preparing" || vmStateName === "provisioning" || vmStateName === "loading" || vmStateName === "shell_ready" || vmStateName === "terminal_ready") ? "bg-amber-500 animate-pulse" : 
                      vmStateName === "stopping" ? "bg-orange-500 animate-pulse" :
                      vmStateName === "error" ? "bg-rose-500 animate-pulse" : "bg-gray-500"
                    }`} />
                    <span>Status: <span className="uppercase text-[10px] font-bold px-1.5 py-0.5 rounded bg-white/5">{
                      recoveryState === "crashloop" ? "crashloop" :
                      recoveryState === "recovering" ? "recovering" :
                      vmStateName
                    }</span></span>
                    {recoveryState === "recovering" && bootComplete && (
                      <span className="text-amber-500 animate-pulse ml-2 text-[10px] font-bold tracking-wider">
                        Filesystem synchronization recovering...
                      </span>
                    )}
                  </div>
                  {bootTimeRef.current !== null && (
                    <div>Boot: {(bootTimeRef.current / 1000).toFixed(1)}s</div>
                  )}
                  <div>RAM: 96MB</div>
                  <div className="hidden sm:block">TTY: <span className="uppercase text-[9px] font-bold text-gray-400 bg-white/5 px-1 py-0.5 rounded">{terminalState}</span></div>
                  <div className="hidden sm:block">Setup: <span className="uppercase text-[9px] font-bold text-gray-400 bg-white/5 px-1 py-0.5 rounded">{provisioningState}</span></div>
                </div>
                <div className="flex items-center gap-2">
                  {isPersistenceSaving ? (
                    <>
                      <RefreshCw className="h-3 w-3 animate-spin text-emerald-400" />
                      <span className="text-emerald-400">Saving Snapshot...</span>
                    </>
                  ) : hasSavedState ? (
                    <span className="text-emerald-500/80">Snapshot Synced (IndexedDB)</span>
                  ) : (
                    <span className="text-gray-600">No Snapshot Saved</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Learning Dashboard Control Panel (30% width) */}
        <div className="lg:col-span-3 flex flex-col rounded-xl border border-white/10 bg-white/[0.02] backdrop-blur-md overflow-hidden">
          {/* Tab Navigation */}
          <div className="flex border-b border-white/10 bg-white/[0.02]">
            <button
              onClick={() => setActiveTab("missions")}
              className={`flex-1 py-3 text-xs font-bold tracking-wider uppercase border-b-2 flex items-center justify-center gap-1.5 transition-all ${
                activeTab === "missions"
                  ? "border-[#E95420] text-white bg-white/[0.04]"
                  : "border-transparent text-gray-400 hover:text-white"
              }`}
            >
              <Award className="h-3.5 w-3.5" />
              Missions ({completedCount}/{missions.length})
            </button>
            <button
              onClick={() => setActiveTab("explanations")}
              className={`flex-1 py-3 text-xs font-bold tracking-wider uppercase border-b-2 flex items-center justify-center gap-1.5 transition-all ${
                activeTab === "explanations"
                  ? "border-[#E95420] text-white bg-white/[0.04]"
                  : "border-transparent text-gray-400 hover:text-white"
              }`}
            >
              <BookOpen className="h-3.5 w-3.5" />
              Command Info
            </button>
            <button
              onClick={() => setActiveTab("interview")}
              className={`flex-1 py-3 text-xs font-bold tracking-wider uppercase border-b-2 flex items-center justify-center gap-1.5 transition-all ${
                activeTab === "interview"
                  ? "border-[#E95420] text-white bg-white/[0.04]"
                  : "border-transparent text-gray-400 hover:text-white"
              }`}
            >
              <HelpCircle className="h-3.5 w-3.5" />
              Interview Prep
            </button>
          </div>

          {/* Tab Contents */}
          <div className="p-4 flex-1 overflow-y-auto space-y-4 max-h-[500px]">
            {activeTab === "missions" && (
              <div className="space-y-3">
                {/* Learning Mode Selector */}
                <div className="flex flex-col gap-1.5 p-2.5 rounded-lg border border-white/5 bg-black/20 mb-2">
                  <span className="text-[10px] text-gray-500 font-mono uppercase font-bold tracking-wider">Learning Mode:</span>
                  <div className="grid grid-cols-2 gap-1">
                    {(["Beginner", "DevOps", "Security", "Interview Prep"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setLearningMode(mode)}
                        className={`px-2 py-1 rounded text-[10px] font-mono text-center transition-all ${
                          learningMode === mode 
                            ? "bg-[#E95420]/25 text-[#E95420] border border-[#E95420]/30 font-bold" 
                            : "bg-white/5 text-gray-400 border border-transparent hover:text-white"
                        }`}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-emerald-300">Sandbox Challenges</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">Complete missions to log skills and earn XP!</p>
                  </div>
                  <div className="text-right">
                    <span className="text-xl font-extrabold text-emerald-400">{Math.round((completedCount/missions.length)*100)}%</span>
                  </div>
                </div>

                {/* BKT Cognitive Mastery Profile */}
                <div className="p-3 rounded-lg border border-white/5 bg-white/[0.01] space-y-2">
                  <div className="flex items-center justify-between border-b border-white/5 pb-1.5 mb-1.5">
                    <span className="text-[10px] text-gray-400 font-mono uppercase font-bold tracking-wider">Cognitive Mastery Profile</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded font-mono bg-[#E95420]/15 text-[#E95420] border border-[#E95420]/25">
                      Model: BKT Active
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 text-[10px] font-mono">
                    {Object.entries(masteryState).map(([topic, val]) => (
                      <div key={topic} className="space-y-1">
                        <div className="flex justify-between text-gray-400 text-[9px] uppercase">
                          <span>{topic}</span>
                          <span className="text-gray-300">{(val * 100).toFixed(0)}%</span>
                        </div>
                        <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                          <div 
                            className="h-full rounded-full transition-all duration-500 bg-[#E95420]" 
                            style={{ width: `${val * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  {missions.map((mission) => (
                    <div 
                      key={mission.id} 
                      className={`p-3 rounded-lg border transition-all ${
                        mission.completed 
                          ? "bg-emerald-500/5 border-emerald-500/20" 
                          : "bg-white/[0.02] border-white/5 hover:border-white/10"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {mission.completed ? (
                          <CheckCircle className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                        ) : (
                          <div className="h-4 w-4 rounded-full border-2 border-gray-600 shrink-0 mt-0.5" />
                        )}
                        <div>
                          <p className={`text-sm font-semibold ${mission.completed ? "text-gray-300 line-through" : "text-white"}`}>
                            {mission.title}
                          </p>
                          <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                            {mission.desc}
                          </p>
                          {!mission.completed && (
                            <div className="mt-2 flex flex-col gap-1.5">
                              <div className="p-1.5 rounded bg-black/40 border border-white/5 font-mono text-[10px] text-gray-300">
                                <span>{mission.hint}</span>
                              </div>
                              {isV86Mode && (
                                <button
                                  disabled={validatingMissions[mission.id]}
                                  onClick={async () => {
                                    setValidatingMissions(prev => ({ ...prev, [mission.id]: true }));
                                    try {
                                      const guestState = await runV86Validation();
                                      if (guestState) {
                                        // 1. Fetch challenge nonce from server
                                        const challengeRes = await fetch("/api/validate/challenge");
                                        if (!challengeRes.ok) {
                                          throw new Error("Failed to retrieve challenge nonce from server.");
                                        }
                                        const { nonce, expires, signature } = await challengeRes.json();

                                        // 2. Compute the state HMAC on the client
                                        const clientHash = await computeHMAC(nonce, `${mission.id}:true`);

                                        // 3. Post verification payload with challenge details
                                        const res = await fetch("/api/validate", {
                                          method: "POST",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({
                                            missionId: mission.id,
                                            success: true,
                                            guestState,
                                            command: lastCommandRef.current || mission.hint,
                                            output: lastOutputRef.current.substring(lastOutputRef.current.length - 1000), // pass last 1000 chars output
                                            nonce,
                                            expires,
                                            signature,
                                            clientHash
                                          })
                                        });

                                        if (res.ok) {
                                          const verifyData = await res.json();
                                          if (verifyData.verified) {
                                            const grade = verifyData.grade || {
                                              score: 7.5,
                                              feedback: "Successfully verified command execution."
                                            };
                                            setCompletedVasmMissions(prev => ({ ...prev, [mission.id]: true }));
                                            
                                            const missionTopic = MISSION_TOPICS[mission.id] || "navigation";
                                            updateBKT(missionTopic, true);
                                            
                                            if (xtermInstance.current) {
                                              xtermInstance.current.write(`\r\n\x1b[1;32m[Judge Result] Mission Completed! Score: ${grade.score}/10.0\x1b[0m\r\n`);
                                              xtermInstance.current.write(`\x1b[1;30mFeedback: ${grade.feedback}\x1b[0m\r\n`);
                                            }
                                            
                                            onCommandLoggedRef.current({
                                              id: Math.random().toString(36).substring(2, 10),
                                              input: `Verify: ${mission.title}`,
                                              output: `Mission "${mission.title}" verified successfully inside the WASM guest VM and graded by LLM! Score: ${grade.score}/10.0. Feedback: ${grade.feedback}`,
                                              source: "local",
                                              createdAt: new Date().toISOString()
                                            });
                                          } else {
                                            const errorMsg = verifyData.error || "Verification failed.";
                                            if (xtermInstance.current) {
                                              xtermInstance.current.write(`\r\n\x1b[1;31m[Judge Result] Mission Failed: ${errorMsg}\x1b[0m\r\n`);
                                            }
                                            alert(`Verification failed: ${errorMsg}`);
                                            const missionTopic = MISSION_TOPICS[mission.id] || "navigation";
                                            updateBKT(missionTopic, false);
                                          }
                                        } else {
                                          const verifyData = await res.json().catch(() => ({}));
                                          const errorMsg = verifyData.error || "Server validation failed.";
                                          if (xtermInstance.current) {
                                            xtermInstance.current.write(`\r\n\x1b[1;31m[Error] ${errorMsg}\x1b[0m\r\n`);
                                          }
                                          alert(`Server error: ${errorMsg}`);
                                        }
                                      } else {
                                        alert("Could not collect guest VM state. Make sure the VM is running and interactive.");
                                      }
                                    } catch (err: unknown) {
                                      const errMsg = err instanceof Error ? err.message : String(err);
                                      console.error("Failed to submit validation:", err);
                                      alert(`Server communication error: ${errMsg}`);
                                    } finally {
                                      setValidatingMissions(prev => ({ ...prev, [mission.id]: false }));
                                    }
                                  }}
                                  className="w-full py-1 text-[10px] uppercase font-bold text-center border rounded transition-all bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-50"
                                >
                                  {validatingMissions[mission.id] ? "Verifying..." : "Verify Solution"}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === "explanations" && (
              <div className="space-y-4">
                {commandExpl ? (
                  <div className="space-y-3 font-mono">
                    <div className="flex items-center justify-between border-b border-white/10 pb-2">
                      <h3 className="text-lg font-bold text-white">{commandExpl.name}</h3>
                      <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded ${
                        commandExpl.difficulty === "Beginner" 
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                          : commandExpl.difficulty === "Intermediate"
                            ? "bg-amber-500/10 text-amber-300 border border-amber-500/20"
                            : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                      }`}>
                        {commandExpl.difficulty}
                      </span>
                    </div>

                    <div>
                      <p className="text-xs text-gray-300 font-sans leading-relaxed">{commandExpl.desc}</p>
                    </div>

                    {commandExpl.flagsUsed.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Flags Explanations</p>
                        <div className="space-y-1.5">
                          {commandExpl.flagsUsed.map((fu) => (
                            <div key={fu.flag} className="p-2 rounded bg-black/40 border border-white/5 text-xs">
                              <span className="text-[#E95420] font-bold">{fu.flag}</span>
                              <span className="text-gray-400 text-[11px] block mt-0.5 font-sans">{fu.desc}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {commandExpl.related.length > 0 && (
                      <div className="space-y-1.5 border-t border-white/5 pt-2">
                        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Related Commands</p>
                        <div className="flex flex-wrap gap-1">
                          {commandExpl.related.map((rc) => (
                            <span key={rc} className="text-[11px] bg-white/5 border border-white/10 text-gray-300 px-1.5 py-0.5 rounded">
                              {rc}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-8 text-gray-500 font-sans">
                    <p className="text-sm">Run a command in the terminal to view detailed explanations and flags analysis.</p>
                  </div>
                )}
              </div>
            )}

            {activeTab === "interview" && (
              <div className="space-y-3 font-sans">
                <div className="p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                  <p className="text-sm font-semibold text-indigo-300">DevOps Q&A Flashcards</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">Click questions to reveal model answers.</p>
                </div>

                <div className="space-y-2.5">
                  {INTERVIEW_PREP_DATA.map((card, idx) => (
                    <details 
                      key={idx} 
                      className="group p-3 rounded-lg border border-white/5 bg-white/[0.01] hover:border-white/10 transition-all select-none cursor-pointer"
                    >
                      <summary className="text-xs font-semibold text-gray-300 group-open:text-white flex items-center justify-between list-none">
                        <span>{idx + 1}. {card.q}</span>
                        <span className="text-indigo-400 font-bold text-base transition-transform group-open:rotate-45">+</span>
                      </summary>
                      <p className="mt-2 text-[11px] text-gray-400 border-t border-white/5 pt-2 leading-relaxed">
                        {card.a}
                      </p>
                    </details>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
