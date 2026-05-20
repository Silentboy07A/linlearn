"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { motion } from "framer-motion";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.95 }}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-gray-300 hover:border-[#E95420]/50 hover:text-[#E95420]"
    >
      {copied ? (
        <>
          <Check className="h-4 w-4 text-[#4CAF50]" />
          <span className="text-[#4CAF50]">Copied!</span>
        </>
      ) : (
        <>
          <Copy className="h-4 w-4" />
          {label}
        </>
      )}
    </motion.button>
  );
}
