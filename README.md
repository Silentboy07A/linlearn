#  LinLearn

> An intelligent, AI-powered platform designed to help developers and students master Linux commands, shell scripting, and terminal environments.

LinLearn combines ultra-fast AI generation with interactive learning tools, offering mock interviews, cheat sheet generation, and intelligent error explanations. Built with a modern, secure, and highly scalable serverless architecture.

##  Features

-  AI Mock Interviews: Practice your Linux and DevOps skills with a conversational AI interviewer that provides real-time feedback.
-  Cheat Sheet Generator:Instantly generate custom, formatted cheat sheets for any Linux command or concept.
-  Command & Script Generator: Describe what you want to do in plain English, and get secure, optimized bash scripts or one-line commands.
-  Error Explainer: Paste confusing terminal errors and get plain-English explanations and step-by-step solutions.
-  Lightning Fast AI: Powered by Groq's LPU inference engine for near-instant AI responses.

##  Tech Stack

This project is built using a modern, production-ready stack:

- **Framework:** [Next.js 14](https://nextjs.org/) (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **Authentication & Database:** [Supabase](https://supabase.com/) (PostgreSQL + Row Level Security)
- **AI Inference:** [Groq](https://groq.com/) API (Llama models)
- **Rate Limiting & Quotas:** [Upstash Redis](https://upstash.com/)
- **Hosting:** [Vercel](https://vercel.com/) (Serverless & Edge)

##  Enterprise-Grade Security

LinLearn is built with security as a first-class citizen:

- **Edge Rate Limiting:** Global API rate limiting powered by Upstash Redis at the Edge, preventing DDoS and bot spam.
- **AI Token Quotas:** Strict daily quotas (e.g., 50 chat messages, 30 generations per user) implemented via token buckets to protect AI API keys from billing exhaustion.
- **Row Level Security (RLS):** Strict PostgreSQL policies ensure users can only access and modify their own learning data and history.
- **Prompt Sanitization:** Incoming prompts are stripped of malicious tags to prevent prompt injection attacks.
- **Secure Auth:** JWT-based sessions securely handled via `HttpOnly` cookies.

##  Getting Started

### Prerequisites

You will need accounts on the following platforms to run this project:
- [Supabase](https://supabase.com/) (Database & Auth)
- [Groq](https://console.groq.com/) (AI API Key)
- [Upstash](https://upstash.com/) (Serverless Redis for Rate Limiting)

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
   Create a `.env.local` file in the root directory and add your keys:
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
   Navigate to [http://localhost:3000](http://localhost:3000) to see the application in action.

## Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/Silentboy07A/linlearn/issues).

##  License

This project is licensed under the MIT License.
