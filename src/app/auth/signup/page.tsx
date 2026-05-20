"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Terminal } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const signup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const supabase = createClient();
    const { data, error: err } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { username } },
    });
    if (err) {
      setError(err.message);
    } else if (data.user) {
      await supabase.from("profiles").update({ username }).eq("id", data.user.id);
      router.push("/dashboard");
    }
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
        <h1 className="mb-6 text-center text-xl font-semibold text-white">Create account</h1>
        {error && <p className="mb-4 text-center text-sm text-red-400">{error}</p>}
        <form onSubmit={signup} className="space-y-4">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-white"
          />
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
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (min 6 chars)"
            className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-white"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[#E95420] py-3 font-medium text-white disabled:opacity-50"
          >
            {loading ? "Creating..." : "Sign Up"}
          </button>
        </form>
        <button
          type="button"
          onClick={google}
          className="mt-4 w-full rounded-lg border border-white/10 py-3 text-sm text-gray-300"
        >
          Continue with Google
        </button>
        <p className="mt-6 text-center text-sm text-gray-400">
          Have an account?{" "}
          <Link href="/auth/login" className="text-[#E95420] hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
