export function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(" ");
}

export function riskBadgeClass(risk: string): string {
  const r = risk.toLowerCase();
  if (r === "high") return "bg-red-500/20 text-red-400 border-red-500/40";
  if (r === "medium") return "bg-yellow-500/20 text-yellow-400 border-yellow-500/40";
  return "bg-green-500/20 text-green-400 border-green-500/40";
}

export function getHfHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const key = localStorage.getItem("hfApiKey") || "";
  const model = localStorage.getItem("hfModel") || "";
  const headers: Record<string, string> = {};
  if (key) headers["x-hf-api-key"] = key;
  if (model) headers["x-hf-model"] = model;
  return headers;
}

