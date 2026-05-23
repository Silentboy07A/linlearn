export interface DangerCheckResult {
  isDangerous: boolean;
  name: string;
  risk: string;
}

const DANGEROUS_RULES = [
  { pattern: /rm\s+-rf\s+\//, name: "rm -rf /", risk: "Destroys the entire filesystem recursively from root." },
  { pattern: /rm\s+-rf\s+\*/, name: "rm -rf *", risk: "Destroys all files and folders in the current directory recursively." },
  { pattern: /\bmkfs\b/, name: "mkfs", risk: "Builds a new filesystem on a partition, wiping all existing data." },
  { pattern: /\bfdisk\b/, name: "fdisk", risk: "Edits disk partitions, which can corrupt partition tables and delete volumes." },
  { pattern: /\bdd\b/, name: "dd", risk: "Low-level block copier. Can easily overwrite system partitions directly." },
  { pattern: /\bshutdown\b/, name: "shutdown", risk: "Turns off the operating system." },
  { pattern: /\breboot\b/, name: "reboot", risk: "Restarts the operating system." },
  { pattern: /\bhalt\b/, name: "halt", risk: "Halts the system immediately." },
  { pattern: /\bpoweroff\b/, name: "poweroff", risk: "Powers down the hardware." },
  { pattern: /\binit\s+[06]\b/, name: "init 0 or 6", risk: "Changes runlevels to shut down or restart the system." },
  { pattern: /\binit\b/, name: "init", risk: "Bypasses systemd to modify fundamental runlevels." },
  { pattern: /\bkill\s+-9\b/, name: "kill -9", risk: "Sends SIGKILL to force-terminate processes instantly without cleanup." },
  { pattern: /\bkillall\b/, name: "killall", risk: "Kills all processes matching a name, potentially halting system services." },
  { pattern: /\bchmod\s+777\s+\//, name: "chmod 777 /", risk: "Opens root directory permissions fully, breaking OS access boundaries." },
  { pattern: /\bchown\b/, name: "chown", risk: "Alters file and directory ownership, which can break system processes." },
  { pattern: /\bsudo\s+su\b/, name: "sudo su", risk: "Accesses the root user account directly to spawn a root terminal shell." },
  { pattern: /\bsu\b/, name: "su", risk: "Switches to another user shell (typically root)." },
  { pattern: /\bpasswd\b/, name: "passwd", risk: "Changes passwords of users or root." },
  { pattern: /\buseradd\b/, name: "useradd", risk: "Adds user accounts." },
  { pattern: /\busermod\b/, name: "usermod", risk: "Modifies user credentials." },
  { pattern: /\bgroupadd\b/, name: "groupadd", risk: "Creates user groups." },
  { pattern: /\bmount\b/, name: "mount", risk: "Mounts filesystems or hardware drives." },
  { pattern: /\bumount\b/, name: "umount", risk: "Unmounts mounted filesystems." },
  { pattern: /\bsystemctl\b/, name: "systemctl", risk: "Controls services, targets, and boot properties." },
  { pattern: /\bservice\b/, name: "service", risk: "Runs system V initialization scripts to control services." },
  { pattern: /\biptables\b/, name: "iptables", risk: "Updates firewall and network packet routing tables." },
  { pattern: /curl\s+.*\|\s*(bash|sh)\b/, name: "curl | bash", risk: "Executes remote, unverified scripts directly into the terminal." },
  { pattern: /wget\s+.*\|\s*(bash|sh)\b/, name: "wget | bash", risk: "Executes remote, unverified scripts directly into the terminal." },
  { pattern: /\bnc\b/, name: "nc", risk: "Netcat networking utility, commonly used for reverse shell exploits." },
  { pattern: /\bnetcat\b/, name: "netcat", risk: "Netcat networking utility, commonly used for reverse shell exploits." },
  { pattern: /\bssh\b/, name: "ssh", risk: "Opens shell sessions on remote computers." },
  { pattern: /\bscp\b/, name: "scp", risk: "Copies files over remote secure networks." },
  { pattern: /\bftp\b/, name: "ftp", risk: "Transfers files over unencrypted network protocols." },
  { pattern: /\btelnet\b/, name: "telnet", risk: "Transfers unencrypted network terminal streams." },
  { pattern: /\bdocker\b/, name: "docker", risk: "Spawns or deletes application containers." },
  { pattern: /\bkubectl\b/, name: "kubectl", risk: "Alters running Kubernetes pod resources." },
  { pattern: /\bcrontab\b/, name: "crontab", risk: "Alters root or user automated job schedules." },
  { pattern: /\bat\b/, name: "at", risk: "Schedules one-off automated tasks." },
  { pattern: /\bnohup\b/, name: "nohup", risk: "Runs shell tasks in the background immune to logouts." },
  { pattern: /\bscreen\b/, name: "screen", risk: "Multiplexes terminal outputs." },
  { pattern: /\btmux\b/, name: "tmux", risk: "Multiplexes terminal outputs." },
];

export function checkDangerousCommand(cmd: string): DangerCheckResult | null {
  const trimmed = cmd.trim();
  for (const rule of DANGEROUS_RULES) {
    if (rule.pattern.test(trimmed)) {
      return { isDangerous: true, name: rule.name, risk: rule.risk };
    }
  }
  return null;
}
