/**
 * Belief grading policy — the pure math that turns a set of signed evidence
 * contributions into a node's belief state.
 *
 * V2 (docs/belief-model-subjective-logic.md): Subjective Logic evidence
 * masses. Contributions (source credence × support, signed) are split BY SIGN
 * into two unsigned masses — r (for) and s (against) — and the credence is
 * the signed projection of the pair:
 *
 *   credence    = (r − s) / (r + s + W)     signed, open (−1, +1)
 *   uncertainty = W / (r + s + W)           unsigned, (0, 1]
 *
 * with W = BELIEF_PRIOR_MASS. The v1 exponential saturation
 * (e^(−C) − e^(−S), tuned by the accidental SATURATION_RATE) is REPLACED by
 * this model, not kept beside it — spec §7.
 */

// Neutral/torn anchor on the open signed credence scale. NOTE: an ungraded
// node (no counted evidence at the service layer) stays NULL — it is never 0;
// 0 means graded-and-balanced (or the vacuous opinion), not ungraded.
export const NEUTRAL_BELIEF_CREDENCE = 0;

// W of spec §2: the non-informative prior mass of the Beta/Subjective Logic
// correspondence — two virtual observations, one each way. This is the
// principled tuning knob that replaces SATURATION_RATE: raising it demands
// more evidence before credence commits.
export const BELIEF_PRIOR_MASS = 2;

// One evidence edge's signed input to the grading formula.
export interface BeliefEvidenceContribution {
  // Edge the contribution came from, so callers can trace results back.
  edgeId: number;
  // The source node's own credence × the edge's unsigned support; negative
  // exactly when the source's credence is negative, because credence is the
  // only signed term in the product.
  signedContribution: number;
}

// The two unsigned evidence masses one accumulation pass produces: r (for)
// and s (against) — the primary belief state of spec §2.
export interface BeliefEvidenceMasses {
  // Accumulated evidence mass FOR the node (r): the sum of the positive
  // contributions.
  beliefEvidenceForMass: number;
  // Accumulated evidence mass AGAINST the node (s): the summed magnitudes of
  // the negative contributions.
  beliefEvidenceAgainstMass: number;
}

// Contract for a belief grading policy version.
export interface BeliefGradingPolicy {
  // Reduce a node's evidence contributions to one credence in the open
  // interval (−1, +1).
  gradeBelief(contributions: BeliefEvidenceContribution[]): number;
}

// Split a contribution list by sign into the two unsigned masses (spec §2):
// contribution ≥ 0 adds to the for mass, contribution < 0 adds its magnitude
// to the against mass. The masses are unsigned — the sign lives only on the
// contribution (i.e. on the source's credence). An empty list (or all-zero
// contributions) accumulates to (0, 0), the vacuous opinion.
export function accumulateBeliefEvidenceMasses(
  contributions: BeliefEvidenceContribution[]
): BeliefEvidenceMasses {
  // Running total of evidence mass for the node (r).
  let beliefEvidenceForMass = 0;
  // Running total of evidence mass against the node (s), kept unsigned.
  let beliefEvidenceAgainstMass = 0;
  for (const contribution of contributions) {
    if (contribution.signedContribution >= 0) {
      beliefEvidenceForMass += contribution.signedContribution;
    } else {
      beliefEvidenceAgainstMass += -contribution.signedContribution;
    }
  }
  return { beliefEvidenceForMass, beliefEvidenceAgainstMass };
}

// The signed projection (r − s)/(r + s + W) of spec §2: lives in the open
// interval (−1, +1) — even an enormous one-sided mass approaches the endpoint
// and never reaches it, because W is always in the denominator.
export function projectBeliefCredenceFromEvidenceMasses(
  forMass: number,
  againstMass: number
): number {
  return (forMass - againstMass) / (forMass + againstMass + BELIEF_PRIOR_MASS);
}

// The derived uncertainty W/(r + s + W) of spec §2 — how little evidence a
// credence rests on, unsigned (0, 1]. Derived on read, never stored: a stored
// uncertainty would only be one more cache to go stale.
export function deriveBeliefUncertaintyFromEvidenceMasses(
  forMass: number,
  againstMass: number
): number {
  return BELIEF_PRIOR_MASS / (forMass + againstMass + BELIEF_PRIOR_MASS);
}

// V2 policy: accumulate the contributions into the two evidence masses, then
// project. Same gradeBelief contract as v1 carried: every contribution is
// additive (no origin-key collapse — repetition reinforces, asymptotically),
// balanced masses (including the empty list) grade to 0, and the result stays
// strictly inside (−1, +1).
export const beliefGradingPolicyV2: BeliefGradingPolicy = {
  gradeBelief(contributions: BeliefEvidenceContribution[]): number {
    // The two unsigned masses the contribution list accumulates to.
    const masses = accumulateBeliefEvidenceMasses(contributions);
    return projectBeliefCredenceFromEvidenceMasses(
      masses.beliefEvidenceForMass,
      masses.beliefEvidenceAgainstMass
    );
  },
};
