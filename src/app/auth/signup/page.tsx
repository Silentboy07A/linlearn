"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Terminal, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // Pre-fill email if redirected from login page
  useEffect(() => {
    const emailParam = searchParams.get("email");
    if (emailParam) setEmail(emailParam);
  }, [searchParams]);

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
      // If email confirmation is required, Supabase returns a user but no session
      if (data.session) {
        await supabase.from("profiles").update({ username }).eq("id", data.user.id);
        router.push("/dashboard");
      } else {
        // Email confirmation enabled — tell user to check inbox
        setSuccess(true);
      }
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

  const isAlreadyExists =
    error.toLowerCase().includes("already registered") ||
    error.toLowerCase().includes("already exists") ||
    error.toLowerCase().includes("user already");

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#1a0a2e] p-4">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-white/5 p-8 backdrop-blur-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Terminal className="h-8 w-8 text-[#E95420]" />
          <span className="text-2xl font-bold text-[#E95420]">LinLearn</span>
        </div>
        <h1 className="mb-6 text-center text-xl font-semibold text-white">Create account</h1>

        {/* Email confirmation success */}
        {success && (
          <div className="mb-4 rounded-lg border border-green-500/30 bg-green-950/40 p-4 text-center text-sm text-green-300">
            <p className="font-semibold">Check your inbox! 📬</p>
            <p className="mt-1 text-green-400/80">
              We sent a confirmation link to <span className="font-medium text-white">{email}</span>. Click it to activate your account.
            </p>
          </div>
        )}

        {/* Error message */}
        {error && !success && (
          <div className="mb-4 rounded-lg border border-red-500/20 bg-red-950/50 p-3 text-center text-sm text-red-300">
            <p>{isAlreadyExists ? "An account with this email already exists." : error}</p>
            {isAlreadyExists && (
              <Link
                href={`/auth/login?email=${encodeURIComponent(email)}`}
                className="mt-1 inline-block font-semibold text-[#E95420] underline underline-offset-2 hover:text-orange-400"
              >
                Sign in instead →
              </Link>
            )}
          </div>
        )}

        {!success && (
          <>
            <form onSubmit={signup} className="space-y-4">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-[#E95420]/60 focus:ring-1 focus:ring-[#E95420]/30"
              />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-[#E95420]/60 focus:ring-1 focus:ring-[#E95420]/30"
              />
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password (min 6 chars)"
                className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-white placeholder-gray-500 outline-none transition focus:border-[#E95420]/60 focus:ring-1 focus:ring-[#E95420]/30"
              />
              <button
                type="submit"
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#E95420] py-3 font-medium text-white transition hover:brightness-110 disabled:opacity-50"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {loading ? "Creating account..." : "Sign Up"}
              </button>
            </form>

            <div className="my-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-white/10" />
              <span className="text-xs text-gray-500">or</span>
              <div className="h-px flex-1 bg-white/10" />
            </div>

            <button
              type="button"
              onClick={google}
              className="w-full rounded-lg border border-white/10 py-3 text-sm text-gray-300 transition hover:bg-white/5 hover:border-white/20"
            >
              Continue with Google
            </button>
          </>
        )}

        <p className="mt-6 text-center text-sm text-gray-400">
          Have an account?{" "}
          <Link href="/auth/login" className="font-medium text-[#E95420] hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
