import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function requireUser() {
  const supabase = createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  console.log("[requireUser] Checking user session:", {
    hasUser: !!user,
    userId: user?.id,
    userEmail: user?.email,
    error: error?.message || null
  });

  if (error || !user) {
    console.warn("[requireUser] Authentication failed or session is missing. Returning 401 Unauthorized.");
    return {
      user: null,
      supabase: null,
      error: NextResponse.json({ error: "Unauthorized access" }, { status: 401 }),
    };
  }

  try {
    // Ensure profile exists in database
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile) {
      console.log("[requireUser] Database profile not found. Initializing profile for user:", user.id);
      const username = user.user_metadata?.username || user.email?.split("@")[0] || "hacker";
      const avatarUrl = user.user_metadata?.avatar_url || null;
      const { data: insertProfile, error: profileErr } = await supabase.from("profiles").insert({
        id: user.id,
        username,
        avatar_url: avatarUrl,
      }).select().single();
      console.log("[requireUser] Profile initialization database response:", { insertProfile, error: profileErr });
    }

    // Ensure progress exists in database
    const { data: progress } = await supabase
      .from("progress")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!progress) {
      console.log("[requireUser] Database progress tracking not found. Initializing progress for user:", user.id);
      const { data: insertProgress, error: progressErr } = await supabase.from("progress").insert({
        user_id: user.id,
        xp: 0,
        streak: 0,
        level: "Beginner",
      }).select().single();
      console.log("[requireUser] Progress initialization database response:", { insertProgress, error: progressErr });
    }
  } catch (e) {
    console.error("[requireUser] Failed to initialize user database profile or progress:", e);
  }

  return { user, supabase, error: null };
}
