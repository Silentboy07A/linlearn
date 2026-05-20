"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { GlassCard } from "./GlassCard";
import type { Profile } from "@/types";

export function Settings({
  profile,
  onUpdate,
}: {
  profile: Profile | null;
  onUpdate: () => void;
}) {
  const [username, setUsername] = useState(profile?.username || "");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [showDelete, setShowDelete] = useState(false);

  const saveUsername = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("profiles").update({ username }).eq("id", user.id);
    setMessage("Username updated");
    onUpdate();
  };

  const changePassword = async () => {
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setMessage(error ? error.message : "Password updated");
    setPassword("");
  };

  const deleteAccount = async () => {
    setMessage("Contact support or delete via Supabase dashboard for full account removal.");
    setShowDelete(false);
  };

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h2 className="text-2xl font-bold text-white">Settings</h2>
      {message && <p className="text-[#4CAF50]">{message}</p>}
      <GlassCard>
        <label className="text-sm text-gray-400">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white"
        />
        <button
          type="button"
          onClick={saveUsername}
          className="mt-3 rounded-lg bg-[#E95420] px-4 py-2 text-sm text-white"
        >
          Save Username
        </button>
      </GlassCard>
      <GlassCard>
        <label className="text-sm text-gray-400">New Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white"
        />
        <button
          type="button"
          onClick={changePassword}
          className="mt-3 rounded-lg border border-white/10 px-4 py-2 text-sm"
        >
          Change Password
        </button>
      </GlassCard>
      <GlassCard>
        <button
          type="button"
          onClick={() => setShowDelete(true)}
          className="text-sm text-red-400 hover:underline"
        >
          Delete Account
        </button>
        {showDelete && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
            <p className="text-sm text-gray-300">This cannot be undone.</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={deleteAccount}
                className="rounded-lg bg-red-500 px-3 py-1 text-sm text-white"
              >
                Confirm Delete
              </button>
              <button type="button" onClick={() => setShowDelete(false)} className="text-sm">
                Cancel
              </button>
            </div>
          </div>
        )}
      </GlassCard>
    </div>
  );
}
