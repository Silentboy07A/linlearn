"use client";

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastType = "success" | "warning" | "info";

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

const toneStyles: Record<ToastType, string> = {
  success: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
  warning: "border-amber-500/40 bg-amber-500/15 text-amber-100",
  info: "border-white/20 bg-black/40 text-gray-100",
};

function iconFor(type: ToastType) {
  if (type === "success") return <CheckCircle2 className="h-4 w-4 shrink-0" />;
  if (type === "warning") return <AlertCircle className="h-4 w-4 shrink-0" />;
  return <Info className="h-4 w-4 shrink-0" />;
}

export function ToastStack({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] space-y-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: -10, x: 12 }}
            animate={{ opacity: 1, y: 0, x: 0 }}
            exit={{ opacity: 0, y: -6, x: 18 }}
            transition={{ duration: 0.18 }}
            className={cn(
              "flex max-w-sm items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-xl backdrop-blur",
              toneStyles[toast.type]
            )}
          >
            {iconFor(toast.type)}
            <p>{toast.message}</p>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
