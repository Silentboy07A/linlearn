"use client";

import { Loader2 } from "lucide-react";

export function LoadingSpinner({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-gray-400">
      <Loader2 className="h-8 w-8 animate-spin text-[#E95420]" />
      <p className="text-sm">{label}</p>
    </div>
  );
}
