# LinLearn

Ubuntu-themed AI-powered Linux & DevOps learning platform.

## Stack

- Next.js 14 (App Router) + TypeScript + Tailwind CSS
- Supabase (Auth + PostgreSQL + RLS)
- Llama API (`https://api.llama.ai/v1/chat/completions`)
- Framer Motion, Lucide React, Recharts, jsPDF

## Setup

1. **Clone & install**
   ```bash
   npm install
   cp .env.local.example .env.local
   ```

2. **Supabase**
   - Create a project at [supabase.com](https://supabase.com)
   - Run `supabase/schema.sql` in the SQL Editor
   - Enable Google OAuth under Authentication → Providers (optional)
   - Add redirect URL: `http://localhost:3000/auth/callback`

3. **Environment** (`.env.local`)
   ```
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=
   LLAMA_API_KEY=
   ```

4. **Run**
   ```bash
   npm run dev
   ```

## Routes

| Route | Description |
|-------|-------------|
| `/` | Landing page |
| `/auth/login` | Email + Google sign in |
| `/auth/signup` | Create account |
| `/dashboard` | Protected app (all modules) |

## API Routes

- `POST /api/generate` — Linux commands
- `POST /api/script` — Bash scripts
- `POST /api/chat` — AI tutor
- `POST /api/quiz` — Generate quiz / save results
- `POST /api/interview` — Mock interviews
- `POST /api/error-explain` — Error analysis
- `POST /api/cheatsheet` — Cheat sheets
- `GET /api/dashboard` — Stats & history

## Deploy (Vercel)

1. Push to GitHub and import in Vercel
2. Add the same env variables
3. Set Supabase redirect URLs to your production domain

## Safety

LinLearn **never executes real shell commands**. All terminal output is educational and simulated.
