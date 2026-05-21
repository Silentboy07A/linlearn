"use client";

import { useState, useEffect } from "react";
import { GlassCard } from "@/components/GlassCard";
import type { TerminalFontSize, TerminalPrefs, TerminalTheme } from "@/lib/session";

interface SettingsProps {
  username: string;
  prefs: TerminalPrefs;
  onUsernameChange: (value: string) => void;
  onThemeChange: (theme: TerminalTheme) => void;
  onFontSizeChange: (size: TerminalFontSize) => void;
  onShowTagsToggle: (value: boolean) => void;
  onResetXp: () => void;
  onResetStreak: () => void;
}

const themes: TerminalTheme[] = ["green", "amber", "cyan", "white"];
const fontSizes: TerminalFontSize[] = ["small", "medium", "large"];

export function Settings({
  username,
  prefs,
  onUsernameChange,
  onThemeChange,
  onFontSizeChange,
  onShowTagsToggle,
  onResetXp,
  onResetStreak,
}: SettingsProps) {
  const [draftName, setDraftName] = useState(username);
  const [confirmResetXp, setConfirmResetXp] = useState(false);
  
  // Hugging Face configuration local state
  const [draftHfKey, setDraftHfKey] = useState("");
  const [draftHfModel, setDraftHfModel] = useState("silentone1234/linlearn-phi3-linux-assistant");
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  useEffect(() => {
    const savedKey = localStorage.getItem("hfApiKey") || "";
    const savedModel = localStorage.getItem("hfModel") || "silentone1234/linlearn-phi3-linux-assistant";
    setDraftHfKey(savedKey);
    setDraftHfModel(savedModel);
  }, []);

  const showSaveStatus = (msg: string) => {
    setSaveStatus(msg);
    const timer = setTimeout(() => setSaveStatus(null), 2500);
    return () => clearTimeout(timer);
  };

  const saveHfSettings = () => {
    localStorage.setItem("hfApiKey", draftHfKey.trim());
    localStorage.setItem("hfModel", draftHfModel.trim());
    showSaveStatus("Hugging Face configuration saved!");
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">Settings</h2>
        {saveStatus && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 text-sm text-emerald-300 shadow-md">
            {saveStatus}
          </div>
        )}
      </div>

      <GlassCard className="space-y-3">
        <p className="text-sm text-gray-400">Display username</p>
        <input
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white placeholder:text-gray-500 focus:border-[#E95420]/40 focus:outline-none"
          placeholder="Enter display name"
        />
        <button
          type="button"
          onClick={() => {
            onUsernameChange(draftName.trim() || "User");
            showSaveStatus("Username updated!");
          }}
          className="micro-button rounded-lg bg-[#E95420] px-4 py-2 text-sm text-white"
        >
          Save Username
        </button>
      </GlassCard>

      <GlassCard className="space-y-3">
        <p className="text-sm text-gray-400">Hugging Face AI Configuration (Vercel Fix)</p>
        <p className="text-xs text-gray-500">
          Paste your Hugging Face Read Token below to fix the Llama AI features when running on live servers like Vercel.
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Hugging Face Access Token (API Key)</label>
            <input
              type="password"
              value={draftHfKey}
              onChange={(event) => setDraftHfKey(event.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white placeholder:text-gray-600 focus:border-[#E95420]/40 focus:outline-none text-sm font-mono"
              placeholder="hf_••••••••••••••••••••••••••••••••"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Hugging Face Model ID</label>
            <input
              type="text"
              value={draftHfModel}
              onChange={(event) => setDraftHfModel(event.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white placeholder:text-gray-500 focus:border-[#E95420]/40 focus:outline-none text-sm font-mono"
              placeholder="e.g. silentone1234/linlearn-phi3-linux-assistant"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={saveHfSettings}
          className="micro-button rounded-lg bg-[#E95420] px-4 py-2 text-sm text-white transition hover:bg-[#ff6b36]"
        >
          Save AI Configuration
        </button>
      </GlassCard>

      <GlassCard className="space-y-3">
        <p className="text-sm text-gray-400">Terminal color theme</p>
        <div className="flex flex-wrap gap-2">
          {themes.map((theme) => (
            <button
              key={theme}
              type="button"
              onClick={() => {
                onThemeChange(theme);
                showSaveStatus(`Theme updated to ${theme}!`);
              }}
              className={`micro-button rounded-full border px-4 py-1.5 text-sm capitalize ${
                prefs.theme === theme
                  ? "border-[#E95420]/60 bg-[#E95420]/15 text-[#E95420]"
                  : "border-white/10 text-gray-300"
              }`}
            >
              {theme}
            </button>
          ))}
        </div>
      </GlassCard>

      <GlassCard className="space-y-3">
        <p className="text-sm text-gray-400">Terminal font size</p>
        <div className="flex flex-wrap gap-2">
          {fontSizes.map((size) => (
            <button
              key={size}
              type="button"
              onClick={() => {
                onFontSizeChange(size);
                showSaveStatus(`Font size updated to ${size}!`);
              }}
              className={`micro-button rounded-full border px-4 py-1.5 text-sm capitalize ${
                prefs.fontSize === size
                  ? "border-[#E95420]/60 bg-[#E95420]/15 text-[#E95420]"
                  : "border-white/10 text-gray-300"
              }`}
            >
              {size}
            </button>
          ))}
        </div>
      </GlassCard>

      <GlassCard className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-gray-300">Show terminal source tags</p>
            <p className="text-xs text-gray-500">Display [AI], [DB], and [local] next to output lines.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              onShowTagsToggle(!prefs.showSourceTags);
              showSaveStatus(`Source tags turned ${!prefs.showSourceTags ? "ON" : "OFF"}!`);
            }}
            className={`micro-button rounded-full border px-3 py-1 text-xs ${
              prefs.showSourceTags
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                : "border-white/10 text-gray-300"
            }`}
          >
            {prefs.showSourceTags ? "ON" : "OFF"}
          </button>
        </div>
      </GlassCard>

      <GlassCard className="space-y-3">
        <p className="text-sm text-gray-400">Danger zone</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setConfirmResetXp(true)}
            className="micro-button rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-300"
          >
            Reset XP
          </button>
          <button
            type="button"
            onClick={() => {
              onResetStreak();
              showSaveStatus("Streak reset!");
            }}
            className="micro-button rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-200"
          >
            Reset Streak
          </button>
        </div>
      </GlassCard>

      {confirmResetXp && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-xl border border-white/15 bg-[#170a29] p-5 shadow-2xl">
            <h3 className="text-lg font-semibold text-white">Reset XP?</h3>
            <p className="mt-2 text-sm text-gray-400">This will reset XP back to 0 for this session.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmResetXp(false)}
                className="micro-button rounded-lg border border-white/15 px-4 py-2 text-sm text-gray-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  onResetXp();
                  setConfirmResetXp(false);
                  showSaveStatus("XP reset to 0!");
                }}
                className="micro-button rounded-lg bg-rose-500 px-4 py-2 text-sm text-white"
              >
                Confirm Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
