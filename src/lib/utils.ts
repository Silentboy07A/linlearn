export function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(" ");
}

export function riskBadgeClass(risk: string): string {
  const r = risk.toLowerCase();
  if (r === "high") return "bg-red-500/20 text-red-400 border-red-500/40";
  if (r === "medium") return "bg-yellow-500/20 text-yellow-400 border-yellow-500/40";
  return "bg-green-500/20 text-green-400 border-green-500/40";
}
