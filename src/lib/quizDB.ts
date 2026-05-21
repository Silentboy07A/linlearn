export const QUIZ_CATEGORIES = [
  "File System",
  "Networking",
  "Permissions",
  "Process Management",
  "Git",
  "Package Management",
] as const;

export type QuizCategory = (typeof QUIZ_CATEGORIES)[number];

export interface QuizDBQuestion {
  question: string;
  options: [string, string, string, string];
  correct: number;
  explanation: string;
}

export const QUIZ_DB: Record<QuizCategory, QuizDBQuestion[]> = {
  "File System": [
    {
      question: "Which command lists files including hidden ones?",
      options: ["ls -a", "ls -h", "list --all", "dir -hidden"],
      correct: 0,
      explanation: "`ls -a` includes dotfiles and hidden entries.",
    },
    {
      question: "What does `pwd` print?",
      options: ["Current username", "Current working directory", "Parent directory", "Disk usage"],
      correct: 1,
      explanation: "`pwd` means print working directory.",
    },
    {
      question: "Which command recursively copies a directory?",
      options: ["cp -r source target", "mv -r source target", "copydir source target", "rsync source target only"],
      correct: 0,
      explanation: "Use `cp -r` to copy directories recursively.",
    },
    {
      question: "How do you move up one directory from `/home/user/projects`?",
      options: ["cd /", "cd ../..", "cd ..", "cd -1"],
      correct: 2,
      explanation: "`cd ..` navigates to the parent directory.",
    },
    {
      question: "Which command finds files named `notes.txt` under current path?",
      options: ["search notes.txt", "find . -name notes.txt", "locate -type file notes.txt", "grep -r notes.txt ."],
      correct: 1,
      explanation: "`find . -name notes.txt` searches by filename from current directory.",
    },
    {
      question: "What does `rm -r folder` do?",
      options: ["Renames folder", "Removes folder recursively", "Restores folder", "Reads folder"],
      correct: 1,
      explanation: "The `-r` option removes directories and their contents recursively.",
    },
    {
      question: "Which command displays file content with line numbers?",
      options: ["cat -n file.txt", "nl only", "less --count file.txt", "view file.txt -l"],
      correct: 0,
      explanation: "`cat -n` prefixes output lines with numbers.",
    },
    {
      question: "Which command creates an empty file if it does not exist?",
      options: ["mkfile", "new file.txt", "touch file.txt", "cat > file.txt always"],
      correct: 2,
      explanation: "`touch` creates an empty file or updates timestamps.",
    },
    {
      question: "What does `du -sh .` show?",
      options: ["Disk free space", "Human-readable total directory size", "System memory", "Directory permissions"],
      correct: 1,
      explanation: "`du -sh` prints summarized size in a readable format.",
    },
    {
      question: "Which command prints first 10 lines of a file?",
      options: ["tail file.txt", "head file.txt", "cat --start 10 file.txt", "sed -n '$p' file.txt"],
      correct: 1,
      explanation: "`head` shows the first lines by default.",
    },
  ],
  Networking: [
    {
      question: "Which command checks basic connectivity to a host?",
      options: ["ping", "route", "netcfg", "ifup"],
      correct: 0,
      explanation: "`ping` sends ICMP echo requests to test reachability.",
    },
    {
      question: "What does `curl -I https://example.com` return?",
      options: ["DNS records", "HTTP headers only", "TLS certificate chain only", "Full HTML and JS bundle"],
      correct: 1,
      explanation: "`-I` requests and prints headers only.",
    },
    {
      question: "Which tool shows listening TCP/UDP ports on many Linux systems?",
      options: ["netstat -tuln", "ip route", "hostnamectl", "dig -l"],
      correct: 0,
      explanation: "`netstat -tuln` lists listening ports numerically.",
    },
    {
      question: "Which command displays IP configuration info?",
      options: ["ifconfig", "mknet", "portscan", "tracehost"],
      correct: 0,
      explanation: "`ifconfig` (or `ip addr` on modern systems) shows interface details.",
    },
    {
      question: "Which command resolves DNS names and can fetch HTTP resources?",
      options: ["curl", "chmod", "tar", "kill"],
      correct: 0,
      explanation: "`curl` is used for network requests including DNS resolution via URL.",
    },
    {
      question: "What is the default port for SSH?",
      options: ["22", "80", "443", "3306"],
      correct: 0,
      explanation: "SSH servers typically listen on TCP port 22.",
    },
    {
      question: "Which command can download files non-interactively?",
      options: ["wget", "nano", "head", "tee"],
      correct: 0,
      explanation: "`wget` is built for file downloads in scripts/CLI.",
    },
    {
      question: "What does `ping` primarily measure?",
      options: ["Disk IO", "Round-trip latency and packet loss", "CPU usage", "TLS handshake speed only"],
      correct: 1,
      explanation: "`ping` helps measure latency and reachability.",
    },
    {
      question: "Which command commonly shows active network socket connections?",
      options: ["netstat", "chmod", "useradd", "rm"],
      correct: 0,
      explanation: "`netstat` (or `ss`) shows connection and socket information.",
    },
    {
      question: "Which command starts an SSH client session?",
      options: ["ssh user@host", "scp host", "sudo host", "netstat host"],
      correct: 0,
      explanation: "`ssh user@host` opens a remote shell session.",
    },
  ],
  Permissions: [
    {
      question: "Which command changes file permissions?",
      options: ["chown", "chmod", "whoami", "passwd"],
      correct: 1,
      explanation: "`chmod` changes permission bits.",
    },
    {
      question: "What does permission `755` mean for a file?",
      options: ["Owner rwx, group r-x, others r-x", "Owner rw-, group r--, others r--", "All users rwx", "Owner r-x only"],
      correct: 0,
      explanation: "7=rwx, 5=r-x, 5=r-x.",
    },
    {
      question: "Which command changes the owner of a file?",
      options: ["chown", "chmod", "umask", "su"],
      correct: 0,
      explanation: "`chown` modifies ownership.",
    },
    {
      question: "What does `chmod +x deploy.sh` do?",
      options: ["Deletes script", "Adds execute permission", "Changes owner to root", "Encrypts script"],
      correct: 1,
      explanation: "`+x` adds executable permission.",
    },
    {
      question: "Which command displays your current user?",
      options: ["user", "id -g", "whoami", "ls -l"],
      correct: 2,
      explanation: "`whoami` prints the effective username.",
    },
    {
      question: "What is the purpose of `sudo`?",
      options: ["Sort files", "Run command with elevated privileges", "Change shell", "Start SSH daemon"],
      correct: 1,
      explanation: "`sudo` runs commands as another user (default root).",
    },
    {
      question: "Which symbolic mode removes write for group?",
      options: ["g-w", "g+x", "o-r", "u=w"],
      correct: 0,
      explanation: "`g-w` removes group write permission.",
    },
    {
      question: "Which permission string represents a directory with full owner access only?",
      options: ["drwx------", "drwxr-xr-x", "-rw-------", "d---------"],
      correct: 0,
      explanation: "`drwx------` means only owner can read/write/execute.",
    },
    {
      question: "Why is execute (`x`) needed on directories?",
      options: ["To view file contents", "To traverse into the directory", "To delete directory", "To rename files automatically"],
      correct: 1,
      explanation: "Execute on directories allows traversal (`cd` into it).",
    },
    {
      question: "Which command shows detailed permissions in listings?",
      options: ["ls -l", "cat -p", "pwd -l", "grep --perm"],
      correct: 0,
      explanation: "`ls -l` shows permission bits, owner, group, etc.",
    },
  ],
  "Process Management": [
    {
      question: "Which command lists running processes in snapshot form?",
      options: ["ps", "kill", "top", "cron"],
      correct: 0,
      explanation: "`ps` prints a snapshot of process states.",
    },
    {
      question: "Which command continuously shows live process stats?",
      options: ["top", "head", "history", "sort"],
      correct: 0,
      explanation: "`top` provides a live view of CPU/memory/processes.",
    },
    {
      question: "How do you terminate process ID 1234?",
      options: ["rm 1234", "kill 1234", "stop 1234", "ps 1234 --kill"],
      correct: 1,
      explanation: "`kill <pid>` sends a signal to the process.",
    },
    {
      question: "What does `kill -9` do?",
      options: ["Sends SIGKILL forcefully", "Pauses process", "Restarts process", "Lists child processes"],
      correct: 0,
      explanation: "Signal 9 is SIGKILL and cannot be caught/ignored.",
    },
    {
      question: "Which command starts a job in background quickly?",
      options: ["command &", "bg command", "runbg command", "nohup is mandatory"],
      correct: 0,
      explanation: "Appending `&` runs command in the background.",
    },
    {
      question: "What does `jobs` show?",
      options: ["System services", "Background/foreground shell jobs", "Kernel threads only", "Cron logs"],
      correct: 1,
      explanation: "`jobs` lists shell-managed jobs.",
    },
    {
      question: "Which command brings latest background job to foreground?",
      options: ["fg", "bg", "front", "bring"],
      correct: 0,
      explanation: "`fg` resumes a job in foreground.",
    },
    {
      question: "Which tool schedules repetitive tasks in Linux?",
      options: ["cron / crontab", "systemctl top", "iptables", "apt timer"],
      correct: 0,
      explanation: "Use `crontab` entries for recurring scheduled tasks.",
    },
    {
      question: "What does `ps aux | grep nginx` help identify?",
      options: ["Disk partitions", "Running nginx-related processes", "Open ports only", "File ownership"],
      correct: 1,
      explanation: "It filters process list for nginx strings.",
    },
    {
      question: "Which command can display service status on systemd systems?",
      options: ["systemctl status nginx", "servicecat nginx", "procctl nginx", "daemon list nginx"],
      correct: 0,
      explanation: "`systemctl status <service>` shows current service state.",
    },
  ],
  Git: [
    {
      question: "Which command initializes a new Git repository?",
      options: ["git start", "git init", "git new", "git create"],
      correct: 1,
      explanation: "`git init` creates a new repository in current directory.",
    },
    {
      question: "Which command shows staged/unstaged changes?",
      options: ["git status", "git show", "git branch", "git pull"],
      correct: 0,
      explanation: "`git status` displays working tree and staging state.",
    },
    {
      question: "How do you stage all modified/deleted tracked files?",
      options: ["git add -A", "git stage all", "git commit -a always", "git push -A"],
      correct: 0,
      explanation: "`git add -A` stages changes across the repo.",
    },
    {
      question: "Which command creates a commit with a message?",
      options: ["git save -m", "git commit -m \"msg\"", "git push -m", "git snap \"msg\""],
      correct: 1,
      explanation: "`git commit -m` stores staged snapshot in history.",
    },
    {
      question: "Which command downloads and merges remote changes?",
      options: ["git fetch", "git pull", "git push", "git clone"],
      correct: 1,
      explanation: "`git pull` is roughly fetch + merge/rebase (config dependent).",
    },
    {
      question: "Which command shows commit history?",
      options: ["git log", "git timeline", "git history", "git records"],
      correct: 0,
      explanation: "`git log` prints commits in reverse chronological order.",
    },
    {
      question: "How do you create and switch to a new branch named `feature`?",
      options: ["git branch feature && git branch feature", "git checkout feature", "git checkout -b feature", "git new-branch feature"],
      correct: 2,
      explanation: "`git checkout -b feature` creates and switches in one step.",
    },
    {
      question: "Which command uploads local commits to remote?",
      options: ["git pull", "git push", "git merge", "git clone"],
      correct: 1,
      explanation: "`git push` sends commits to remote branch.",
    },
    {
      question: "Which command compares working tree changes?",
      options: ["git show", "git diff", "git branch", "git remote"],
      correct: 1,
      explanation: "`git diff` shows line-level differences.",
    },
    {
      question: "Which command removes a tracked file from Git and working tree?",
      options: ["git del file", "git rm file", "git remove file", "git clean file"],
      correct: 1,
      explanation: "`git rm` schedules file removal in next commit.",
    },
  ],
  "Package Management": [
    {
      question: "Which command refreshes apt package index?",
      options: ["apt refresh", "apt update", "apt upgrade", "apt list --new"],
      correct: 1,
      explanation: "`apt update` updates metadata from repositories.",
    },
    {
      question: "Which command installs a package named `htop`?",
      options: ["apt get htop", "apt install htop", "apt add htop", "apt upgrade htop"],
      correct: 1,
      explanation: "`apt install <pkg>` installs package and dependencies.",
    },
    {
      question: "Which command removes a package but keeps config files?",
      options: ["apt remove package", "apt purge package", "apt clean package", "apt erase package"],
      correct: 0,
      explanation: "`apt remove` keeps config files, unlike `apt purge`.",
    },
    {
      question: "What does `apt upgrade` do?",
      options: ["Removes old kernels only", "Upgrades installed packages to newest versions", "Downgrades packages", "Rebuilds package cache from source"],
      correct: 1,
      explanation: "`apt upgrade` upgrades currently installed packages.",
    },
    {
      question: "Which command searches package metadata quickly?",
      options: ["apt search <term>", "apt whereis <term>", "apt findpkg <term> only in cache", "apt scan <term>"],
      correct: 0,
      explanation: "`apt search` searches package names/descriptions.",
    },
    {
      question: "Which command removes downloaded `.deb` cache files?",
      options: ["apt autoremove", "apt clean", "apt clear", "apt prune-cache"],
      correct: 1,
      explanation: "`apt clean` clears local repository of retrieved package files.",
    },
    {
      question: "What is `apt autoremove` used for?",
      options: ["Remove unused dependency packages", "Upgrade kernel only", "Reinstall all packages", "Fix broken packages automatically always"],
      correct: 0,
      explanation: "`apt autoremove` removes orphaned dependencies.",
    },
    {
      question: "Which command lists all upgradable packages?",
      options: ["apt list --upgradable", "apt upgrade --dry-run always", "apt check updates", "apt show upgrades"],
      correct: 0,
      explanation: "`apt list --upgradable` prints packages with available updates.",
    },
    {
      question: "What does `dpkg -l` generally display?",
      options: ["Network interfaces", "Installed Debian packages", "Active services", "System users"],
      correct: 1,
      explanation: "`dpkg -l` lists packages known to dpkg.",
    },
    {
      question: "Which command usually fixes dependency issues after interrupted installs?",
      options: ["apt --fix-broken install", "apt rescue install", "apt restart dependencies", "apt force-upgrade"],
      correct: 0,
      explanation: "`apt --fix-broken install` attempts dependency repair.",
    },
  ],
};
