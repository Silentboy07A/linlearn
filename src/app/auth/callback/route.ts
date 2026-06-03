import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const urlObj = new URL(request.url);
  const { searchParams, origin } = urlObj;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  console.log("[Auth Callback] Received request:", {
    url: request.url,
    origin,
    code: code ? `${code.slice(0, 8)}...` : null,
    next
  });

  if (code) {
    console.log("[Auth Callback] Attempting to exchange code for session...");
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      
      if (error) {
        console.error("[Auth Callback] Error exchanging code for session:", error);
      } else {
        console.log("[Auth Callback] Successfully exchanged code for session. User ID:", data.user?.id);
      }
    } catch (e) {
      console.error("[Auth Callback] Exception occurred during session exchange:", e);
    }
  } else {
    console.warn("[Auth Callback] No authorization code found in search parameters.");
  }

  const redirectUrl = `${origin}${next}`;
  console.log("[Auth Callback] Redirecting to destination:", redirectUrl);
  return NextResponse.redirect(redirectUrl);
}
