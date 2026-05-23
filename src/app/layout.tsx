import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Load Inter with all useful subsets and display swap
const inter = Inter({
  subsets:          ["latin"],
  variable:         "--font-inter",
  display:          "swap",
  // Preload the weight range we actually use
  weight:           ["400", "500", "600", "700", "800"],
  fallback:         ["system-ui", "-apple-system", "sans-serif"],
  adjustFontFallback: true,
});

// JetBrains Mono for all terminal, code, and monospace surfaces
const jetbrainsMono = JetBrains_Mono({
  subsets:          ["latin"],
  variable:         "--font-mono",
  display:          "swap",
  weight:           ["400", "500", "600", "700"],
  fallback:         ["'Cascadia Code'", "'Fira Code'", "Consolas", "monospace"],
  adjustFontFallback: true,
});

// ── Default metadata (pages can override per-route) ────────────────────────
export const metadata: Metadata = {
  metadataBase:  new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://linlearn.app"),
  title: {
    template: "%s | LinLearn",
    default:  "LinLearn — Browser-Native Linux & DevOps Training",
  },
  description:
    "Master Linux and DevOps with a real x86 virtual machine running in your browser. " +
    "AI-powered missions, live terminal, quiz arena — no install required.",
  keywords:   ["Linux", "DevOps", "Ubuntu", "terminal", "WebAssembly", "v86", "learning"],
  authors:    [{ name: "LinLearn" }],
  robots:     "index, follow",
  openGraph: {
    type:     "website",
    title:    "LinLearn — Browser-Native Linux & DevOps Training",
    description: "Real Linux VM in your browser. AI-powered missions. No install required.",
  },
  twitter: {
    card:    "summary_large_image",
    title:   "LinLearn — Browser-Native Linux & DevOps Training",
    description: "Real Linux VM in your browser. AI-powered missions. No install required.",
  },
};

export const viewport = {
  themeColor: "#090614",
  width:      "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
        // Ensures body background matches surface-02 immediately on paint —
        // prevents flash of white background before CSS loads.
        style={{ background: "#150e28" }}
      >
        {children}
      </body>
    </html>
  );
}
