/**
 * motion.ts — Shared Framer Motion variant presets.
 * Import these instead of defining inline animation objects in components.
 * This ensures visual consistency and a single place to tune global timing.
 */

import type { Variants, Transition } from "framer-motion";

// ─── Base Transitions ────────────────────────────────────────────────────────

export const EASE_OUT_EXPO  = [0.16, 1, 0.3, 1]   as const;
export const EASE_SPRING    = [0.34, 1.56, 0.64, 1] as const;
export const EASE_IN_OUT    = [0.87, 0, 0.13, 1]   as const;

export const T_FAST:   Transition = { duration: 0.15, ease: EASE_OUT_EXPO };
export const T_NORMAL: Transition = { duration: 0.28, ease: EASE_OUT_EXPO };
export const T_SLOW:   Transition = { duration: 0.42, ease: EASE_OUT_EXPO };
export const T_SPRING: Transition = { type: "spring", stiffness: 380, damping: 30, mass: 0.8 };

// ─── Page & Route Transitions ────────────────────────────────────────────────

export const PAGE: Variants = {
  initial:  { opacity: 0, y: 8  },
  animate:  { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE_OUT_EXPO } },
  exit:     { opacity: 0, y: -6, transition: { duration: 0.20, ease: "easeIn" } },
};

// ─── Card / Container Variants ───────────────────────────────────────────────

export const CARD: Variants = {
  initial:  { opacity: 0, y: 10 },
  animate:  { opacity: 1, y: 0,  transition: T_NORMAL },
  exit:     { opacity: 0, y: 6,  transition: T_FAST   },
};

export const CARD_HOVER = {
  initial: { scale: 1,    y: 0  },
  hover:   { scale: 1.005, y: -1, transition: { duration: 0.18, ease: EASE_OUT_EXPO } },
};

// ─── Stagger List Container + Item ───────────────────────────────────────────

export const STAGGER_CONTAINER: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.055, delayChildren: 0.08 } },
};

export const STAGGER_ITEM: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0,  transition: { duration: 0.30, ease: EASE_OUT_EXPO } },
};

/** Faster stagger for dense lists (e.g. sidebar nav) */
export const STAGGER_CONTAINER_FAST: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.035, delayChildren: 0.05 } },
};

// ─── Modal ───────────────────────────────────────────────────────────────────

export const MODAL_OVERLAY: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.20, ease: "easeOut" } },
  exit:    { opacity: 0, transition: { duration: 0.15, ease: "easeIn"  } },
};

export const MODAL_PANEL: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 10 },
  animate: { opacity: 1, scale: 1,    y: 0,  transition: { duration: 0.26, ease: EASE_OUT_EXPO } },
  exit:    { opacity: 0, scale: 0.97, y: 6,  transition: { duration: 0.18, ease: "easeIn" } },
};

// ─── Drawer / Sidebar (slide from left) ─────────────────────────────────────

export const DRAWER: Variants = {
  initial: { opacity: 0, x: -20 },
  animate: { opacity: 1, x: 0,   transition: { duration: 0.30, ease: EASE_OUT_EXPO } },
  exit:    { opacity: 0, x: -16, transition: { duration: 0.20, ease: "easeIn" } },
};

// ─── Toast (slide from right) ────────────────────────────────────────────────

export const TOAST: Variants = {
  initial: { opacity: 0, x: 48,  scale: 0.94 },
  animate: { opacity: 1, x: 0,   scale: 1,   transition: { duration: 0.24, ease: EASE_OUT_EXPO } },
  exit:    { opacity: 0, x: 48,  scale: 0.96, transition: { duration: 0.18, ease: "easeIn" } },
};

// ─── Dropdown / Popover ──────────────────────────────────────────────────────

export const DROPDOWN: Variants = {
  initial: { opacity: 0, scale: 0.96, y: -4 },
  animate: { opacity: 1, scale: 1,    y: 0,  transition: { duration: 0.18, ease: EASE_OUT_EXPO } },
  exit:    { opacity: 0, scale: 0.97, y: -3, transition: { duration: 0.12, ease: "easeIn" } },
};

// ─── Fade helpers ────────────────────────────────────────────────────────────

export const FADE: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: T_NORMAL },
  exit:    { opacity: 0, transition: T_FAST   },
};

export const FADE_UP: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0,  transition: T_NORMAL },
  exit:    { opacity: 0, y: 8,  transition: T_FAST   },
};

// ─── Stat number counter ─────────────────────────────────────────────────────

export const STAT_VALUE: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT_EXPO } },
};

// ─── Boot overlay lines ──────────────────────────────────────────────────────

export const BOOT_LINE: Variants = {
  initial: { opacity: 0, x: -4 },
  animate: { opacity: 1, x: 0,  transition: { duration: 0.12, ease: "easeOut" } },
};

// ─── XP bar fill ─────────────────────────────────────────────────────────────

export const XP_BAR = (targetPercent: number) => ({
  initial:  { width: "0%" },
  animate:  { width: `${Math.min(targetPercent, 100)}%` },
  transition: { duration: 1.0, ease: EASE_OUT_EXPO, delay: 0.25 },
});
