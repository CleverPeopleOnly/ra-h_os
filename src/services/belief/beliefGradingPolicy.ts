/**
 * Belief grading policy — the pure math that turns a set of signed evidence
 * contributions into a single belief value for a node.
 *
 * POLICY V1 (PROVISIONAL): the treatment of repeated / derivative evidence
 * (contributions that share an belief_evidence_origin_key) is deliberately
 * unsettled. V1 collapses same-key contributions to the single contribution
 * with the largest absolute value. Formula:
 *   S = sum of positive collapsed contributions
 *   C = sum of |negative| collapsed contributions
 *   value = PRIOR + (1 - PRIOR)(1 - e^(-RATE * S)) - PRIOR(1 - e^(-RATE * C))
 */

// Starting belief for a node before any evidence is weighed. NOTE: an
// ungraded node (no evidence edges at all) stays NULL — it is never 0.5.
export const PRIOR_BELIEF = 0.5;

// Trust weight applied to evidence whose origin is unknown (the from-node has
// no trustOriginKey in its metadata, or the key has no belief_source_trust row).
export const DEFAULT_ORIGIN_TRUST = 0.3;

// Rate of the exponential saturation applied to accumulated support and
// contradiction mass.
export const SATURATION_RATE = 1.0;

// One evidence edge's signed input to the grading formula.
export interface BeliefEvidenceContribution {
  // Edge the contribution came from, so callers can trace results back.
  edgeId: number;
  // strength × trustWeight; negative when the edge direction is 'against'.
  signedContribution: number;
  // Edges sharing a non-null key are treated as non-independent (POLICY V1
  // collapses them); null means the contribution stands alone.
  beliefEvidenceOriginKey: string | null;
}

// Contract for a belief grading policy version.
export interface BeliefGradingPolicy {
  // Reduce a node's evidence contributions to one belief value in (0, 1).
  gradeBelief(contributions: BeliefEvidenceContribution[]): number;
}

// PROVISIONAL POLICY V1 collapse rule, deliberately isolated here so a future
// policy can replace it without touching the aggregation formula below:
// contributions sharing a non-null beliefEvidenceOriginKey are NOT additive — they
// collapse to the single contribution with the largest absolute value (ten
// articles citing one study count as that study once, at its strongest
// reading). Null-key contributions each stand alone.
function collapseContributionsByEvidenceOriginKey(
  contributions: BeliefEvidenceContribution[]
): BeliefEvidenceContribution[] {
  // Strongest-|value| contribution seen so far for each non-null key.
  const strongestByEvidenceOriginKey = new Map<string, BeliefEvidenceContribution>();
  // Contributions with no independence key — always independent, never collapsed.
  const standaloneContributions: BeliefEvidenceContribution[] = [];
  for (const contribution of contributions) {
    if (contribution.beliefEvidenceOriginKey === null) {
      standaloneContributions.push(contribution);
      continue;
    }
    const currentStrongest = strongestByEvidenceOriginKey.get(contribution.beliefEvidenceOriginKey);
    if (
      currentStrongest === undefined ||
      Math.abs(contribution.signedContribution) > Math.abs(currentStrongest.signedContribution)
    ) {
      strongestByEvidenceOriginKey.set(contribution.beliefEvidenceOriginKey, contribution);
    }
  }
  return [...standaloneContributions, ...strongestByEvidenceOriginKey.values()];
}

// V1 policy: collapse same-key evidence, then apply the saturating formula
// value = PRIOR + (1-PRIOR)(1 - e^(-RATE*S)) - PRIOR(1 - e^(-RATE*C)),
// where S is the summed positive mass and C the summed |negative| mass.
// Saturating in both directions, so the value stays strictly inside (0, 1).
export const beliefGradingPolicyV1: BeliefGradingPolicy = {
  gradeBelief(contributions: BeliefEvidenceContribution[]): number {
    const collapsedContributions = collapseContributionsByEvidenceOriginKey(contributions);
    // Total supporting mass (S in the formula).
    let supportMass = 0;
    // Total contradicting mass (C in the formula), kept as a positive number.
    let contradictionMass = 0;
    for (const contribution of collapsedContributions) {
      if (contribution.signedContribution >= 0) {
        supportMass += contribution.signedContribution;
      } else {
        contradictionMass += -contribution.signedContribution;
      }
    }
    return (
      PRIOR_BELIEF +
      (1 - PRIOR_BELIEF) * (1 - Math.exp(-SATURATION_RATE * supportMass)) -
      PRIOR_BELIEF * (1 - Math.exp(-SATURATION_RATE * contradictionMass))
    );
  },
};
