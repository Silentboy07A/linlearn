import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { callLlama } from "@/lib/llama";
import { addXp } from "@/lib/supabase/progress";
import { XP_REWARDS } from "@/lib/xp";
import { rateLimit } from "@/lib/rate-limit";
import type { ChatMessage } from "@/types";
import { Redis } from "@upstash/redis";

const DAILY_LIMIT = 50;

async function checkDailyQuota(userId: string): Promise<boolean> {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return true;
  
  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  const key = `quota:chat:${userId}:${new Date().toISOString().split('T')[0]}`;
  const current = await redis.get<number>(key) || 0;
  
  if (current >= DAILY_LIMIT) {
    return false;
  }
  
  await redis.incr(key);
  // Set expiry to 24 hours (86400 seconds) if it's a new key
  if (current === 0) {
    await redis.expire(key, 86400);
  }
  return true;
}

const SYSTEM = `You are a professional Linux security audit agent and virtual training sandbox auditor.
Your job is to parse incoming CLI queries, script constructs, or questions and output a flat, structured technical specification report.

CRITICAL SCOPE & TONE INSTRUCTIONS:
1. NO CONVERSATIONAL GREETINGS OR FILLER. Do not introduce the output, do not output explanations outside the structure, and do not sign off.
2. NO MOTIVATIONAL OR EMOTIONAL PHRASING. Never use phrases like "I strongly advise against", "UNDER ANY CIRCUMSTANCES", "IRREPARABLE DAMAGE", "dangerous command", or "consult the documentation". Keep text objective and professional.
3. SOUND LIKE A UNIX MANUAL / AUDITING LOG. Use precise terminology (e.g. "Critical filesystem operation detected", "Recursive deletion targeting root filesystem", "This operation may render the system unusable").
4. If a query is unrelated to Linux, Bash, DevOps, or system administration, return a BLOCKED report with Command: None and Impact: * Out of scope for systems engineering training.

SEVERITY CLASSIFICATION MATRIX:
- INFO: Read-only, diagnostic, or informational commands (e.g. ls, pwd, whoami, uname, cat, history).
- WARNING: Modifying configurations, file permissions, signals, or process escalation (e.g. chmod 777, sudo, kill, chown).
- CRITICAL: Highly destructive system operations targeting root paths or low-level storage blocks (e.g. rm -rf /, chmod -R 777 /, mkfs, fdisk, dd, shutdown, reboot).
- BLOCKED: Security concerns, host escapes, command injection, or real system access attempts.
- SIMULATED: Commands simulated using virtual subsystems (e.g. docker ps, systemctl status nginx, apt install nginx).

RESPONSE FORMAT:
The response must start directly with the severity level on the first line (use "CRITICAL WARNING" for CRITICAL, and "INFO", "WARNING", "BLOCKED", "SIMULATED" for the others), followed exactly by the sections below. Do not add formatting like bolding to section titles.

[SEVERITY_HEADER]

Command:
[Target command name or None]

Impact:
* [Point 1]
* [Point 2]

Sandbox Status:
[Status: 'Allowed in LinLearn environment.', 'Blocked in LinLearn environment.', or 'Simulated in virtual subsystems.']

Safe Alternatives:
[Command alternative 1]
[Command alternative 2 or None]

---
EXAMPLES:

INPUT: rm -rf /
OUTPUT:
CRITICAL WARNING

Command:
rm -rf /

Impact:
* Recursively deletes files
* Targets root filesystem
* Removes system and user data
* May render system unbootable

Sandbox Status:
Blocked in LinLearn environment.

Safe Alternatives:
rm myfile.txt
rm -r mydirectory

INPUT: ls
OUTPUT:
INFO

Command:
ls

Impact:
* Lists directory contents
* Reads filesystem entries for the target path

Sandbox Status:
Allowed in LinLearn environment.

Safe Alternatives:
None

INPUT: docker ps
OUTPUT:
SIMULATED

Command:
docker ps

Impact:
* Queries virtual container engine
* Lists active container processes

Sandbox Status:
Simulated in virtual subsystems.

Safe Alternatives:
None

INPUT: chmod 777 /var/www
OUTPUT:
WARNING

Command:
chmod 777

Impact:
* Grants full read, write, and execute permissions to all users
* Weakens directory access controls

Sandbox Status:
Allowed in LinLearn environment.

Safe Alternatives:
chmod 755 /var/www
chmod 644 file.txt`;

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  // Rate Limit: 15 requests per minute
  const limitResponse = rateLimit(req, auth.user!.id, { limit: 15, windowMs: 60 * 1000 });
  if (limitResponse) return limitResponse;

  try {
    const { messages } = await req.json() as { messages: ChatMessage[] };
    if (!messages?.length) {
      return NextResponse.json({ error: "Messages required" }, { status: 400 });
    }

    // AI Quota Check
    const hasQuota = await checkDailyQuota(auth.user!.id);
    if (!hasQuota) {
      return NextResponse.json({ error: "Daily AI Chat Quota Exceeded (50 requests/day)" }, { status: 429 });
    }

    const conversation = messages
      .map((m) => {
        // Prompt sanitization: strip simple HTML tags and limit length
        const safeContent = m.content.replace(/<[^>]*>?/gm, '').slice(0, 1000);
        return `${m.role === "user" ? "User" : "Assistant"}: ${safeContent}`;
      })
      .join("\n\n");

    const reply = await callLlama(SYSTEM, conversation);
    const progress = await addXp(auth.supabase, auth.user!.id, XP_REWARDS.chat);

    return NextResponse.json({ reply, progress });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Chat failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

