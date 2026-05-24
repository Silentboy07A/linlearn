// src/missions/config.ts

export type MissionCategory = "Beginner" | "DevOps" | "Security" | "Interview";

export interface MissionRule {
  type: "file_exists" | "directory_exists" | "file_contains" | "permissions_match" | "process_running";
  target: string;
  expected?: string | number; // String matches, octal permissions (e.g. 755), etc.
}

export interface Mission {
  id: string;
  category: MissionCategory;
  title: string;
  desc: string;
  hint: string;
  expectedBehavior: string; // Used by KKM judge for semantic checking
  rules: MissionRule[];
}

export const MISSIONS: Mission[] = [
  // --- Beginner Category ---
  {
    id: "pwd_ls",
    category: "Beginner",
    title: "Explore Directories",
    desc: "Execute 'pwd' and 'ls' to identify active path mappings.",
    hint: "pwd && ls",
    expectedBehavior: "Identify the current working directory path and list its contents.",
    rules: [
      // Basic check: user running navigation queries
      { type: "directory_exists", target: "/home/user" }
    ]
  },
  {
    id: "mkdir_proj",
    category: "Beginner",
    title: "Create Work Directory",
    desc: "Create a new sub-folder directory at /home/user/Projects.",
    hint: "mkdir -p /home/user/Projects",
    expectedBehavior: "Create a directory named 'Projects' inside the home folder.",
    rules: [
      { type: "directory_exists", target: "/home/user/Projects" }
    ]
  },
  {
    id: "touch_config",
    category: "Beginner",
    title: "Create Configuration File",
    desc: "Initialize an empty file at /home/user/Projects/config.txt.",
    hint: "touch /home/user/Projects/config.txt",
    expectedBehavior: "Create a file named 'config.txt' inside '/home/user/Projects'.",
    rules: [
      { type: "file_exists", target: "/home/user/Projects/config.txt" }
    ]
  },

  // --- DevOps Category ---
  {
    id: "nginx",
    category: "DevOps",
    title: "Fix Broken Nginx Config",
    desc: "The Nginx configuration file /etc/nginx/nginx.conf has a syntax error. Edit it and delete the line containing 'syntax_error_here'.",
    hint: "vi /etc/nginx/nginx.conf",
    expectedBehavior: "Correct the Nginx configuration file syntax errors.",
    rules: [
      { type: "file_exists", target: "/etc/nginx/nginx.conf" },
      { type: "file_contains", target: "/etc/nginx/nginx.conf", expected: "listen 80" }
    ]
  },
  {
    id: "logs",
    category: "DevOps",
    title: "Investigate Access Logs",
    desc: "Inspect the Nginx access log file at /var/log/nginx/access.log to trace client hits.",
    hint: "cat /var/log/nginx/access.log",
    expectedBehavior: "Inspect and view hits/IP info inside log files.",
    rules: [
      { type: "file_exists", target: "/var/log/nginx/access.log" },
      { type: "file_contains", target: "/var/log/nginx/access.log", expected: "192.168.1.100" }
    ]
  },
  {
    id: "htop",
    category: "DevOps",
    title: "Verify htop Installation",
    desc: "Verify if the htop system monitoring binary is successfully located in the system path.",
    hint: "which htop",
    expectedBehavior: "Locate or verify path binary installation of htop.",
    rules: [
      { type: "process_running", target: "htop" } // or checks if binary exists in /usr/bin/htop or /usr/local/bin/htop
    ]
  },

  // --- Security Category ---
  {
    id: "permissions",
    category: "Security",
    title: "Create Executable Script",
    desc: "Create an executable script at /home/user/Projects/deploy.sh.",
    hint: "touch /home/user/Projects/deploy.sh && chmod +x /home/user/Projects/deploy.sh",
    expectedBehavior: "Create a deploy shell script and grant execution permissions.",
    rules: [
      { type: "file_exists", target: "/home/user/Projects/deploy.sh" },
      { type: "permissions_match", target: "/home/user/Projects/deploy.sh", expected: 755 } // executable permissions (e.g. 755 or 700 or +x matching)
    ]
  },
  {
    id: "lock_config",
    category: "Security",
    title: "Lock Config Permissions",
    desc: "Set Projects/config.txt to be read-only (remove all write permissions).",
    hint: "chmod 400 Projects/config.txt",
    expectedBehavior: "Lock file configuration by stripping write permissions.",
    rules: [
      { type: "file_exists", target: "/home/user/Projects/config.txt" },
      { type: "permissions_match", target: "/home/user/Projects/config.txt", expected: 400 } // read-only 400 or 444
    ]
  },
  {
    id: "audit_dangerous",
    category: "Security",
    title: "Audit Sandbox Safeguards",
    desc: "Test security safeguards by attempting to execute a dangerous or destructive command.",
    hint: "rm -rf /",
    expectedBehavior: "Trigger risk analysis and security filter by simulating dangerous commands.",
    rules: [] // Risk engine logs blocked keyword
  },

  // --- Interview Prep Category ---
  {
    id: "sysinfo",
    category: "Interview",
    title: "Query System Info",
    desc: "Query virtual hostname and current user login context.",
    hint: "whoami && uname -a",
    expectedBehavior: "Query system kernel, OS release, and current logged-in username.",
    rules: []
  },
  {
    id: "services",
    category: "Interview",
    title: "Review systemd Status",
    desc: "Inspect active service configurations on the system.",
    hint: "systemctl status nginx.service",
    expectedBehavior: "Inspect the status of system services and background daemons.",
    rules: []
  },
  {
    id: "processes",
    category: "Interview",
    title: "Inspect Process Tree",
    desc: "Query standard process listing tables.",
    hint: "ps aux",
    expectedBehavior: "List and view currently running processes.",
    rules: []
  }
];

export function getMissionsByCategory(category: MissionCategory): Mission[] {
  return MISSIONS.filter(m => m.category === category);
}

export function getMissionById(id: string): Mission | undefined {
  return MISSIONS.find(m => m.id === id);
}
