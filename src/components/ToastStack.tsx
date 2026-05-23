"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle2,
  Info,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TOAST } from "@/lib/motion";

export type ToastType = "success" | "warning" | "info" | "xp";

export interface ToastItem {
  id:      string;
  message: string;
  type:    ToastType;
}

const TONE: Record<ToastType, {
  bar:   string;
  icon:  React.ReactNode;
  text:  string;
}> = {
  success: {
    bar:  "bg-terminal-500",
    icon: <CheckCircle2 className="h-4 w-4 text-terminal-400 shrink-0" />,
    text: "text-ink-primary",
  },
  warning: {
    bar:  "bg-amber-500",
    icon: <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />,
    text: "text-ink-primary",
  },
  info: {
    bar:  "bg-sky-500",
    icon: <Info className="h-4 w-4 text-sky-400 shrink-0" />,
    text: "text-ink-primary",
  },
  xp: {
    bar:  "bg-brand-500",
    icon: <Zap className="h-4 w-4 text-brand-400 shrink-0" />,
    text: "text-brand-300",
  },
};

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts:     ToastItem[];
  onDismiss?: (id: string) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed bottom-6 right-4 z-toast space-y-2 lg:top-4 lg:bottom-auto"
      aria-live="polite"
      aria-label="Notifications"
    >
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => {
          const tone = TONE[toast.type];
          return (
            <motion.div
              key={toast.id}
              layout
              variants={TOAST}
              initial="initial"
              animate="animate"
              exit="exit"
              className={cn(
                "pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] items-center gap-3",
                "rounded-xl border border-[var(--border-default)] bg-surface-04/95",
                "px-4 py-3 shadow-e3 backdrop-blur-xl"
              )}
              role="alert"
            >
              {/* Color bar */}
              <div className={cn("w-0.5 self-stretch rounded-full shrink-0", tone.bar)} />

              {/* Icon */}
              {tone.icon}

              {/* Message */}
              <p className={cn("flex-1 text-sm font-medium leading-tight", tone.text)}>
                {toast.message}
              </p>

              {/* Dismiss */}
              {onDismiss && (
                <button
                  type="button"
                  onClick={() => onDismiss(toast.id)}
                  className="btn-icon shrink-0 -mr-1"
                  aria-label="Dismiss notification"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
