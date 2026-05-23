"use client";

import { Loader2 } from "lucide-react";
import { Terminal } from "lucide-react";
import { motion } from "framer-motion";

interface LoadingSpinnerProps {
  label?: string;
  /** "inline" = small spinner row; "page" = full-page centered loader */
  variant?: "inline" | "page";
}

export function LoadingSpinner({
  label = "Loading…",
  variant = "inline",
}: LoadingSpinnerProps) {
  if (variant === "page") {
    return (
      <div className="fixed inset-0 z-modal flex flex-col items-center justify-center gap-5 bg-surface-base">
        {/* Logo mark */}
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500 shadow-glow-brand"
        >
          <Terminal className="h-6 w-6 text-white" />
        </motion.div>

        {/* Spinner + label */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col items-center gap-3"
        >
          {/* Progress bar */}
          <div className="h-0.5 w-36 overflow-hidden rounded-full bg-white/8">
            <div className="h-full w-full origin-left animate-[boot-progress_1.8s_ease-in-out_infinite] bg-gradient-to-r from-brand-600 via-brand-400 to-terminal-500" />
          </div>
          <p className="font-mono text-xs text-ink-tertiary">{label}</p>
        </motion.div>
      </div>
    );
  }

  // Inline variant
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-ink-tertiary">
      <Loader2 className="h-6 w-6 animate-spin text-brand-500" />
      <p className="text-sm">{label}</p>
    </div>
  );
}
