export type CommandSource = "local" | "ai" | "db";

export interface CommandDBEntry {
  pattern: RegExp;
  output: string;
}

const COMMAND_DB_ENTRIES: CommandDBEntry[] = [
  {
    pattern: /^grep(\s|$)/,
    output:
      "usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.",
  },
  {
    pattern: /^awk(\s|$)/,
    output:
      "Usage: awk [POSIX or GNU style options] -f progfile [--] file ...\nUsage: awk [POSIX or GNU style options] [--] 'program' file ...",
  },
  {
    pattern: /^sed(\s|$)/,
    output:
      "sed: usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...",
  },
  {
    pattern: /^find(\s|$)/,
    output:
      "./\n./README.md\n./src\n./src/app\n./src/components\n./src/lib\n./package.json",
  },
  {
    pattern: /^chmod(\s|$)/,
    output: "chmod: changed permissions of 'deploy.sh' from 0644 to 0755",
  },
  {
    pattern: /^chown(\s|$)/,
    output: "chown: changed ownership of '/var/www' to ubuntu:www-data",
  },
  {
    pattern: /^ps(\s|$)/,
    output:
      "  PID TTY          TIME CMD\n 1293 pts/0    00:00:00 bash\n 2411 pts/0    00:00:00 node\n 2549 pts/0    00:00:00 ps",
  },
  {
    pattern: /^kill(\s|$)/,
    output: "Process 2411 terminated",
  },
  {
    pattern: /^curl(\s|$)/,
    output:
      "HTTP/2 200\ncontent-type: application/json\nserver: nginx\n\n{\"status\":\"ok\",\"service\":\"linlearn-api\"}",
  },
  {
    pattern: /^ping(\s|$)/,
    output:
      "PING github.com (140.82.121.3) 56(84) bytes of data.\n64 bytes from 140.82.121.3: icmp_seq=1 ttl=56 time=21.4 ms\n64 bytes from 140.82.121.3: icmp_seq=2 ttl=56 time=21.0 ms",
  },
  {
    pattern: /^git\s+status(\s|$)/,
    output:
      "On branch main\nYour branch is up to date with 'origin/main'.\n\nChanges not staged for commit:\n  modified:   src/components/TerminalSimulator.tsx",
  },
  {
    pattern: /^git\s+log(\s|$)/,
    output:
      "commit 8f9f7b1\nAuthor: LinLearn User <user@linlearn.dev>\nDate:   Tue May 19 19:08:44 2026 +0530\n\n    feat: add quiz arena scaffolding",
  },
  {
    pattern: /^git\s+diff(\s|$)/,
    output:
      "diff --git a/src/components/Dashboard.tsx b/src/components/Dashboard.tsx\nindex 4af1..89b1 100644\n--- a/src/components/Dashboard.tsx\n+++ b/src/components/Dashboard.tsx\n@@ -10,6 +10,8 @@",
  },
  {
    pattern: /^git\s+clone(\s|$)/,
    output:
      "Cloning into 'project'...\nremote: Enumerating objects: 124, done.\nReceiving objects: 100% (124/124), done.",
  },
  {
    pattern: /^git\s+pull(\s|$)/,
    output: "Already up to date.",
  },
  {
    pattern: /^git\s+push(\s|$)/,
    output: "Everything up-to-date",
  },
  {
    pattern: /^apt(\s+update)?(\s|$)/,
    output:
      "Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease\nHit:2 http://archive.ubuntu.com/ubuntu jammy-updates InRelease\nReading package lists... Done",
  },
  {
    pattern: /^apt\s+install(\s|$)/,
    output:
      "Reading package lists... Done\nBuilding dependency tree... Done\nThe following NEW packages will be installed:\n  htop\n0 upgraded, 1 newly installed, 0 to remove and 12 not upgraded.",
  },
  {
    pattern: /^apt\s+upgrade(\s|$)/,
    output:
      "Reading package lists... Done\nBuilding dependency tree... Done\nCalculating upgrade... Done\n0 upgraded, 0 newly installed, 0 to remove.",
  },
  {
    pattern: /^tar(\s|$)/,
    output: "archive.tar.gz\n./src\n./src/app\n./src/components",
  },
  {
    pattern: /^zip(\s|$)/,
    output:
      "  adding: src/ (stored 0%)\n  adding: src/app/ (stored 0%)\n  adding: package.json (deflated 48%)",
  },
  {
    pattern: /^df(\s|$)/,
    output:
      "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       98G   22G   71G  24% /\ntmpfs           1.9G     0  1.9G   0% /dev/shm",
  },
  {
    pattern: /^du(\s|$)/,
    output:
      "4.0K\t./README.md\n312K\t./src\n428K\t./node_modules/.cache\n12M\t.",
  },
  {
    pattern: /^top(\s|$)/,
    output:
      "top - 11:29:18 up 3 days,  2:11,  1 user,  load average: 0.04, 0.05, 0.08\nTasks: 173 total,   1 running, 172 sleeping,   0 stopped,   0 zombie\n%Cpu(s):  3.4 us,  0.9 sy, 95.7 id",
  },
  {
    pattern: /^env(\s|$)/,
    output:
      "USER=user\nHOME=/home/user\nSHELL=/bin/bash\nLANG=en_US.UTF-8\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  },
  {
    pattern: /^man(\s|$)/,
    output:
      "MANUAL PAGE\n\nNAME\n    command - simulated manual page\n\nSYNOPSIS\n    command [options] [arguments]",
  },
  {
    pattern: /^wget(\s|$)/,
    output:
      "--2026-05-20--  https://example.com\nResolving example.com... 93.184.216.34\nConnecting to example.com|93.184.216.34|:443... connected.\nHTTP request sent, awaiting response... 200 OK",
  },
  {
    pattern: /^ssh(\s|$)/,
    output:
      "The authenticity of host 'server.example.com (10.0.0.12)' can't be established.\nECDSA key fingerprint is SHA256:3x...\nAre you sure you want to continue connecting (yes/no/[fingerprint])?",
  },
  {
    pattern: /^netstat(\s|$)/,
    output:
      "Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address           Foreign Address         State\ntcp        0      0 0.0.0.0:3000            0.0.0.0:*               LISTEN",
  },
  {
    pattern: /^ifconfig(\s|$)/,
    output:
      "eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet 192.168.1.37  netmask 255.255.255.0  broadcast 192.168.1.255",
  },
  {
    pattern: /^crontab(\s|$)/,
    output:
      "# m h  dom mon dow   command\n0 3 * * * /usr/bin/backup --daily\n*/15 * * * * /usr/bin/health-check",
  },
  {
    pattern: /^diff(\s|$)/,
    output: "1c1\n< old line\n---\n> new line",
  },
  {
    pattern: /^wc(\s|$)/,
    output: "      42      268     1743 README.md",
  },
  {
    pattern: /^sort(\s|$)/,
    output: "alpha\nbravo\ncharlie\ndelta",
  },
  {
    pattern: /^uniq(\s|$)/,
    output: "error\ninfo\nwarning",
  },
  {
    pattern: /^head(\s|$)/,
    output: "#!/bin/bash\nset -euo pipefail\necho \"Deploy start\"",
  },
  {
    pattern: /^tail(\s|$)/,
    output:
      "[2026-05-20T11:28:11Z] build complete\n[2026-05-20T11:28:14Z] tests passed\n[2026-05-20T11:28:19Z] deployed",
  },
  {
    pattern: /^systemctl(\s|$)/,
    output:
      "linlearn.service - LinLearn Demo Service\n   Loaded: loaded (/etc/systemd/system/linlearn.service; enabled)\n   Active: active (running) since Wed 2026-05-20 10:10:12 UTC",
  },
  {
    pattern: /^python3(\s|$)/,
    output:
      "Python 3.10.12 (main, Apr 10 2026, 20:10:12) [GCC 11.4.0] on linux\nType 'help', 'copyright', 'credits' or 'license' for more information.",
  },
  {
    pattern: /^node(\s|$)/,
    output: "Welcome to Node.js v20.16.0.\nType \".help\" for more information.",
  },
  {
    pattern: /^npm(\s|$)/,
    output:
      "Usage: npm <command>\n\nwhere <command> is one of:\n  install, run, test, publish, login\n\nnpm help <command> for more details",
  },
  {
    pattern: /^sudo(\s|$)/,
    output: "[sudo] password for user: ",
  },
];

export function getCommandDBOutput(command: string): string | null {
  const cleaned = command.trim();
  if (!cleaned) {
    return null;
  }

  const entry = COMMAND_DB_ENTRIES.find((candidate) => candidate.pattern.test(cleaned));
  return entry?.output ?? null;
}
