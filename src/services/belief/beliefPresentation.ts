/**
 * Pure presentation mapping for a node's belief fields: from the raw belief
 * columns of one nodes row to the presentation decisions the belief UI
 * renders. No React, no database, no DOM — pure functions only.
 *
 * The contract (pinned by tests/unit/belief/beliefPresentation.test.ts):
 *  - RING HUE follows the credence sign ('for' / 'against' / 'neutral'), and
 *    a NULL credence — never assessed — means no belief treatment at all,
 *  - RING INTENSITY is the stepped percentage of BELIEF_RING_INTENSITY_STEPS,
 *    read off |credence| (the hue, not the intensity, carries the sign),
 *  - RING STYLE is dashed when the derived uncertainty is >= 0.5, solid below,
 *  - the FIXED BADGE shows iff belief_credence_is_fixed is 1,
 *  - ACCESSIBLE TEXT speaks the enforced vocabulary (credence, uncertainty,
 *    fixed by hand) and a never-assessed node says so with no number at all.
 *
 * The uncertainty is NOT derived here: it comes from the shared node-read
 * mapper beliefFieldsForNodeRead (beliefMcpToolContract.js), so the UI and
 * the MCP doors read the same derivation and can never disagree — including
 * ignoring any stowaway belief_uncertainty key riding on the row.
 */

import { beliefFieldsForNodeRead } from '@/services/belief/beliefMcpToolContract';

// Which way the ring reads: toward the node ('for'), against it, or graded
// and balanced ('neutral'). null hue means no ring at all.
export type BeliefRingHue = 'for' | 'against' | 'neutral';

// One row of the intensity step table: every |credence| at or above
// minAbsoluteCredence (and below the next row's) renders at
// ringIntensityPercent.
export interface BeliefRingIntensityStep {
  minAbsoluteCredence: number;
  ringIntensityPercent: number;
}

// The full presentation decision for one node, as the belief UI consumes it.
// Every ring field is null exactly when the node was never assessed — a
// plain node with no belief treatment at all.
export interface BeliefPresentation {
  beliefRingHue: BeliefRingHue | null;
  beliefRingIntensityPercent: number | null;
  beliefRingStyle: 'solid' | 'dashed' | null;
  beliefFixedBadgeShown: boolean;
  beliefUncertainty: number | null;
  beliefAccessibleText: string;
}

// The four belief columns of one nodes row as this module takes them — the
// exact column names, so the same row object that feeds the shared node-read
// mapper feeds this module too. A type alias rather than an interface so a
// value of it is assignable to the mapper's Record<string, unknown>
// parameter without a cast.
export type BeliefPresentationNodeFields = {
  belief_credence: number | null;
  belief_credence_is_fixed: number;
  belief_evidence_for_mass: number | null;
  belief_evidence_against_mass: number | null;
};

/**
 * The pinned ring-intensity step table: intensity is the ringIntensityPercent
 * of the LAST row whose minAbsoluteCredence <= |credence|, so a boundary
 * |credence| belongs to the higher band.
 *
 * Bounded at 80, never 100: credence lives in the OPEN interval (-1, +1), so
 * total certainty is not expressible and the ring must never render as if it
 * were. Monotonically non-decreasing by construction (rows ascend).
 */
export const BELIEF_RING_INTENSITY_STEPS: ReadonlyArray<BeliefRingIntensityStep> = [
  // Barely leaning: the smallest visible step.
  { minAbsoluteCredence: 0, ringIntensityPercent: 15 },
  // Leaning.
  { minAbsoluteCredence: 0.15, ringIntensityPercent: 30 },
  // Committed.
  { minAbsoluteCredence: 0.4, ringIntensityPercent: 55 },
  // Strongly committed.
  { minAbsoluteCredence: 0.7, ringIntensityPercent: 80 },
];

// The dashed-ring threshold: a credence resting on this much uncertainty (or
// more) reads as questionable, so the boundary itself is dashed.
const BELIEF_DASHED_RING_UNCERTAINTY_THRESHOLD = 0.5;

// The intensity percentage for one assessed |credence|: the last step whose
// minAbsoluteCredence the |credence| reaches (>= semantics at boundaries).
function beliefRingIntensityPercentForAbsoluteCredence(absoluteCredence: number): number {
  // The percentage of the deepest step reached so far; the first row's
  // minAbsoluteCredence is 0, so every |credence| reaches at least it.
  let reachedIntensityPercent = BELIEF_RING_INTENSITY_STEPS[0].ringIntensityPercent;
  for (const intensityStep of BELIEF_RING_INTENSITY_STEPS) {
    if (absoluteCredence >= intensityStep.minAbsoluteCredence) {
      reachedIntensityPercent = intensityStep.ringIntensityPercent;
    }
  }
  return reachedIntensityPercent;
}

// The ring hue for one assessed credence: the sign, and nothing but the sign.
function beliefRingHueForCredence(assessedCredence: number): BeliefRingHue {
  if (assessedCredence > 0) return 'for';
  if (assessedCredence < 0) return 'against';
  return 'neutral';
}

/**
 * Derive the whole presentation decision for one node's belief fields.
 *
 * A NULL credence means never assessed: every ring field is null, no badge,
 * and the accessible text says so with no number — a null credence never
 * renders as 0 anywhere. The uncertainty always comes from the shared
 * node-read mapper, never from a stored value on the row.
 */
export function deriveBeliefPresentation(
  nodeBeliefFields: BeliefPresentationNodeFields
): BeliefPresentation {
  // The shared derivation (one formula, one owner): normalised credence,
  // fixed flag and DERIVED uncertainty, exactly as the MCP doors report them.
  const mappedBeliefFields = beliefFieldsForNodeRead(nodeBeliefFields);
  // Whether a human asserted this credence by hand — drives the badge and
  // the "fixed by hand" clause of the accessible text.
  const beliefFixedBadgeShown = mappedBeliefFields.belief_credence_is_fixed === 1;

  if (mappedBeliefFields.belief_credence === null) {
    // Never assessed: no belief treatment at all, and text that says so.
    return {
      beliefRingHue: null,
      beliefRingIntensityPercent: null,
      beliefRingStyle: null,
      beliefFixedBadgeShown,
      beliefUncertainty: mappedBeliefFields.belief_uncertainty,
      beliefAccessibleText: 'belief not assessed',
    };
  }

  // The assessed credence and its mapper-derived uncertainty.
  const assessedCredence = mappedBeliefFields.belief_credence;
  const beliefUncertainty = mappedBeliefFields.belief_uncertainty;

  // The accessible summary clauses, joined in the enforced vocabulary:
  // credence, then uncertainty, then the fixed-by-hand marker.
  const accessibleTextClauses = [`credence ${assessedCredence.toFixed(2)}`];
  if (beliefUncertainty !== null) {
    accessibleTextClauses.push(`uncertainty ${beliefUncertainty.toFixed(2)}`);
  }
  if (beliefFixedBadgeShown) {
    accessibleTextClauses.push('fixed by hand');
  }

  return {
    beliefRingHue: beliefRingHueForCredence(assessedCredence),
    beliefRingIntensityPercent: beliefRingIntensityPercentForAbsoluteCredence(
      Math.abs(assessedCredence)
    ),
    beliefRingStyle:
      beliefUncertainty === null
        ? null
        : beliefUncertainty >= BELIEF_DASHED_RING_UNCERTAINTY_THRESHOLD
          ? 'dashed'
          : 'solid',
    beliefFixedBadgeShown,
    beliefUncertainty,
    beliefAccessibleText: accessibleTextClauses.join(', '),
  };
}

/**
 * Compose the CSS class names for a map node's belief ring from one finished
 * presentation decision. Pure function only: from the hue, intensity, and style
 * fields of a presentation to the exact class tokens the node wears.
 *
 * Returns the empty array for a never-assessed node (beliefRingHue === null).
 * Otherwise returns one ring class with hue and intensity; additionally
 * includes the dashed class iff the style is 'dashed' (solid and null both
 * render solid, the carry-forward for the illegitimate credence-without-masses
 * state).
 */
export function beliefMapNodeRingClassNames(
  beliefPresentation: BeliefPresentation
): string[] {
  // Never assessed: no belief classes at all.
  if (beliefPresentation.beliefRingHue === null) {
    return [];
  }

  // One ring class: hue and intensity percent.
  const ringClass = `rah-map-node--belief-${beliefPresentation.beliefRingHue}-${beliefPresentation.beliefRingIntensityPercent}`;
  const classes = [ringClass];

  // Dashed marker, only when the style is explicitly dashed.
  if (beliefPresentation.beliefRingStyle === 'dashed') {
    classes.push('rah-map-node--belief-dashed');
  }

  return classes;
}
