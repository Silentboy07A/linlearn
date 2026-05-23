export interface VirtualFile {
  type: "file";
  content: string;
  permissions: string; // e.g., "-rw-r--r--"
  owner: string;       // e.g., "user"
  group: string;       // e.g., "user"
  modifiedAt: string;
}

export interface VirtualDir {
  type: "dir";
  children: Record<string, VirtualFsNode>;
  permissions: string; // e.g., "drwxr-xr-x"
  owner: string;
  group: string;
  modifiedAt: string;
}

export type VirtualFsNode = VirtualFile | VirtualDir;

export interface VirtualContainer {
  id: string;
  image: string;
  status: string;
  ports: string;
  name: string;
  created: string;
}

export interface VirtualProcess {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
  startTime: string;
}

export interface VirtualService {
  name: string;
  description: string;
  active: "active (running)" | "inactive (dead)";
  loaded: string;
}

export interface VirtualSystemState {
  fs: VirtualDir;
  cwd: string;
  currentUser: string;
  env: Record<string, string>;
  processes: VirtualProcess[];
  containers: VirtualContainer[];
  services: Record<string, VirtualService>;
  packages: Set<string>;
  history: string[];
}

// Helper to convert octal representation (like 755) to a permissions string
export function octalToPermissions(octal: string, isDir: boolean): string {
  const digits = octal.split("").map(Number);
  const prefix = isDir ? "d" : "-";
  if (digits.length !== 3 || digits.some(isNaN)) {
    return isDir ? "drwxr-xr-x" : "-rw-r--r--";
  }

  const map = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  return prefix + digits.map((d) => map[d] || "---").join("");
}

// Initial System Setup
export function getInitialState(): VirtualSystemState {
  const now = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });

  const root: VirtualDir = {
    type: "dir",
    permissions: "drwxr-xr-x",
    owner: "root",
    group: "root",
    modifiedAt: now,
    children: {
      bin: {
        type: "dir",
        permissions: "drwxr-xr-x",
        owner: "root",
        group: "root",
        modifiedAt: now,
        children: {},
      },
      sbin: {
        type: "dir",
        permissions: "drwxr-xr-x",
        owner: "root",
        group: "root",
        modifiedAt: now,
        children: {},
      },
      etc: {
        type: "dir",
        permissions: "drwxr-xr-x",
        owner: "root",
        group: "root",
        modifiedAt: now,
        children: {
          hosts: {
            type: "file",
            content: "127.0.0.1 localhost\n192.168.1.37 linlearn\n",
            permissions: "-rw-r--r--",
            owner: "root",
            group: "root",
            modifiedAt: now,
          },
          "resolv.conf": {
            type: "file",
            content: "nameserver 8.8.8.8\nnameserver 1.1.1.1\n",
            permissions: "-rw-r--r--",
            owner: "root",
            group: "root",
            modifiedAt: now,
          },
          nginx: {
            type: "dir",
            permissions: "drwxr-xr-x",
            owner: "root",
            group: "root",
            modifiedAt: now,
            children: {
              "nginx.conf": {
                type: "file",
                content: "user www-data;\nworker_processes auto;\npid /run/nginx.pid;\n\nevents {\n  worker_connections 768;\n}\n\nhttp {\n  sendfile on;\n  tcp_nopush on;\n  types_hash_max_size 2048;\n  include /etc/nginx/mime.types;\n  default_type application/octet-stream;\n\n  server {\n    listen 80 default_server;\n    listen [::]:80 default_server;\n    root /var/www/html;\n    index index.html;\n    server_name _;\n  }\n}",
                permissions: "-rw-r--r--",
                owner: "root",
                group: "root",
                modifiedAt: now,
              },
            },
          },
        },
      },
      var: {
        type: "dir",
        permissions: "drwxr-xr-x",
        owner: "root",
        group: "root",
        modifiedAt: now,
        children: {
          log: {
            type: "dir",
            permissions: "drwxr-xr-x",
            owner: "root",
            group: "root",
            modifiedAt: now,
            children: {
              nginx: {
                type: "dir",
                permissions: "drwxr-xr-x",
                owner: "www-data",
                group: "adm",
                modifiedAt: now,
                children: {
                  "access.log": {
                    type: "file",
                    content: "192.168.1.100 - - [23/May/2026:10:40:02 +0530] \"GET / HTTP/1.1\" 200 3126 \"-\" \"Mozilla/5.0\"\n",
                    permissions: "-rw-r-----",
                    owner: "www-data",
                    group: "adm",
                    modifiedAt: now,
                  },
                  "error.log": {
                    type: "file",
                    content: "",
                    permissions: "-rw-r-----",
                    owner: "www-data",
                    group: "adm",
                    modifiedAt: now,
                  },
                },
              },
            },
          },
          www: {
            type: "dir",
            permissions: "drwxr-xr-x",
            owner: "root",
            group: "root",
            modifiedAt: now,
            children: {
              html: {
                type: "dir",
                permissions: "drwxr-xr-x",
                owner: "www-data",
                group: "www-data",
                modifiedAt: now,
                children: {
                  "index.html": {
                    type: "file",
                    content: "<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to Nginx on LinLearn</title>\n</head>\n<body>\n<h1>Nginx is running successfully!</h1>\n</body>\n</html>",
                    permissions: "-rw-r--r--",
                    owner: "www-data",
                    group: "www-data",
                    modifiedAt: now,
                  },
                },
              },
            },
          },
        },
      },
      home: {
        type: "dir",
        permissions: "drwxr-xr-x",
        owner: "root",
        group: "root",
        modifiedAt: now,
        children: {
          user: {
            type: "dir",
            permissions: "drwxr-xr-x",
            owner: "user",
            group: "user",
            modifiedAt: now,
            children: {
              Documents: {
                type: "dir",
                permissions: "drwxr-xr-x",
                owner: "user",
                group: "user",
                modifiedAt: now,
                children: {},
              },
              Projects: {
                type: "dir",
                permissions: "drwxr-xr-x",
                owner: "user",
                group: "user",
                modifiedAt: now,
                children: {},
              },
              "notes.txt": {
                type: "file",
                content: "Welcome to the LinLearn Virtual Terminal Sandbox!\n\nHere are some challenges to try:\n1. run `docker run -d -p 80:80 nginx` to start a web server\n2. check active services with `systemctl status` or `service --status-all`\n3. inspect resource usage with `top` or `ps aux`\n4. install packages like `htop` using `apt install htop`\n\nKeep learning!\n",
                permissions: "-rw-r--r--",
                owner: "user",
                group: "user",
                modifiedAt: now,
              },
            },
          },
        },
      },
    },
  };

  return {
    fs: root,
    cwd: "/home/user",
    currentUser: "user",
    env: {
      USER: "user",
      HOME: "/home/user",
      SHELL: "/bin/bash",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
    },
    processes: [
      { pid: 1, user: "root", cpu: 0.0, mem: 0.1, command: "/sbin/init splash", startTime: "May23" },
      { pid: 2, user: "root", cpu: 0.0, mem: 0.0, command: "[kthreadd]", startTime: "May23" },
      { pid: 42, user: "user", cpu: 0.1, mem: 0.3, command: "-bash", startTime: "10:40" },
      { pid: 91, user: "root", cpu: 0.0, mem: 0.2, command: "nginx: master process /usr/sbin/nginx -g daemon off;", startTime: "10:40" },
      { pid: 92, user: "www-data", cpu: 0.0, mem: 0.2, command: "nginx: worker process", startTime: "10:40" },
      { pid: 120, user: "root", cpu: 0.0, mem: 0.8, command: "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock", startTime: "10:40" },
      { pid: 125, user: "root", cpu: 0.0, mem: 0.5, command: "/usr/bin/containerd", startTime: "10:40" },
    ],
    containers: [
      { id: "7ab21fd921ec", image: "nginx:latest", status: "Up 2 hours", ports: "0.0.0.0:80->80/tcp, :::80->80/tcp", name: "web-server", created: "2 hours ago" },
      { id: "12da91bc1f2c", image: "redis:7", status: "Up 5 hours", ports: "0.0.0.0:6379->6379/tcp, :::6379->6379/tcp", name: "cache-db", created: "5 hours ago" },
    ],
    services: {
      nginx: { name: "nginx.service", description: "High performance web server", active: "active (running)", loaded: "loaded" },
      docker: { name: "docker.service", description: "Docker Application Container Engine", active: "active (running)", loaded: "loaded" },
      ssh: { name: "ssh.service", description: "OpenBSD Secure Shell server", active: "active (running)", loaded: "loaded" },
      postgresql: { name: "postgresql.service", description: "PostgreSQL RDBMS", active: "inactive (dead)", loaded: "loaded" },
      cron: { name: "cron.service", description: "Regular background program processing daemon", active: "active (running)", loaded: "loaded" },
    },
    packages: new Set(["nginx", "docker-ce", "python3", "git", "curl", "wget", "net-tools", "bash", "coreutils"]),
    history: [],
  };
}

// Normalizes pathways
export function normalizePath(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized;
}

export function resolvePath(cwd: string, rawPath: string): string {
  if (!rawPath) return cwd;
  if (rawPath === "~") return "/home/user";
  if (rawPath.startsWith("~")) {
    return `/home/user/${rawPath.slice(1)}`.replace(/\/+$/, "") || "/";
  }
  if (rawPath.startsWith("/")) {
    const parts = normalizePath(rawPath);
    return `/${parts.join("/")}`.replace(/\/+$/, "") || "/";
  }
  const current = cwd === "/" ? "" : cwd;
  const parts = normalizePath(`${current}/${rawPath}`);
  return `/${parts.join("/")}`.replace(/\/+$/, "") || "/";
}

// Find node at a specific path
export function getNode(root: VirtualDir, path: string): VirtualFsNode | null {
  const parts = normalizePath(path);
  let pointer: VirtualFsNode = root;
  for (const part of parts) {
    if (pointer.type !== "dir") return null;
    const nextNode: VirtualFsNode | undefined = (pointer as VirtualDir).children[part];
    if (!nextNode) return null;
    pointer = nextNode;
  }
  return pointer;
}

// Write/set a node at a specific path
export function setNode(root: VirtualDir, path: string, node: VirtualFsNode): VirtualDir {
  const draft = JSON.parse(JSON.stringify(root)) as VirtualDir;
  const parts = normalizePath(path);
  if (parts.length === 0) return draft;

  let pointer: VirtualFsNode = draft;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i];
    if (pointer.type !== "dir") return draft;
    const dir = pointer as VirtualDir;
    if (!dir.children[segment]) {
      const now = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
      dir.children[segment] = {
        type: "dir",
        permissions: "drwxr-xr-x",
        owner: "user",
        group: "user",
        modifiedAt: now,
        children: {},
      };
    }
    pointer = dir.children[segment];
  }

  if (pointer.type === "dir") {
    (pointer as VirtualDir).children[parts[parts.length - 1]] = node;
  }
  return draft;
}

// Remove a node at a path
export function deleteNode(root: VirtualDir, path: string): VirtualDir {
  const draft = JSON.parse(JSON.stringify(root)) as VirtualDir;
  const parts = normalizePath(path);
  if (parts.length === 0) return draft;

  let pointer: VirtualFsNode = draft;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i];
    if (pointer.type !== "dir") return draft;
    const dir = pointer as VirtualDir;
    const nextNode: VirtualFsNode | undefined = dir.children[segment];
    if (!nextNode) return draft;
    pointer = nextNode;
  }

  if (pointer.type === "dir") {
    delete (pointer as VirtualDir).children[parts[parts.length - 1]];
  }
  return draft;
}

// Parse Command Execution
export interface ExecResult {
  output: string;
  newState: VirtualSystemState;
  shouldClear?: boolean;
}

// Custom parser to split by pipes and redirects
export interface CommandToken {
  cmd: string;
  args: string[];
}

export interface ParsedPipeline {
  tokens: CommandToken[];
  redirectFile?: string;
  redirectAppend?: boolean;
  error?: string;
}

export function parseCommandLine(line: string): ParsedPipeline {
  const trimmed = line.trim();
  if (!trimmed) return { tokens: [] };

  // Parse output redirects first
  let remaining = trimmed;
  let redirectFile: string | undefined;
  let redirectAppend = false;

  const appendIndex = remaining.lastIndexOf(">>");
  const writeIndex = remaining.lastIndexOf(">");

  if (appendIndex !== -1 && appendIndex > writeIndex) {
    redirectFile = remaining.slice(appendIndex + 2).trim();
    redirectAppend = true;
    remaining = remaining.slice(0, appendIndex);
  } else if (writeIndex !== -1) {
    redirectFile = remaining.slice(writeIndex + 1).trim();
    redirectAppend = false;
    remaining = remaining.slice(0, writeIndex);
  }

  // Parse pipes
  const pipes = remaining.split("|");
  const tokens: CommandToken[] = [];

  for (const part of pipes) {
    const cleanPart = part.trim();
    if (!cleanPart) {
      return { tokens: [], error: "bash: syntax error near unexpected token `|'" };
    }

    // Tokenize command line with spaces while preserving quoted substrings
    const matches = cleanPart.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (matches.length === 0) continue;

    const cmd = matches[0] || "";
    const args = matches.slice(1).map((arg) => {
      if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
        return arg.slice(1, -1);
      }
      return arg;
    });

    tokens.push({ cmd, args });
  }

  return { tokens, redirectFile, redirectAppend };
}

// Executes a single command on a state
export function executeCommand(line: string, state: VirtualSystemState): ExecResult {
  const parsed = parseCommandLine(line);
  if (parsed.error) {
    return { output: parsed.error, newState: state };
  }

  if (parsed.tokens.length === 0) {
    return { output: "", newState: state };
  }

  let currentState = { ...state };
  let currentInput = ""; // Standard input for commands in the pipe

  // Process pipeline tokens
  for (let i = 0; i < parsed.tokens.length; i += 1) {
    const token = parsed.tokens[i];
    const res = runBaseCommand(token.cmd, token.args, currentState, currentInput);
    currentState = res.newState;
    currentInput = res.output;

    if (res.shouldClear) {
      return { output: "", newState: currentState, shouldClear: true };
    }
  }

  // Handle stdout redirection if specified
  if (parsed.redirectFile) {
    const filePath = resolvePath(currentState.cwd, parsed.redirectFile);
    const now = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });

    const parentPath = filePath.substring(0, filePath.lastIndexOf("/")) || "/";
    const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
    const parentNode = getNode(currentState.fs, parentPath);

    if (!parentNode || parentNode.type !== "dir") {
      return { output: `bash: ${parsed.redirectFile}: No such file or directory`, newState: state };
    }

    const existingFile = parentNode.children[fileName];
    let newContent = currentInput;

    if (existingFile && existingFile.type === "file") {
      if (parsed.redirectAppend) {
        newContent = existingFile.content + (existingFile.content.endsWith("\n") || !existingFile.content ? "" : "\n") + currentInput;
      }
      const updatedFile: VirtualFile = {
        ...existingFile,
        content: newContent,
        modifiedAt: now,
      };
      currentState.fs = setNode(currentState.fs, filePath, updatedFile);
    } else {
      const newFile: VirtualFile = {
        type: "file",
        content: newContent,
        permissions: "-rw-r--r--",
        owner: currentState.currentUser,
        group: currentState.currentUser,
        modifiedAt: now,
      };
      currentState.fs = setNode(currentState.fs, filePath, newFile);
    }

    // Redirecting stdout discards visible output of the command line
    return { output: "", newState: currentState };
  }

  return { output: currentInput, newState: currentState };
}

// Executes a core base command
function runBaseCommand(cmd: string, args: string[], state: VirtualSystemState, stdin: string): ExecResult {
  const trimmedCmd = cmd.trim();

  // 1. Destructive operations security validation block
  if (trimmedCmd === "rm" && (args.includes("-rf") || args.includes("-f") || args.includes("/")) && (args.includes("/") || args.includes("*"))) {
    return {
      output: "LinLearn Sandbox:\nDestructive filesystem operations are disabled.",
      newState: state,
    };
  }

  if (["dd", "mkfs", "fdisk", "shutdown", "reboot", "poweroff", "halt"].includes(trimmedCmd)) {
    return {
      output: "LinLearn Sandbox:\nDestructive operating system commands are disabled.",
      newState: state,
    };
  }

  // 2. Command handlers
  switch (trimmedCmd) {
    case "clear": {
      return { output: "", newState: state, shouldClear: true };
    }

    case "pwd": {
      return { output: state.cwd, newState: state };
    }

    case "whoami": {
      return { output: state.currentUser, newState: state };
    }

    case "uname": {
      if (args.includes("-a")) {
        return { output: "Linux linlearn 5.15.0-76-generic #83-Ubuntu SMP x86_64 x86_64 x86_64 GNU/Linux", newState: state };
      }
      return { output: "Linux", newState: state };
    }

    case "history": {
      const output = state.history.map((val, idx) => `  ${idx + 1}  ${val}`).join("\n");
      return { output, newState: state };
    }

    case "echo": {
      return { output: args.join(" "), newState: state };
    }

    case "cd": {
      const target = args[0] || "~";
      const resolved = resolvePath(state.cwd, target);
      const node = getNode(state.fs, resolved);
      if (!node) {
        return { output: `bash: cd: ${target}: No such file or directory`, newState: state };
      }
      if (node.type !== "dir") {
        return { output: `bash: cd: ${target}: Not a directory`, newState: state };
      }
      return { output: "", newState: { ...state, cwd: resolved } };
    }

    case "ls": {
      const showAll = args.includes("-a") || args.includes("-la") || args.includes("-al");
      const showLong = args.includes("-l") || args.includes("-la") || args.includes("-al");
      const targetArg = args.find((a) => !a.startsWith("-"));
      const target = targetArg ? resolvePath(state.cwd, targetArg) : state.cwd;
      const node = getNode(state.fs, target);

      if (!node) {
        return { output: `ls: cannot access '${targetArg}': No such file or directory`, newState: state };
      }

      if (node.type === "file") {
        if (showLong) {
          return { output: `${node.permissions} 1 ${node.owner} ${node.group} ${node.content.length} ${node.modifiedAt} ${targetArg || node.owner}`, newState: state };
        }
        return { output: targetArg || "file", newState: state };
      }

      // Read directories
      const keys = Object.keys(node.children).sort();
      const allKeys = showAll ? [".", "..", ...keys] : keys;

      if (showLong) {
        const lines = allKeys.map((k) => {
          let current: VirtualFsNode;
          if (k === ".") current = node;
          else if (k === "..") {
            const parentPath = target.substring(0, target.lastIndexOf("/")) || "/";
            current = getNode(state.fs, parentPath) || node;
          } else {
            current = node.children[k];
          }

          const size = current.type === "file" ? current.content.length : 4096;
          const linkCount = current.type === "dir" ? 2 : 1;
          return `${current.permissions} ${linkCount} ${current.owner} ${current.group} ${size} ${current.modifiedAt} ${k}`;
        });
        return { output: lines.join("\n"), newState: state };
      }

      return { output: allKeys.join("  "), newState: state };
    }

    case "mkdir": {
      const pathArg = args[0];
      if (!pathArg) {
        return { output: "mkdir: missing operand", newState: state };
      }
      const target = resolvePath(state.cwd, pathArg);
      if (getNode(state.fs, target)) {
        return { output: `mkdir: cannot create directory '${pathArg}': File exists`, newState: state };
      }
      const now = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
      const newDir: VirtualDir = {
        type: "dir",
        permissions: "drwxr-xr-x",
        owner: state.currentUser,
        group: state.currentUser,
        modifiedAt: now,
        children: {},
      };
      const nextFs = setNode(state.fs, target, newDir);
      return { output: "", newState: { ...state, fs: nextFs } };
    }

    case "touch": {
      const pathArg = args[0];
      if (!pathArg) {
        return { output: "touch: missing file operand", newState: state };
      }
      const target = resolvePath(state.cwd, pathArg);
      const existing = getNode(state.fs, target);
      const now = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });

      if (existing && existing.type === "file") {
        const nextFs = setNode(state.fs, target, { ...existing, modifiedAt: now });
        return { output: "", newState: { ...state, fs: nextFs } };
      }

      const newFile: VirtualFile = {
        type: "file",
        content: "",
        permissions: "-rw-r--r--",
        owner: state.currentUser,
        group: state.currentUser,
        modifiedAt: now,
      };
      const nextFs = setNode(state.fs, target, newFile);
      return { output: "", newState: { ...state, fs: nextFs } };
    }

    case "rm": {
      const recursive = args.includes("-r") || args.includes("-rf") || args.includes("-R");
      const fileArg = args.find((a) => !a.startsWith("-"));
      if (!fileArg) {
        return { output: "rm: missing operand", newState: state };
      }
      const target = resolvePath(state.cwd, fileArg);
      const node = getNode(state.fs, target);

      if (!node) {
        return { output: `rm: cannot remove '${fileArg}': No such file or directory`, newState: state };
      }

      if (node.type === "dir" && !recursive) {
        return { output: `rm: cannot remove '${fileArg}': Is a directory`, newState: state };
      }

      const nextFs = deleteNode(state.fs, target);
      return { output: "", newState: { ...state, fs: nextFs } };
    }

    case "cat": {
      const fileArg = args[0];
      if (!fileArg) {
        // If stdin is passed in pipeline, print stdin
        if (stdin) {
          return { output: stdin, newState: state };
        }
        return { output: "cat: missing file operand", newState: state };
      }
      const target = resolvePath(state.cwd, fileArg);
      const node = getNode(state.fs, target);

      if (!node) {
        return { output: `cat: ${fileArg}: No such file or directory`, newState: state };
      }
      if (node.type === "dir") {
        return { output: `cat: ${fileArg}: Is a directory`, newState: state };
      }
      return { output: node.content, newState: state };
    }

    case "chmod": {
      const mode = args[0];
      const targetArg = args[1];
      if (!mode || !targetArg) {
        return { output: "chmod: missing operand", newState: state };
      }
      const target = resolvePath(state.cwd, targetArg);
      const node = getNode(state.fs, target);
      if (!node) {
        return { output: `chmod: cannot access '${targetArg}': No such file or directory`, newState: state };
      }

      let newPerms = node.permissions;
      if (/^[0-7]{3}$/.test(mode)) {
        newPerms = octalToPermissions(mode, node.type === "dir");
      } else if (mode.includes("+") || mode.includes("-")) {
        // Quick relative chmod parser
        const chars = newPerms.split("");
        const op = mode.includes("+") ? "+" : "-";
        const role = mode.split(op)[0] || "a"; // default to all
        const right = mode.split(op)[1];

        const setRight = (index: number, val: string) => {
          if (op === "+") chars[index] = val;
          else chars[index] = "-";
        };

        if (right.includes("r")) {
          if (role.includes("u") || role.includes("a")) setRight(1, "r");
          if (role.includes("g") || role.includes("a")) setRight(4, "r");
          if (role.includes("o") || role.includes("a")) setRight(7, "r");
        }
        if (right.includes("w")) {
          if (role.includes("u") || role.includes("a")) setRight(2, "w");
          if (role.includes("g") || role.includes("a")) setRight(5, "w");
          if (role.includes("o") || role.includes("a")) setRight(8, "w");
        }
        if (right.includes("x")) {
          if (role.includes("u") || role.includes("a")) setRight(3, "x");
          if (role.includes("g") || role.includes("a")) setRight(6, "x");
          if (role.includes("o") || role.includes("a")) setRight(9, "x");
        }
        newPerms = chars.join("");
      }

      const nextFs = setNode(state.fs, target, { ...node, permissions: newPerms });
      return { output: "", newState: { ...state, fs: nextFs } };
    }

    case "chown": {
      const ownership = args[0];
      const targetArg = args[1];
      if (!ownership || !targetArg) {
        return { output: "chown: missing operand", newState: state };
      }
      const target = resolvePath(state.cwd, targetArg);
      const node = getNode(state.fs, target);
      if (!node) {
        return { output: `chown: cannot access '${targetArg}': No such file or directory`, newState: state };
      }

      const [owner, group] = ownership.split(":");
      const nextFs = setNode(state.fs, target, {
        ...node,
        owner: owner || node.owner,
        group: group || node.group || owner || node.owner,
      });
      return { output: "", newState: { ...state, fs: nextFs } };
    }

    case "whoami": {
      return { output: state.currentUser, newState: state };
    }

    // Process Manager Subsystem
    case "ps": {
      const showAll = args.includes("aux") || args.includes("-aux") || args.includes("-A") || args.includes("-e");
      if (showAll) {
        const rows = state.processes.map(
          (p) => `${p.user.padEnd(8)} ${p.pid.toString().padStart(5)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} 102400 12040 pts/0    Ss   ${p.startTime}   0:00 ${p.command}`
        );
        return {
          output: `USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n` + rows.join("\n"),
          newState: state,
        };
      }
      const defaultRows = state.processes
        .filter((p) => p.user === state.currentUser)
        .map((p) => ` ${p.pid.toString().padStart(5)} pts/0    00:00:00 ${p.command}`);
      return {
        output: `  PID TTY          TIME CMD\n` + defaultRows.join("\n"),
        newState: state,
      };
    }

    case "top": {
      const topHeader = `top - 10:45:00 up 3 days,  2:11,  1 user,  load average: 0.05, 0.08, 0.12\nTasks: ${state.processes.length} total,   1 running, ${state.processes.length - 1} sleeping,   0 stopped,   0 zombie\n%Cpu(s):  1.5 us,  0.8 sy,  0.0 ni, 97.4 id,  0.3 wa,  0.0 hi,  0.0 si,  0.0 st\nMiB Mem :   3936.4 total,   1521.2 free,   1102.8 used,   1312.4 buff/cache\nMiB Swap:   2048.0 total,   2048.0 free,      0.0 used.   2560.1 avail Mem \n\n  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n`;
      const rows = [...state.processes]
        .sort((a, b) => b.cpu - a.cpu)
        .map((p) => ` ${p.pid.toString().padStart(4)} ${p.user.padEnd(8)}  20   0  102400  12040   9212 S   ${p.cpu.toFixed(1)}   ${p.mem.toFixed(1)}   0:00.08 ${p.command.split(" ")[0]}`);
      return { output: topHeader + rows.join("\n"), newState: state };
    }

    case "kill": {
      const pidStr = args.find((a) => !a.startsWith("-"));
      if (!pidStr) {
        return { output: "kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l", newState: state };
      }
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) {
        return { output: `kill: ${pidStr}: arguments must be process IDs`, newState: state };
      }

      if (pid === 1 || (pid === 42 && state.currentUser === "user")) {
        return { output: `bash: kill: (${pid}) - Operation not permitted (protected system process)`, newState: state };
      }

      const proc = state.processes.find((p) => p.pid === pid);
      if (!proc) {
        return { output: `bash: kill: (${pid}) - No such process`, newState: state };
      }

      const nextProcs = state.processes.filter((p) => p.pid !== pid);
      return { output: `Process ${pid} [${proc.command}] killed.`, newState: { ...state, processes: nextProcs } };
    }

    // Docker Engine Subsystem
    case "docker": {
      const sub = args[0];
      if (!sub) {
        return {
          output: "Usage: docker [OPTIONS] COMMAND\n\nSimulated Docker Client\n\nCommands:\n  run         Create and start a new container from an image\n  ps          List containers\n  stop        Stop one or more running containers\n  start       Start one or more stopped containers\n  rm          Remove one or more containers\n  images      List images",
          newState: state,
        };
      }

      switch (sub) {
        case "ps": {
          const showAll = args.includes("-a") || args.includes("--all");
          const list = showAll ? state.containers : state.containers.filter((c) => c.status.startsWith("Up"));
          if (list.length === 0) {
            return { output: "CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES", newState: state };
          }
          const headers = "CONTAINER ID   IMAGE          STATUS         PORTS                       NAMES";
          const rows = list.map((c) => `${c.id.padEnd(14)} ${c.image.padEnd(14)} ${c.status.padEnd(14)} ${c.ports.padEnd(27)} ${c.name}`);
          return { output: headers + "\n" + rows.join("\n"), newState: state };
        }

        case "images": {
          return {
            output: "REPOSITORY      TAG       IMAGE ID       CREATED        SIZE\nnginx           latest    51a9c9b1c7c9   2 weeks ago    142MB\nredis           7         c918a1bf181d   3 weeks ago    113MB\npostgres        15        db81ca0f421f   1 month ago    379MB\nubuntu          latest    35a81ca0ff8d   2 months ago   77.8MB",
            newState: state,
          };
        }

        case "run": {
          const detach = args.includes("-d") || args.includes("--detach");
          const portArgIdx = args.findIndex((a) => a === "-p" || a === "--publish");
          let ports = "80/tcp";
          if (portArgIdx !== -1 && args[portArgIdx + 1]) {
            const portsMapped = args[portArgIdx + 1];
            ports = `0.0.0.0:${portsMapped}->${portsMapped.split(":")[1] || portsMapped}/tcp`;
          }

          const nameArgIdx = args.findIndex((a) => a === "--name");
          let containerName = "";
          if (nameArgIdx !== -1 && args[nameArgIdx + 1]) {
            containerName = args[nameArgIdx + 1];
          }

          const image = args.find((a) => !a.startsWith("-") && a !== "run" && a !== args[portArgIdx + 1] && a !== args[nameArgIdx + 1]);
          if (!image) {
            return { output: "docker: \"run\" requires at least 1 argument.", newState: state };
          }

          const id = Math.random().toString(36).substring(2, 14);
          if (!containerName) {
            containerName = `my-${image.split(":")[0] || "app"}-${id.substring(0, 4)}`;
          }

          const newContainer: VirtualContainer = {
            id,
            image,
            status: "Up Less than a second",
            ports,
            name: containerName,
            created: "Just now",
          };

          const nextContainers = [...state.containers, newContainer];
          
          // Spawn container master process
          const containerPid = Math.max(...state.processes.map((p) => p.pid)) + 1;
          const nextProcs = [
            ...state.processes,
            { pid: containerPid, user: "root", cpu: 0.2, mem: 0.4, command: `/usr/sbin/${image.split(":")[0]} -g daemon off;`, startTime: "10:45" },
          ];

          return {
            output: detach ? id : `Unable to find image '${image}' locally...\nlatest: Pulling from library/${image}\nDigest: sha256:7f01c...\nStatus: Downloaded newer image for ${image}\n[Container Started Output: Logs for ${containerName}]`,
            newState: { ...state, containers: nextContainers, processes: nextProcs },
          };
        }

        case "stop": {
          const target = args[1];
          if (!target) {
            return { output: "docker stop: requires container ID or name", newState: state };
          }
          const cIdx = state.containers.findIndex((c) => c.id.startsWith(target) || c.name === target);
          if (cIdx === -1) {
            return { output: `Error response from daemon: No such container: ${target}`, newState: state };
          }
          const container = state.containers[cIdx];
          const nextContainers = [...state.containers];
          nextContainers[cIdx] = {
            ...container,
            status: "Exited (0) Just now",
          };

          // Remove nginx process from process list if stopped
          const nextProcs = state.processes.filter((p) => !p.command.includes(container.image.split(":")[0]));
          return { output: target, newState: { ...state, containers: nextContainers, processes: nextProcs } };
        }

        case "start": {
          const target = args[1];
          if (!target) {
            return { output: "docker start: requires container ID or name", newState: state };
          }
          const cIdx = state.containers.findIndex((c) => c.id.startsWith(target) || c.name === target);
          if (cIdx === -1) {
            return { output: `Error response from daemon: No such container: ${target}`, newState: state };
          }
          const container = state.containers[cIdx];
          const nextContainers = [...state.containers];
          nextContainers[cIdx] = {
            ...container,
            status: "Up 1 second",
          };

          // Re-spawn container process
          const containerPid = Math.max(...state.processes.map((p) => p.pid)) + 1;
          const nextProcs = [
            ...state.processes,
            { pid: containerPid, user: "root", cpu: 0.1, mem: 0.3, command: `/usr/sbin/${container.image.split(":")[0]}`, startTime: "10:45" },
          ];

          return { output: target, newState: { ...state, containers: nextContainers, processes: nextProcs } };
        }

        case "rm": {
          const target = args[1];
          if (!target) {
            return { output: "docker rm: requires container ID or name", newState: state };
          }
          const cIdx = state.containers.findIndex((c) => c.id.startsWith(target) || c.name === target);
          if (cIdx === -1) {
            return { output: `Error response from daemon: No such container: ${target}`, newState: state };
          }
          const container = state.containers[cIdx];
          if (container.status.startsWith("Up")) {
            return { output: `Error response from daemon: You cannot remove a running container ${container.id}. Stop the container before attempting removal or force remove.`, newState: state };
          }

          const nextContainers = state.containers.filter((_, idx) => idx !== cIdx);
          return { output: target, newState: { ...state, containers: nextContainers } };
        }

        default: {
          return { output: `docker: '${sub}' is not a docker command.\nSee 'docker --help'`, newState: state };
        }
      }
    }

    // Systemd services Subsystem
    case "systemctl": {
      const action = args[0];
      const serviceName = args[1];

      if (!action) {
        const rows = Object.values(state.services).map(
          (s) => `  ${s.name.padEnd(20)} loaded active   ${s.active.padEnd(17)} ${s.description}`
        );
        return {
          output: `  UNIT                 LOAD   ACTIVE   SUB               DESCRIPTION\n` + rows.join("\n"),
          newState: state,
        };
      }

      if (!serviceName) {
        return { output: `systemctl: service name required for '${action}'`, newState: state };
      }

      const sKey = serviceName.replace(".service", "");
      const srv = state.services[sKey];

      if (!srv) {
        return { output: `Failed to ${action} ${serviceName}: Unit ${serviceName} not found.`, newState: state };
      }

      const nextServices = { ...state.services };
      if (action === "status") {
        const activeColor = srv.active.includes("running") ? "active (running)" : "inactive (dead)";
        return {
          output: `● ${srv.name} - ${srv.description}\n     Loaded: loaded (/etc/systemd/system/${srv.name}; enabled; vendor preset: enabled)\n     Active: ${activeColor} since Sat 2026-05-23 10:40:12 UTC; 5min ago\n   Main PID: 91 (nginx)\n     Tasks: 2 (limit: 4661)\n     Memory: 4.2M\n        CPU: 12ms\n     CGroup: /system.slice/${srv.name}`,
          newState: state,
        };
      }

      if (action === "start") {
        nextServices[sKey] = { ...srv, active: "active (running)" };
        return { output: "", newState: { ...state, services: nextServices } };
      }

      if (action === "stop") {
        nextServices[sKey] = { ...srv, active: "inactive (dead)" };
        return { output: "", newState: { ...state, services: nextServices } };
      }

      if (action === "restart") {
        nextServices[sKey] = { ...srv, active: "active (running)" };
        return { output: `Restarting ${srv.name}...`, newState: { ...state, services: nextServices } };
      }

      return { output: `systemctl: unknown command '${action}'`, newState: state };
    }

    case "service": {
      const sName = args[0];
      const action = args[1];

      if (args.includes("--status-all")) {
        const list = Object.values(state.services).map((s) => ` [ ${s.active.includes("running") ? "+" : "-"} ]  ${s.name.replace(".service", "")}`);
        return { output: list.join("\n"), newState: state };
      }

      if (!sName || !action) {
        return { output: "Usage: service <service> <action>\nWhere action can be status, start, stop, restart", newState: state };
      }

      const sKey = sName.replace(".service", "");
      const srv = state.services[sKey];
      if (!srv) {
        return { output: `${sName}: unrecognized service`, newState: state };
      }

      const nextServices = { ...state.services };
      if (action === "status") {
        return { output: `● ${srv.name} - ${srv.description}\n   Active: ${srv.active}`, newState: state };
      }

      if (action === "start") {
        nextServices[sKey] = { ...srv, active: "active (running)" };
        return { output: `Starting ${srv.name}...`, newState: { ...state, services: nextServices } };
      }

      if (action === "stop") {
        nextServices[sKey] = { ...srv, active: "inactive (dead)" };
        return { output: `Stopping ${srv.name}...`, newState: { ...state, services: nextServices } };
      }

      if (action === "restart") {
        nextServices[sKey] = { ...srv, active: "active (running)" };
        return { output: `Restarting ${srv.name}...`, newState: { ...state, services: nextServices } };
      }

      return { output: `service: unknown action '${action}'`, newState: state };
    }

    // Networking Stack Subsystem
    case "ifconfig": {
      return {
        output: `eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet 192.168.1.37  netmask 255.255.255.0  broadcast 192.168.1.255\n        inet6 fe80::5054:ff:fe12:3456  prefixlen 64  scopeid 0x20<link>\n        ether 52:54:00:12:34:56  txqueuelen 1000  (Ethernet)\n        RX packets 142083  bytes 210403126 (210.4 MB)\n        TX packets 92837  bytes 12903827 (12.9 MB)\n\nlo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536\n        inet 127.0.0.1  netmask 255.0.0.0\n        inet6 ::1  prefixlen 128  scopeid 0x10<host>\n        loop  txqueuelen 1000  (Local Loopback)\n        RX packets 8273  bytes 910283 (910.2 KB)\n        TX packets 8273  bytes 910283 (910.2 KB)`,
        newState: state,
      };
    }

    case "ping": {
      const host = args[0];
      if (!host) {
        return { output: "ping: missing host operand", newState: state };
      }
      const ip = host === "localhost" || host === "127.0.0.1" ? "127.0.0.1" : "140.82.121.3";
      const lines = [
        `PING ${host} (${ip}) 56(84) bytes of data.`,
        `64 bytes from ${ip}: icmp_seq=1 ttl=64 time=0.045 ms`,
        `64 bytes from ${ip}: icmp_seq=2 ttl=64 time=0.038 ms`,
        `64 bytes from ${ip}: icmp_seq=3 ttl=64 time=0.041 ms`,
        `64 bytes from ${ip}: icmp_seq=4 ttl=64 time=0.039 ms`,
        `--- ${host} ping statistics ---`,
        `4 packets transmitted, 4 received, 0% packet loss, time 3004ms`,
        `rtt min/avg/max/mdev = 0.038/0.040/0.045/0.003 ms`,
      ];
      return { output: lines.join("\n"), newState: state };
    }

    case "netstat": {
      return {
        output: `Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address           Foreign Address         State      PID/Program name   \ntcp        0      0 127.0.0.1:6379          0.0.0.0:*               LISTEN     12da91bc1/redis-ser\ntcp        0      0 0.0.0.0:80              0.0.0.0:*               LISTEN     91/nginx: master pr\ntcp6       0      0 :::80                   :::*                    LISTEN     91/nginx: master pr`,
        newState: state,
      };
    }

    // Package Manager Subsystem
    case "apt":
    case "apt-get": {
      const sub = args[0];
      if (!sub) {
        return {
          output: "apt 2.4.8 (amd64)\nUsage: apt command [options]\n\nCommands:\n  update      - Retrieve new lists of packages\n  upgrade     - Perform an upgrade\n  install     - Install new packages\n  remove      - Remove packages",
          newState: state,
        };
      }

      if (sub === "update") {
        return {
          output: "Get:1 http://archive.ubuntu.com/ubuntu jammy InRelease [270 kB]\nGet:2 http://archive.ubuntu.com/ubuntu jammy-updates InRelease [119 kB]\nGet:3 http://security.ubuntu.com/ubuntu jammy-security InRelease [110 kB]\nFetched 499 kB in 1s (410 kB/s)\nReading package lists... Done\nBuilding dependency tree... Done\n12 packages can be upgraded. Run 'apt list --upgradable' to see them.",
          newState: state,
        };
      }

      if (sub === "install") {
        const pkg = args[1];
        if (!pkg) {
          return { output: "apt: install: package name required", newState: state };
        }
        if (state.packages.has(pkg)) {
          return { output: `${pkg} is already the newest version (1.0.0-linlearn).`, newState: state };
        }

        const nextPkgs = new Set(state.packages);
        nextPkgs.add(pkg);

        // Add packages to VFS bin
        const now = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
        const newBinFile: VirtualFile = {
          type: "file",
          content: `#!/bin/bash\necho "Simulated execution of ${pkg}"`,
          permissions: "-rwxr-xr-x",
          owner: "root",
          group: "root",
          modifiedAt: now,
        };
        const nextFs = setNode(state.fs, `/usr/bin/${pkg}`, newBinFile);

        return {
          output: `Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nThe following NEW packages will be installed:\n  ${pkg}\n0 upgraded, 1 newly installed, 0 to remove.\nNeed to get 142 kB of archives.\nUnpacking ${pkg} (1.0.0) ...\nSetting up ${pkg} (1.0.0) ...\nProcessing triggers for man-db ...`,
          newState: { ...state, packages: nextPkgs, fs: nextFs },
        };
      }

      if (sub === "remove") {
        const pkg = args[1];
        if (!pkg) {
          return { output: "apt: remove: package name required", newState: state };
        }
        if (!state.packages.has(pkg)) {
          return { output: `Package '${pkg}' is not installed, so not removed`, newState: state };
        }

        const nextPkgs = new Set(state.packages);
        nextPkgs.delete(pkg);
        const nextFs = deleteNode(state.fs, `/usr/bin/${pkg}`);
        return {
          output: `Reading package lists... Done\nBuilding dependency tree... Done\nRemoving ${pkg} (1.0.0) ...\nProcessing triggers for man-db ...`,
          newState: { ...state, packages: nextPkgs, fs: nextFs },
        };
      }

      return { output: `apt: unknown subcommand '${sub}'`, newState: state };
    }

    // User Management Subsystem
    case "su": {
      const targetUser = args[0] || "root";
      const nextEnv = { ...state.env, USER: targetUser, HOME: targetUser === "root" ? "/root" : `/home/${targetUser}` };
      return {
        output: `Password: \nSwitched to user ${targetUser}.`,
        newState: { ...state, currentUser: targetUser, env: nextEnv, cwd: targetUser === "root" ? "/root" : `/home/${targetUser}` },
      };
    }

    case "useradd": {
      const username = args[0];
      if (!username) {
        return { output: "useradd: missing username", newState: state };
      }
      const now = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
      const homePath = `/home/${username}`;
      const nextFs = setNode(state.fs, homePath, {
        type: "dir",
        permissions: "drwxr-xr-x",
        owner: username,
        group: username,
        modifiedAt: now,
        children: {},
      });
      return { output: "", newState: { ...state, fs: nextFs } };
    }

    // Manual Pages System
    case "man": {
      const target = args[0];
      if (!target) {
        return { output: "What manual page do you want?", newState: state };
      }

      const manPages: Record<string, string> = {
        ls: "LS(1)                            User Commands                           LS(1)\n\nNAME\n       ls - list directory contents\n\nSYNOPSIS\n       ls [OPTION]... [FILE]...\n\nDESCRIPTION\n       List  information  about  the FILEs (the current directory by default).\n       Sort entries alphabetically if none of -cftuvSUX nor --sort  is  speci‐\n       fied.\n\n       -a, --all\n              do not ignore entries starting with .\n\n       -l     use a long listing format",
        docker: "DOCKER(1)                         Docker Client                         DOCKER(1)\n\nNAME\n       docker - Docker image and container command line interface\n\nSYNOPSIS\n       docker [OPTIONS] COMMAND [ARG...]\n\nDESCRIPTION\n       A command line tool to create, manage, run and monitor container\n       instances on a virtual Docker host engine.",
        systemctl: "SYSTEMCTL(1)                       systemctl                      SYSTEMCTL(1)\n\nNAME\n       systemctl - Control the systemd system and service manager\n\nSYNOPSIS\n       systemctl [OPTIONS...] COMMAND [UNIT...]\n\nDESCRIPTION\n       systemctl may be used to introspect and control the state of the\n       systemd system and service manager.",
        chmod: "CHMOD(1)                         User Commands                        CHMOD(1)\n\nNAME\n       chmod - change file mode bits\n\nSYNOPSIS\n       chmod [OPTION]... MODE[,MODE]... FILE...\n\nDESCRIPTION\n       This manual page documents the GNU version of chmod.  chmod changes the\n       file mode bits of each given file according to MODE, which can be either\n       a symbolic representation of changes to make, or an octal number.",
      };

      const doc = manPages[target] || `No manual entry for ${target}\nSimulating search... consult LinLearn AI Chatbot for full documentation.`;
      return { output: doc, newState: state };
    }

    // Simple piping helpers (standard filters)
    case "grep": {
      const pattern = args.find((a) => !a.startsWith("-"));
      if (!pattern) {
        return { output: stdin, newState: state }; // acts as pass-through
      }
      const lines = stdin.split("\n");
      const matched = lines.filter((l) => l.toLowerCase().includes(pattern.toLowerCase()));
      return { output: matched.join("\n"), newState: state };
    }

    case "wc": {
      const showLines = args.includes("-l");
      const lines = stdin.split("\n").filter((l) => l.length > 0);
      if (showLines) {
        return { output: `      ${lines.length}`, newState: state };
      }
      return { output: `      ${lines.length}      ${stdin.split(/\s+/).filter(Boolean).length}     ${stdin.length}`, newState: state };
    }

    case "head": {
      const nArgIdx = args.indexOf("-n");
      let count = 10;
      if (nArgIdx !== -1 && args[nArgIdx + 1]) {
        count = parseInt(args[nArgIdx + 1], 10);
      }
      const lines = stdin.split("\n");
      return { output: lines.slice(0, count).join("\n"), newState: state };
    }

    case "tail": {
      const nArgIdx = args.indexOf("-n");
      let count = 10;
      if (nArgIdx !== -1 && args[nArgIdx + 1]) {
        count = parseInt(args[nArgIdx + 1], 10);
      }
      const lines = stdin.split("\n");
      return { output: lines.slice(-count).join("\n"), newState: state };
    }

    default: {
      // Command Not Found - we will trigger LLM fallback or default message
      return { output: `bash: ${trimmedCmd}: command not found`, newState: state };
    }
  }
}
