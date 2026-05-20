"use client";

import { cn } from "@/lib/utils";

export function TerminalPrompt({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("font-mono text-sm", className)}>
      <span className="text-[#E95420]">user@linlearn</span>
      <span className="text-gray-500">:</span>
      <span className="text-[#4CAF50]">~$</span>{" "}
      {children}
    </div>
  );
}
