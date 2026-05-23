import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // ─── Brand Palette ──────────────────────────────────────────────────────
      colors: {
        brand: {
          50:  "#fff4f0",
          100: "#ffe0d4",
          200: "#ffbda4",
          300: "#ff8f6a",
          400: "#f97316",
          500: "#E95420",   // Ubuntu canonical orange — primary CTA
          600: "#cc4018",
          700: "#a82f10",
          800: "#8a270e",
          900: "#72230f",
          950: "#3e0d05",
          DEFAULT: "#E95420",
        },
        terminal: {
          50:  "#f0fdf4",
          100: "#dcfce7",
          200: "#bbf7d0",
          300: "#86efac",
          400: "#4ade80",
          500: "#4CAF50",   // Ubuntu canonical green — success / VM live
          600: "#16a34a",
          700: "#15803d",
          800: "#166534",
          900: "#14532d",
          950: "#052e16",
          DEFAULT: "#4CAF50",
        },
        // Deep purple-black surface stack
        surface: {
          base:    "#090614",
          "01":    "#0f0a1e",
          "02":    "#150e28",
          "03":    "#1c1232",
          "04":    "#231540",
          "05":    "#2b1a4d",
          overlay: "rgba(9,6,20,0.85)",
        },
        // Semantic text hierarchy
        ink: {
          primary:   "#f0eeff",
          secondary: "#9d94bb",
          tertiary:  "#635b80",
          muted:     "#3a3355",
          inverted:  "#090614",
        },
        // Border opacity steps (use with bg-border-*)
        border: {
          subtle:       "rgba(255,255,255,0.05)",
          DEFAULT:      "rgba(255,255,255,0.09)",
          strong:       "rgba(255,255,255,0.16)",
          brand:        "rgba(233,84,32,0.28)",
          "brand-strong":"rgba(233,84,32,0.48)",
          terminal:     "rgba(76,175,80,0.22)",
        },
        // Status semantic colors
        status: {
          success: "#4CAF50",
          warning: "#f59e0b",
          error:   "#f43f5e",
          info:    "#38bdf8",
        },
      },

      // ─── 4 pt / 8 pt Spacing Grid ───────────────────────────────────────────
      spacing: {
        px:    "1px",
        "0.5": "2px",
        "1":   "4px",
        "1.5": "6px",
        "2":   "8px",
        "2.5": "10px",
        "3":   "12px",
        "3.5": "14px",
        "4":   "16px",
        "5":   "20px",
        "6":   "24px",
        "7":   "28px",
        "8":   "32px",
        "9":   "36px",
        "10":  "40px",
        "11":  "44px",
        "12":  "48px",
        "14":  "56px",
        "16":  "64px",
        "18":  "72px",
        "20":  "80px",
        "24":  "96px",
        "28":  "112px",
        "32":  "128px",
        "36":  "144px",
        "40":  "160px",
        "48":  "192px",
        "56":  "224px",
        "64":  "256px",
        "72":  "288px",
        "80":  "320px",
        "96":  "384px",
      },

      // ─── Typography Scale ────────────────────────────────────────────────────
      fontSize: {
        "2xs": ["10px", { lineHeight: "14px", letterSpacing: "0.025em" }],
        xs:    ["11px", { lineHeight: "16px", letterSpacing: "0.015em" }],
        sm:    ["12px", { lineHeight: "18px", letterSpacing: "0.01em"  }],
        base:  ["13px", { lineHeight: "20px" }],
        md:    ["14px", { lineHeight: "22px" }],
        lg:    ["16px", { lineHeight: "24px" }],
        xl:    ["18px", { lineHeight: "28px", letterSpacing: "-0.01em" }],
        "2xl": ["22px", { lineHeight: "30px", letterSpacing: "-0.015em"}],
        "3xl": ["28px", { lineHeight: "36px", letterSpacing: "-0.02em" }],
        "4xl": ["34px", { lineHeight: "42px", letterSpacing: "-0.025em"}],
        "5xl": ["44px", { lineHeight: "52px", letterSpacing: "-0.03em" }],
        "6xl": ["56px", { lineHeight: "64px", letterSpacing: "-0.035em"}],
        // Terminal-specific — apply .font-mono class alongside these
        "t-xs": ["11px", { lineHeight: "18px" }],
        "t-sm": ["13px", { lineHeight: "20px" }],
        "t-md": ["14px", { lineHeight: "22px" }],
        "t-lg": ["16px", { lineHeight: "26px" }],
      },

      fontFamily: {
        sans:  ["var(--font-inter)", "Inter", "system-ui", "-apple-system", "sans-serif"],
        mono:  ["var(--font-mono)", "'JetBrains Mono'", "'Cascadia Code'", "'Fira Code'", "Consolas", "monospace"],
      },

      fontWeight: {
        thin:       "100",
        light:      "300",
        normal:     "400",
        medium:     "500",
        semibold:   "600",
        bold:       "700",
        extrabold:  "800",
      },

      // ─── Border Radius ───────────────────────────────────────────────────────
      borderRadius: {
        none:   "0",
        sm:     "3px",
        DEFAULT:"6px",
        md:     "8px",
        lg:     "10px",
        xl:     "12px",
        "2xl":  "16px",
        "3xl":  "20px",
        "4xl":  "28px",
        full:   "9999px",
        terminal: "10px",
      },

      // ─── Shadow / Elevation System ───────────────────────────────────────────
      boxShadow: {
        // Elevation layers
        "e1": "0 1px 2px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.25)",
        "e2": "0 2px 6px rgba(0,0,0,0.55), 0 4px 12px rgba(0,0,0,0.35)",
        "e3": "0 4px 14px rgba(0,0,0,0.65), 0 8px 28px rgba(0,0,0,0.45)",
        "e4": "0 8px 28px rgba(0,0,0,0.75), 0 16px 48px rgba(0,0,0,0.55)",
        // Glow system
        "glow-brand":     "0 0 16px rgba(233,84,32,0.18), 0 0 40px rgba(233,84,32,0.08)",
        "glow-brand-md":  "0 0 24px rgba(233,84,32,0.30), 0 0 64px rgba(233,84,32,0.14)",
        "glow-brand-lg":  "0 0 40px rgba(233,84,32,0.40), 0 0 80px rgba(233,84,32,0.20)",
        "glow-terminal":  "0 0 16px rgba(76,175,80,0.14), 0 0 40px rgba(76,175,80,0.06)",
        "glow-terminal-md":"0 0 28px rgba(76,175,80,0.24), 0 0 56px rgba(76,175,80,0.12)",
        "glow-info":      "0 0 16px rgba(56,189,248,0.16), 0 0 40px rgba(56,189,248,0.08)",
        // Interactive states
        "card-hover":     "0 4px 24px rgba(233,84,32,0.10), 0 0 0 1px rgba(233,84,32,0.22)",
        "inset-brand":    "inset 0 0 16px rgba(233,84,32,0.08)",
        "modal":          "0 24px 80px rgba(0,0,0,0.85), 0 0 0 1px rgba(255,255,255,0.06)",
      },

      // ─── Backdrop Blur ───────────────────────────────────────────────────────
      backdropBlur: {
        xs:  "4px",
        sm:  "8px",
        md:  "16px",
        lg:  "24px",
        xl:  "40px",
        "2xl":"64px",
      },

      // ─── Animation Timing System ─────────────────────────────────────────────
      transitionDuration: {
        instant: "50ms",
        fast:    "100ms",
        normal:  "175ms",
        slow:    "280ms",
        slower:  "450ms",
        crawl:   "700ms",
        boot:    "1100ms",
      },
      transitionTimingFunction: {
        "out-expo":  "cubic-bezier(0.16, 1, 0.3, 1)",
        "out-quart": "cubic-bezier(0.25, 1, 0.5, 1)",
        "in-expo":   "cubic-bezier(0.95, 0.05, 0.8, 0.04)",
        "in-out-expo":"cubic-bezier(0.87, 0, 0.13, 1)",
        "spring":    "cubic-bezier(0.34, 1.56, 0.64, 1)",
        "terminal":  "steps(1, end)",
      },

      // ─── Responsive Breakpoints ──────────────────────────────────────────────
      screens: {
        xs:    "390px",
        sm:    "640px",
        md:    "768px",
        lg:    "1024px",
        xl:    "1280px",
        "2xl": "1536px",
        "3xl": "1920px",
      },

      // ─── Z-Index Layers ──────────────────────────────────────────────────────
      zIndex: {
        hide:      "-1",
        base:      "0",
        raised:    "10",
        sticky:    "20",
        overlay:   "30",
        dropdown:  "40",
        modal:     "50",
        toast:     "60",
        tooltip:   "70",
        spotlight: "80",
        cursor:    "9999",
      },

      // ─── Keyframe Animations ─────────────────────────────────────────────────
      keyframes: {
        shimmer: {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "fade-up": {
          "0%":   { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "scale-in": {
          "0%":   { opacity: "0", transform: "scale(0.96)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "slide-left": {
          "0%":   { opacity: "0", transform: "translateX(-12px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "slide-right": {
          "0%":   { opacity: "0", transform: "translateX(12px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "pulse-glow-brand": {
          "0%, 100%": { boxShadow: "0 0 8px rgba(233,84,32,0.15)" },
          "50%":      { boxShadow: "0 0 24px rgba(233,84,32,0.45), 0 0 48px rgba(233,84,32,0.18)" },
        },
        "pulse-glow-terminal": {
          "0%, 100%": { boxShadow: "0 0 6px rgba(76,175,80,0.12)" },
          "50%":      { boxShadow: "0 0 20px rgba(76,175,80,0.38), 0 0 40px rgba(76,175,80,0.14)" },
        },
        "boot-scan": {
          "0%":   { transform: "translateY(-100%)", opacity: "0.8" },
          "100%": { transform: "translateY(110vh)",  opacity: "0" },
        },
        "xp-fill": {
          "0%":   { width: "0%" },
          "100%": { width: "var(--xp-target)" },
        },
        "cursor-blink": {
          "0%, 49%":  { opacity: "1" },
          "50%, 100%":{ opacity: "0" },
        },
        typewriter: {
          from: { width: "0" },
          to:   { width: "100%" },
        },
      },
      animation: {
        shimmer:              "shimmer 2.2s ease-in-out infinite",
        "fade-up":            "fade-up 0.35s cubic-bezier(0.16,1,0.3,1) both",
        "fade-in":            "fade-in 0.25s ease both",
        "scale-in":           "scale-in 0.25s cubic-bezier(0.16,1,0.3,1) both",
        "slide-left":         "slide-left 0.30s cubic-bezier(0.16,1,0.3,1) both",
        "slide-right":        "slide-right 0.30s cubic-bezier(0.16,1,0.3,1) both",
        "pulse-brand":        "pulse-glow-brand 2.4s ease-in-out infinite",
        "pulse-terminal":     "pulse-glow-terminal 2.4s ease-in-out infinite",
        "boot-scan":          "boot-scan 3s linear infinite",
        "cursor-blink":       "cursor-blink 1.1s ease-in-out infinite",
        typewriter:           "typewriter 1.2s steps(40) both",
      },
    },
  },
  plugins: [],
};

export default config;
