"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Terminal, Loader2, Eye, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log("[Login] Form submitted:", { email, passwordLength: password.length });
    setLoading(true);
    setError("");
    setConfirmationSent(false);

    try {
      const supabase = createClient();

      // Step 1: Try to sign in
      console.log("[Login] Attempting sign-in with password for:", email);
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });

      if (signInErr) {
        console.warn("[Login] Sign-in failed error:", signInErr);
        if (signInErr.message === "Invalid login credentials") {
          // Step 2: Account doesn't exist — auto-create it
          console.log("[Login] Account not found or credentials invalid. Attempting auto-registration signup for:", email);
          const signUpPayload = {
            email,
            password,
            options: { data: { username: email.split("@")[0] } },
          };
          const { data, error: signUpErr } = await supabase.auth.signUp(signUpPayload);
          console.log("[Login] Auto-registration signup response received:", { data, error: signUpErr });

          if (signUpErr) {
            console.error("[Login] Auto-registration signup error:", signUpErr);
            setError(signUpErr.message);
          } else {
            if (data.session) {
              console.log("[Login] Auto-registration succeeded and session started. Redirecting to dashboard.");
              router.push("/dashboard");
              router.refresh();
              return;
            } else {
              console.log("[Login] Auto-registration succeeded. Email confirmation required.");
              setConfirmationSent(true);
            }
          }
        } else {
          setError(signInErr.message);
        }
      } else {
        // Sign-in succeeded
        console.log("[Login] Sign-in succeeded. Redirecting to dashboard.");
        router.push("/dashboard");
        router.refresh();
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "An unexpected error occurred during sign in.";
      console.error("[Login] Unhandled exception occurred:", e);
      setError(errMsg);
    } finally {
      setLoading(false);
    }
  };


  const google = async () => {
    setError("");
    try {
      const supabase = createClient();
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "An unexpected error occurred with Google Sign In.");
    }
  };


  return (
    <div className="flex min-h-screen items-center justify-center bg-[#1a0a2e] p-4">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-white/5 p-8 backdrop-blur-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Terminal className="h-8 w-8 text-[#E95420]" />
          <span className="text-2xl font-bold text-[#E95420]">LinLearn</span>
        </div>
        <h1 className="mb-6 text-center text-xl font-semibold text-white">Sign in</h1>

        {/* Email confirmation message */}
        {confirmationSent && (
          <div className="mb-4 rounded-lg border border-green-500/30 bg-green-950/40 p-4 text-center text-sm text-green-300">
            <p className="font-semibold">Account created! Check your inbox 📬</p>
            <p className="mt-1 text-green-400/80">
              We sent a confirmation link to <span className="font-medium text-white">{email}</span>. Click it, then come back and sign in.
            </p>
          </div>
        )}

        {/* Error message */}
        {error && !confirmationSent && (
          <div className="mb-4 rounded-lg bg-red-950/50 p-3 text-center text-sm text-red-200 border border-red-500/20">
            {error}
          </div>
        )}

        {!confirmationSent && (
          <>
            <form onSubmit={login} className="space-y-4">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#E95420]"
              />
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password (min 6 chars)"
                  className="w-full rounded-lg border border-white/10 bg-black/30 pl-4 pr-12 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#E95420]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition-colors"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#E95420] py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {loading ? "Please wait..." : "Sign In"}
              </button>
            </form>
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-white/10"></div>
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-[#1a0a2e] px-2 text-gray-400">Or continue with</span>
              </div>
            </div>
            <button
              type="button"
              onClick={google}
              className="w-full rounded-lg border border-white/10 py-3 text-sm text-gray-300 transition-colors hover:bg-white/10"
            >
              Google
            </button>
          </>
        )}

        <p className="mt-6 text-center text-sm text-gray-400">
          No account?{" "}
          <Link href="/auth/signup" className="text-[#E95420] hover:underline font-medium">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
