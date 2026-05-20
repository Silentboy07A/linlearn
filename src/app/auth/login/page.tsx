"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Terminal } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const supabase = createClient();
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) setError(err.message);
    else router.push("/dashboard");
    setLoading(false);
  };

  const google = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#1a0a2e] p-4">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-white/5 p-8 backdrop-blur-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Terminal className="h-8 w-8 text-[#E95420]" />
          <span className="text-2xl font-bold text-[#E95420]">LinLearn</span>
        </div>
        <h1 className="mb-6 text-center text-xl font-semibold text-white">Sign in</h1>
        {error && <p className="mb-4 text-center text-sm text-red-400">{error}</p>}
        <form onSubmit={login} className="space-y-4">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-white"
          />
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-white"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[#E95420] py-3 font-medium text-white disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
        <button
          type="button"
          onClick={google}
          className="mt-4 w-full rounded-lg border border-white/10 py-3 text-sm text-gray-300 hover:bg-white/5"
        >
          Continue with Google
        </button>
        <p className="mt-6 text-center text-sm text-gray-400">
          No account?{" "}
          <Link href="/auth/signup" className="text-[#E95420] hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
