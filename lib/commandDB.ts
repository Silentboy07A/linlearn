// Command pattern DB for fallback
export type CommandDB = {
  [pattern: string]: string;
};

export const commandDB: CommandDB = {
  // Examples (expand as needed)
  'grep': 'usage: grep [OPTION]... PATTERNS [FILE]...\nTry \u0027grep --help\u0027 for more information.',
  'awk': 'usage: awk [options] [\u0027program\u0027] [file ...]',
  'sed': 'usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\nTry \u0027sed --help\u0027 for more information.',
  'find': '/home/user:\nfile1.txt\nfile2.txt\nDocuments\nPictures',
  'chmod': '',
  'chown': '',
  'ps': '  PID TTY          TIME CMD\n 1234 pts/0    00:00:00 bash\n 2345 pts/0    00:00:00 ps',
  'kill': '',
  'curl': 'curl: try \'curl --help\' or \'curl --manual\' for more information',
  'ping': 'PING google.com (142.250.190.14) 56(84) bytes of data.\n64 bytes from 142.250.190.14: icmp_seq=1 ttl=115 time=12.3 ms',
  'git init': 'Initialized empty Git repository in /home/user/.git/',
  'git status': 'On branch master\n\nNo commits yet\n\nnothing to commit (create/copy files and use \'git add\' to track)',
  'git log': 'commit 1234567...\nAuthor: user <user@host>\nDate: ...',
  'git add': '',
  'git commit': '[master (root-commit) 1234567] Initial commit',
  'git push': 'Everything up-to-date',
  'git pull': 'Already up to date.',
  'git clone': 'Cloning into \'repo\'...\ndone.',
  'apt install': 'Reading package lists... Done\nBuilding dependency tree... Done\nThe following NEW packages will be installed: ...',
  'apt update': 'Hit:1 http://archive.ubuntu.com/ubuntu jammy InRelease\nReading package lists... Done',
  'apt upgrade': 'Reading package lists... Done\nBuilding dependency tree... Done\nCalculating upgrade... Done',
  'apt remove': 'Reading package lists... Done\nBuilding dependency tree... Done\nThe following packages will be REMOVED: ...',
  'tar': '',
  'zip': '',
  'unzip': '',
  'df': 'Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/sda1      102384128 1234567  96328456  2% /',
  'du': '',
  'top': 'top - 10:00:00 up 1 day,  1:23,  1 user,  load average: 0.00, 0.01, 0.05\nTasks: 100 total,   1 running,  99 sleeping,   0 stopped,   0 zombie',
  'env': 'USER=user\nHOME=/home/user\nSHELL=/bin/bash',
  'export': '',
  'alias': '',
  'man': '',
  'wget': '',
  'ssh': '',
  'scp': '',
  'vim': '',
  'nano': '',
  'python3': 'Python 3.10.12 (default, Jun  7 2023, 12:00:00) \n[GCC 11.4.0] on linux\nType \u0027help\u0027, \u0027copyright\u0027, \u0027credits\u0027 or \u0027license\u0027 for more information.',
  'node': 'Welcome to Node.js v18.16.0.\nType ".help" for more information.',
  'npm': 'Usage: npm <command>\nwhere <command> is one of: ...',
  'systemctl start': '',
  'systemctl stop': '',
  'systemctl status': '',
  'netstat': '',
  'ifconfig': 'eth0      Link encap:Ethernet  HWaddr 00:0c:29:68:22:1e\n          inet addr:192.168.1.100  Bcast:192.168.1.255  Mask:255.255.255.0',
  'ip addr': '',
  'crontab': '',
  'diff': '',
  'wc': '',
  'sort': '',
  'uniq': '',
  'head': '',
  'tail': '',
  'xargs': '',
  'tee': '',
  'su': '',
  'sudo': '',
  'passwd': '',
  'useradd': '',
  'usermod': '',
};

// Helper: match by prefix/keyword
export function getCommandDBOutput(cmd: string): string | undefined {
  for (const pattern in commandDB) {
    if (cmd === pattern || cmd.startsWith(pattern + ' ')) {
      return commandDB[pattern];
    }
  }
  return undefined;
}
