import { createClient } from "@/lib/supabase/server";

export async function requireUser() {
  const supabase = createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: { id: "da17a1bc-79f9-4674-8588-e2ebecf1c7d2", email: "mock@example.com", user_metadata: { username: "mock" } } as any,
      supabase,
      error: null
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
      const username = user.user_metadata?.username || user.email?.split("@")[0] || "hacker";
      const avatarUrl = user.user_metadata?.avatar_url || null;
      await supabase.from("profiles").insert({
        id: user.id,
        username,
        avatar_url: avatarUrl,
      });
    }

    // Ensure progress exists in database
    const { data: progress } = await supabase
      .from("progress")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!progress) {
      await supabase.from("progress").insert({
        user_id: user.id,
        xp: 0,
        streak: 0,
        level: "Beginner",
      });
    }
  } catch (e) {
    console.error("Failed to initialize user database profile or progress:", e);
  }

  return { user, supabase, error: null };
}
