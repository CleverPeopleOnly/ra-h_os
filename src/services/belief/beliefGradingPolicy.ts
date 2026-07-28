/**
 * Belief grading policy — the pure math that turns a set of signed evidence
 * contributions into a single credence for a node.
 *
 * Open signed scale: a credence lives in the open interval (−1, +1), with
 * 0 as the neutral/torn anchor (no lean either way) rather than a 0..1
 * probability. Every contribution is additive — there is no collapse-by-
 * origin-key step. Formula:
 *   S = sum of positive contributions
 *   C = sum of |negative| contributions
 *   credence = (1 - e^(-RATE * S)) - (1 - e^(-RATE * C))
 */

// Neutral/torn anchor on the open signed credence scale — replaces the old
// 0.5 prior. NOTE: an ungraded node (no evidence edges at all) stays NULL —
// it is never 0; 0 means graded-and-balanced, not ungraded.
export const NEUTRAL_BELIEF_CREDENCE = 0;

// Rate of the exponential saturation applied to accumulated support and
// contradiction mass.
export const SATURATION_RATE = 1.0;

// One evidence edge's signed input to the grading formula.
export interface BeliefEvidenceContribution {
  // Edge the contribution came from, so callers can trace results back.
  edgeId: number;
  // support × the source's trust score; negative when the edge's support is
  // negative, because support is the only signed term in the product.
  signedContribution: number;
}

// Contract for a belief grading policy version.
export interface BeliefGradingPolicy {
  // Reduce a node's evidence contributions to one credence in the open
  // interval (−1, +1).
  gradeBelief(contributions: BeliefEvidenceContribution[]): number;
}

// V1 policy: every contribution is additive (no origin-key collapse), then
// apply the saturating formula credence = (1 - e^(-RATE*S)) - (1 - e^(-RATE*C)),
// where S is the summed positive mass and C the summed |negative| mass.
// Saturating in both directions, so the credence stays strictly inside
// (−1, +1); balanced masses (including the empty-list case) grade to 0 (neutral).
export const beliefGradingPolicyV1: BeliefGradingPolicy = {
  gradeBelief(contributions: BeliefEvidenceContribution[]): number {
    // Total supporting mass (S in the formula).
    let supportMass = 0;
    // Total contradicting mass (C in the formula), kept as a positive number.
    let contradictionMass = 0;
    for (const contribution of contributions) {
      if (contribution.signedContribution >= 0) {
        supportMass += contribution.signedContribution;
      } else {
        contradictionMass += -contribution.signedContribution;
      }
    }
    return (
      Math.exp(-SATURATION_RATE * contradictionMass) - Math.exp(-SATURATION_RATE * supportMass)
    );
  },
};
