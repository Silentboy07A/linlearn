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
import { saveV86State, loadV86State, clearV86State } from "@/lib/v86db";
import { updateMastery, DEFAULT_BKT_PARAMS, type LinuxTopic } from "@/lib/bkt";

interface V86StarterInstance {
  save_state: (cb: (err: unknown, state: ArrayBuffer) => void) => void;
  destroy: () => void;
  serial0_send: (data: string) => void;
  add_listener: (event: string, cb: (char: string) => void) => void;
  remove_listener: (event: string, cb: (char: string) => void) => void;
}

interface WindowWithV86 extends Window {
  V86Starter: new (config: {
    wasm_path: string;
    bios: { url: string };
    vga_bios: { url: string };
    bzimage?: { url: string; async?: boolean };
    cdrom?: { url: string };
    cmdline?: string;
    autostart: boolean;
    initial_state?: { buffer: ArrayBuffer };
  }) => V86StarterInstance;
}

interface CustomTerminal extends Terminal {
  _simDisposable?: { dispose: () => void };
  _v86Disposable?: { dispose: () => void };
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

const WASM_MISSION_CHECKS: Record<string, string> = {
  pwd_ls: "true",
  mkdir_proj: "[ -d Projects ] || [ -d /root/Projects ] || [ -d /home/user/Projects ]",
  touch_config: "[ -f Projects/config.txt ] || [ -f /root/Projects/config.txt ] || [ -f /home/user/Projects/config.txt ]",
  nginx: "true", 
  logs: "true",
  htop: "true",
  permissions: "true",
  lock_config: "true",
  audit_dangerous: "true",
  sysinfo: "true",
  services: "true",
  processes: "true"
};

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
  const [isSavingV86, setIsSavingV86] = useState<boolean>(false);

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
  const v86EmulatorRef = useRef<V86StarterInstance | null>(null);
  
  const [completedVasmMissions, setCompletedVasmMissions] = useState<Record<string, boolean>>({});
  const [validatingMissions, setValidatingMissions] = useState<Record<string, boolean>>({});
  const isCapturingValidationRef = useRef<boolean>(false);

  const updateBKT = (topic: LinuxTopic, correct: boolean) => {
    setMasteryState(prev => {
      const pLCurrent = prev[topic] !== undefined ? prev[topic] : DEFAULT_BKT_PARAMS[topic].pL0;
      const pLNext = updateMastery(pLCurrent, correct, topic);
      const updated = { ...prev, [topic]: pLNext };
      localStorage.setItem("linlearn_mastery", JSON.stringify(updated));

      if (xtermInstance.current) {
        const diff = pLNext - pLCurrent;
        const indicator = diff >= 0 ? `\x1b[1;32m+${(diff*100).toFixed(1)}%\x1b[0m` : `\x1b[1;31m${(diff*100).toFixed(1)}%\x1b[0m`;
        xtermInstance.current.write(`\r\n\x1b[1;90m[Telemetry] BKT Mastery for ${topic} updated to ${(pLNext*100).toFixed(1)}% (${indicator})\x1b[0m\r\n`);
      }
      return updated;
    });
  };

  const handleSaveV86State = () => {
    const emulator = v86EmulatorRef.current;
    if (!emulator) return;
    
    setIsSavingV86(true);
    emulator.save_state((error: unknown, state: ArrayBuffer) => {
      if (error) {
        console.error("Failed to save VM state:", error);
        alert("Failed to save VM state.");
        setIsSavingV86(false);
      } else {
        saveV86State(state).then(() => {
          setIsSavingV86(false);
          if (xtermInstance.current) {
            xtermInstance.current.write("\r\n\x1b[1;32m[System] Virtual machine state successfully persisted to browser IndexedDB.\x1b[0m\r\n");
          }
        }).catch(err => {
          console.error("Failed to save state to IndexedDB:", err);
          setIsSavingV86(false);
        });
      }
    });
  };

  const handleResetV86State = () => {
    const confirmed = window.confirm("Are you sure you want to reset the WebAssembly VM state? All unpersisted work inside the guest kernel will be lost.");
    if (confirmed) {
      clearV86State().then(() => {
        setIsV86Mode(false);
        setTimeout(() => {
          setIsV86Mode(true);
        }, 100);
      });
    }
  };

  const runV86Validation = (command: string): Promise<boolean> => {
    return new Promise((resolve) => {
      const emulator = v86EmulatorRef.current;
      if (!emulator) {
        resolve(false);
        return;
      }

      isCapturingValidationRef.current = true;
      let capturedBuffer = "";
      const sentinelStart = "VAL_START_SENTINEL";
      const sentinelEnd = "VAL_END_SENTINEL";

      const tempListener = (char: string) => {
        capturedBuffer += char;
        if (capturedBuffer.includes(sentinelEnd)) {
          emulator.remove_listener("serial0-output-char", tempListener);
          isCapturingValidationRef.current = false;
          const success = capturedBuffer.includes("VAL_SUCCESS");
          resolve(success);
        }
      };

      emulator.add_listener("serial0-output-char", tempListener);
      
      emulator.serial0_send(`\nclear\necho "${sentinelStart}" && if ${command}; then echo "VAL_SUCCESS"; else echo "VAL_FAILURE"; fi && echo "${sentinelEnd}"\n`);

      setTimeout(() => {
        emulator.remove_listener("serial0-output-char", tempListener);
        isCapturingValidationRef.current = false;
        resolve(false);
      }, 4000);
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

  // Auto-save WASM VM state periodically
  useEffect(() => {
    if (!isV86Mode || !v86EmulatorRef.current || v86Booting) return;
    
    const interval = setInterval(() => {
      const emulator = v86EmulatorRef.current;
      if (emulator && !isCapturingValidationRef.current) {
        emulator.save_state((error: unknown, state: ArrayBuffer) => {
          if (!error && state) {
            saveV86State(state).catch(err => console.error("Auto-save failed:", err));
          }
        });
      }
    }, 45000); // auto-save every 45 seconds

    return () => clearInterval(interval);
  }, [isV86Mode, v86Booting]);

  // Handle clearSignal from parent
  useEffect(() => {
    if (clearSignal === 0) return;
    if (xtermInstance.current) {
      xtermInstance.current.clear();
      xtermInstance.current.write(getPromptString(stateRef.current));
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
      if (xtermInstance.current) {
        xtermInstance.current.clear();
        xtermInstance.current.write("\r\n\x1b[1;33mSystem restored. Virtual filesystem, Docker, and services refreshed.\x1b[0m\r\n\r\n");
        xtermInstance.current.write(getPromptString(fresh));
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
      const getWasmMission = (id: string, title: string, desc: string, hint: string) => ({
        id,
        title,
        desc,
        hint,
        completed: !!completedVasmMissions[id]
      });

      if (learningMode === "Beginner") {
        return [
          getWasmMission("pwd_ls", "Explore Directories", "Execute 'pwd' and 'ls' to identify active path mappings.", "pwd && ls"),
          getWasmMission("mkdir_proj", "Create Work Directory", "Create a new sub-folder directory at /home/user/Projects.", "mkdir -p /home/user/Projects"),
          getWasmMission("touch_config", "Create Configuration File", "Initialize an empty file at /home/user/Projects/config.txt.", "touch /home/user/Projects/config.txt")
        ];
      }
      if (learningMode === "DevOps") {
        return [
          getWasmMission("nginx", "Deploy Nginx Container", "Start a Docker container running Nginx on port 80.", "docker run -d -p 80:80 nginx"),
          getWasmMission("logs", "Investigate Access Logs", "Inspect the Nginx access log file to see recent client hits.", "cat /var/log/nginx/access.log"),
          getWasmMission("htop", "Install htop Tool", "Install the system resource monitor package 'htop' using the package manager.", "apt install htop")
        ];
      }
      if (learningMode === "Security") {
        return [
          getWasmMission("permissions", "Create Executable Script", "Create a file at /home/user/Projects/deploy.sh and make it executable.", "touch /home/user/Projects/deploy.sh && chmod +x /home/user/Projects/deploy.sh"),
          getWasmMission("lock_config", "Lock Config Permissions", "Remove write access permissions from /home/user/Projects/config.txt.", "chmod 400 /home/user/Projects/config.txt"),
          getWasmMission("audit_dangerous", "Audit Sandbox Safeguards", "Test security safeguards by executing a dangerous command (e.g. rm -rf /).", "rm -rf /")
        ];
      }
      return [
        getWasmMission("sysinfo", "Query System Info", "Query virtual hostname and current user login context.", "whoami && uname -a"),
        getWasmMission("services", "Review systemd Status", "Inspect active service configurations on the system.", "systemctl status nginx.service"),
        getWasmMission("processes", "Inspect Process Tree", "Query standard process listing tables.", "ps aux")
      ];
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
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      if (terminalRef.current) {
        term.open(terminalRef.current);
        fitAddon.fit();
      }

      xtermInstance.current = term;

      if (isV86Mode) {
        // --- WASM v86 VM Mode ---
        term.write("\x1b[1;36mInitializing v86 WebAssembly x86 Virtual Machine...\x1b[0m\r\n");
        term.write(" * Fetching minimal Buildroot Linux disk image (~10MB)...\r\n");
        term.write(" * Booting real Linux kernel in the browser sandbox...\r\n\r\n");
        
        setV86Booting(true);

        // Load the libv86 script from CDN if not already loaded
        const loadV86Script = () => {
          return new Promise<void>((resolve, reject) => {
            if ((window as unknown as WindowWithV86).V86Starter) {
              resolve();
              return;
            }
            const script = document.createElement("script");
            script.src = "/v86/libv86.js";
            script.async = true;
            script.onload = () => resolve();
            script.onerror = (err) => reject(err);
            document.head.appendChild(script);
          });
        };

        try {
          await loadV86Script();
          if (!isMounted) return;

          // Attempt to load saved VM state from IndexedDB
          let savedState: ArrayBuffer | null = null;
          try {
            savedState = await loadV86State();
            if (savedState && xtermInstance.current) {
              xtermInstance.current.write(" * Found saved session state. Restoring VM snapshot...\r\n");
            }
          } catch (e) {
            console.error("Failed to load saved state:", e);
          }

          const v86Config: {
            wasm_path: string;
            bios: { url: string };
            vga_bios: { url: string };
            bzimage: { url: string; async?: boolean };
            cmdline: string;
            autostart: boolean;
            initial_state?: { buffer: ArrayBuffer };
          } = {
            wasm_path: "/v86/v86.wasm",
            bios: {
              url: "/v86/bios/seabios.bin",
            },
            vga_bios: {
              url: "/v86/bios/vgabios.bin",
            },
            bzimage: {
              url: "/v86/images/bzImage",
              async: false,
            },
            cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
            autostart: true,
          };

          if (savedState) {
            v86Config.initial_state = { buffer: savedState };
          }

          // Instantiate V86Starter
          const emulator = new (window as unknown as WindowWithV86).V86Starter(v86Config);

          v86EmulatorRef.current = emulator;

          let isFirstChar = true;

          // Connect guest serial output to xterm.js terminal
          emulator.add_listener("serial0-output-char", (char: string) => {
            if (isCapturingValidationRef.current) {
              return;
            }
            if (isFirstChar) {
              isFirstChar = false;
              setV86Booting(false);
              term.clear();
            }
            term.write(char);
          });

          // Connect user input from xterm.js back to guest serial console
          const dataDisposable = term.onData((data) => {
            emulator.serial0_send(data);
          });

          // Save references to cleanly dispose
          const customTerm = term as unknown as CustomTerminal;
          customTerm._v86Disposable = dataDisposable;

        } catch (err) {
          console.error("Failed to load v86 VM:", err);
          term.write("\r\n\x1b[1;31mError: Failed to fetch WebAssembly virtual machine libraries.\x1b[0m\r\n");
          term.write("Verify your internet connection and CORS configurations.\r\n");
          setV86Booting(false);
        }

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
        term.dispose();
      }
      if (v86EmulatorRef.current) {
        try {
          v86EmulatorRef.current.destroy();
        } catch (e) {
          console.error("Failed to destroy v86 emulator:", e);
        }
        v86EmulatorRef.current = null;
      }
    };
  }, [prefs.theme, prefs.fontSize, isV86Mode]);

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
                onClick={handleSaveV86State}
                disabled={isSavingV86}
                className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition-all hover:bg-emerald-500/20 hover:text-white disabled:opacity-50"
              >
                <Award className="h-3.5 w-3.5" />
                {isSavingV86 ? "Saving State..." : "Save VM State"}
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
        <div className="lg:col-span-7 flex flex-col rounded-xl border border-white/10 bg-[#06070a] overflow-hidden shadow-2xl">
          {/* Simulated Ubuntu window header */}
          <div className="flex items-center justify-between bg-[#15161c] px-4 py-2 border-b border-white/5">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full bg-rose-500/80" />
              <div className="h-3 w-3 rounded-full bg-amber-500/80" />
              <div className="h-3 w-3 rounded-full bg-emerald-500/80" />
              <span className="ml-2 text-xs font-semibold text-gray-400 font-mono select-none">
                {isV86Mode ? "root@linlearn (WASM VM)" : `user@linlearn: ${osState.cwd} (virtual OS)`}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs font-mono text-gray-500">
              <span>bash</span>
            </div>
          </div>
          
          {/* Terminal Canvas Container */}
          <div className="p-2 min-h-[500px] flex-1 flex flex-col justify-stretch relative">
            {isV86Mode && v86Booting && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#06070a]/90 gap-3">
                <RefreshCw className="h-8 w-8 text-[#E95420] animate-spin" />
                <span className="text-sm font-mono text-gray-400">Booting Real Linux Kernel in WASM...</span>
                <span className="text-xs font-mono text-gray-600">Downloading Buildroot disk image (~10MB)</span>
              </div>
            )}
            <div 
              ref={terminalRef} 
              className="w-full flex-1 overflow-hidden" 
              style={{ minHeight: "480px" }}
            />
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
                                    const success = await runV86Validation(WASM_MISSION_CHECKS[mission.id]);
                                    if (success) {
                                      try {
                                        const res = await fetch("/api/validate", {
                                          method: "POST",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ missionId: mission.id, success: true })
                                        });
                                        if (res.ok) {
                                          setCompletedVasmMissions(prev => ({ ...prev, [mission.id]: true }));
                                          updateBKT(MISSION_TOPICS[mission.id] || "navigation", true);
                                          onCommandLoggedRef.current({
                                            id: Math.random().toString(36).substring(2, 10),
                                            input: `Verify: ${mission.title}`,
                                            output: `Mission "${mission.title}" verified successfully inside the WASM guest VM and recorded on the server!`,
                                            source: "local",
                                            createdAt: new Date().toISOString()
                                          });
                                        } else {
                                          alert("Failed to submit verification to server. Make sure you are signed in.");
                                        }
                                      } catch (err) {
                                        console.error("Failed to submit validation:", err);
                                        alert("Server communication error. Please try again.");
                                      }
                                    } else {
                                      updateBKT(MISSION_TOPICS[mission.id] || "navigation", false);
                                      alert(`Verification failed for "${mission.title}". Make sure you completed the objective correctly inside the guest VM.`);
                                    }
                                    setValidatingMissions(prev => ({ ...prev, [mission.id]: false }));
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
