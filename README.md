# LinLearn

> An AI-powered learning platform designed to help developers and students master Linux commands, shell scripting, and terminal environments.

LinLearn combines ultra-fast AI generation with interactive learning tools, offering mock interviews, cheat sheet generation, and intelligent error explanations. The project is built on a modern, serverless architecture that is secure-by-default, scalable, and production-oriented.

---

## Features

- **AI Mock Interviews:** Practice Linux and DevOps skills with a conversational AI interviewer that provides real-time feedback.
- **Cheat Sheet Generator:** Instantly generate custom, formatted cheat sheets for any Linux command or concept.
- **Command & Script Generator:** Describe operations in plain English to receive secure, optimized bash scripts or one-line commands.
- **Error Explainer:** Paste confusing terminal errors to get plain-English explanations and step-by-step solutions.
- **Lightning Fast AI:** Powered by Groq's LPU inference engine for near-instant AI responses.

## Architecture Overview

LinLearn follows a standard serverless architecture designed for high availability and low latency. The frontend and backend logic are co-located in a Next.js App Router environment, deployed on Vercel's Edge Network. Data and state are managed by Supabase (PostgreSQL) and Upstash (Redis).

### Request Flow

```text
[ Client ] 
   │
   ▼
[ Next.js API Routes ] 
   │
   ▼
[ Auth Middleware ] 
   │
   ▼
[ Rate Limiter ] 
   │
   ▼
[ AI Quota Middleware ] 
   │
   ▼
[ Prompt Validation ] 
   │
   ▼
[ Groq API ] 
   │
   ▼
[ Response Processing ] 
   │
   ▼
[ Client ]
```

## Backend & Security

The platform is designed to be abuse-resistant and cloud-ready, with security enforced at the edge layer and database level:

- **Edge Rate Limiting:** Global API rate limiting powered by Upstash Redis prevents DDoS and bot spam.
- **AI Quota Management:** Strict daily quotas (e.g., 50 chat messages, 30 generations per user) implemented via token buckets protect downstream AI APIs from billing exhaustion.
- **Data Isolation:** Row Level Security (RLS) policies in PostgreSQL ensure users can only access and modify their own learning data.
- **Prompt Validation:** Incoming prompts are validated and sanitized to mitigate prompt injection risks and format abuse.
- **Secure Authentication:** JWT-based sessions are managed securely via `HttpOnly` cookies, preventing XSS-based token theft.

## Tech Stack

| Category | Technology | Purpose |
| :--- | :--- | :--- |
| **Framework** | [Next.js 14](https://nextjs.org/) | App Router, Server Components, API Routes |
| **Language** | [TypeScript](https://www.typescriptlang.org/) | End-to-end type safety |
| **Styling** | [Tailwind CSS](https://tailwindcss.com/) | Utility-first responsive design |
| **Database & Auth** | [Supabase](https://supabase.com/) | PostgreSQL, Auth, Row Level Security (RLS) |
| **AI Inference** | [Groq](https://groq.com/) | Ultra-low latency LLM inference |
| **Caching & Limits** | [Upstash Redis](https://upstash.com/) | Rate limiting, quota tracking |
| **Deployment** | [Vercel](https://vercel.com/) | Serverless edge hosting |

## Local Development Setup

### Prerequisites

You will need accounts on the following platforms:
- [Supabase](https://supabase.com/) for PostgreSQL and Auth
- [Groq](https://console.groq.com/) for the AI API Key
- [Upstash](https://upstash.com/) for Serverless Redis

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/Silentboy07A/linlearn.git
   cd linlearn
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up Environment Variables**
   Create a `.env.local` file in the root directory. Use `.env.example` as a template if available, or add the following keys:
   ```env
   # Supabase
   NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

   # Groq AI
   GROQ_API_KEY=your_groq_api_key

   # Upstash Redis (For Rate Limiting & Quotas)
   KV_REST_API_URL=your_upstash_rest_url
   KV_REST_API_TOKEN=your_upstash_rest_token
   ```

4. **Run the development server**
   ```bash
   npm run dev
   ```

5. **Open your browser**
   Navigate to [http://localhost:3000](http://localhost:3000) to view the application.

## Deployment

The application is optimized for deployment on Vercel. 
1. Connect your GitHub repository to Vercel.
2. Add the environment variables from your `.env.local` to the Vercel project settings.
3. Deploy! Vercel will automatically provision edge functions for your API routes and serve the frontend via its global CDN.

**Scalability Notes:** Because the application relies on serverless compute, edge Redis, and managed PostgreSQL, it is inherently designed to scale horizontally based on traffic demands without manual intervention.

## Roadmap & Future Improvements

- [ ] **Expanded Course Material:** Add structured interactive Linux modules.
- [x] **Advanced Sandbox:** Provide web-based terminal emulators for safe, sandboxed command execution.
- [ ] **Social Features:** Allow users to share generated scripts and cheat sheets.
- [ ] **Analytics Dashboard:** Visualize learning progress and weak points.
- [ ] **Automated CI/CD:** Add GitHub Actions for automated linting, testing, and deployment previews.

## Contributing

Contributions, issues, and feature requests are highly encouraged! 
Whether you're fixing a bug, improving the UI, or adding new learning modules, your help is appreciated. 
Please check the [issues page](https://github.com/Silentboy07A/linlearn/issues) to find a task or open a new one.

## License

This project is open-source and licensed under the [MIT License](LICENSE).
