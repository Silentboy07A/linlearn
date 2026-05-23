export interface BKTParameters {
  pL0: number; // Prior knowledge probability
  pT: number;  // Transition probability (learning rate)
  pG: number;  // Guess probability (success without mastery)
  pS: number;  // Slip probability (error despite mastery)
}

export type LinuxTopic = "navigation" | "files" | "permissions" | "networking" | "processes" | "packages";

// Default parameters based on empirical Intelligent Tutoring System benchmarks
export const DEFAULT_BKT_PARAMS: Record<LinuxTopic, BKTParameters> = {
  navigation: { pL0: 0.30, pT: 0.15, pG: 0.25, pS: 0.10 },
  files:      { pL0: 0.20, pT: 0.12, pG: 0.20, pS: 0.12 },
  permissions:{ pL0: 0.10, pT: 0.08, pG: 0.15, pS: 0.15 },
  networking: { pL0: 0.05, pT: 0.06, pG: 0.10, pS: 0.18 },
  processes:  { pL0: 0.08, pT: 0.07, pG: 0.12, pS: 0.15 },
  packages:   { pL0: 0.15, pT: 0.10, pG: 0.20, pS: 0.10 },
};

/**
 * Calculates updated mastery probability using Bayesian update equations
 * @param pLCurrent Current mastery probability P(L_{t-1})
 * @param correct Whether the student response was correct
 * @param topic The topic category being evaluated
 */
export function updateMastery(
  pLCurrent: number,
  correct: boolean,
  topic: LinuxTopic
): number {
  const params = DEFAULT_BKT_PARAMS[topic];
  const { pS, pG, pT } = params;

  // 1. Calculate posterior probability of knowledge given response
  let pLPosterior = 0;
  if (correct) {
    const numerator = pLCurrent * (1 - pS);
    const denominator = (pLCurrent * (1 - pS)) + ((1 - pLCurrent) * pG);
    pLPosterior = numerator / (denominator || 1);
  } else {
    const numerator = pLCurrent * pS;
    const denominator = (pLCurrent * pS) + ((1 - pLCurrent) * (1 - pG));
    pLPosterior = numerator / (denominator || 1);
  }

  // 2. Account for transition (learning/acquisition step)
  let pLNext = pLPosterior + (1 - pLPosterior) * pT;

  // Educational sanity constraint: mastery must not increase on incorrect responses
  if (!correct && pLNext > pLCurrent) {
    pLNext = pLCurrent * 0.95; // decrease by 5% as penalty
  }

  // Bound to prevent rounding escapes
  return Math.max(0.001, Math.min(0.999, pLNext));
}

/**
 * Maps mastery scores to recommended mission difficulty selection thresholds.
 */
export function getRecommendedDifficulty(masteryScore: number): "Beginner" | "Intermediate" | "Advanced" {
  if (masteryScore >= 0.80) return "Advanced";
  if (masteryScore >= 0.40) return "Intermediate";
  return "Beginner";
}
