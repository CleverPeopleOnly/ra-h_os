/**
 * The map's belief presentation rides the STORED belief_uncertainty after the
 * display-belief slice: the evidence masses died with the schema, so
 * deriveBeliefPresentation (src/services/belief/beliefPresentation.ts) takes
 * a node row carrying belief_uncertainty and the dashed-vs-solid ring
 * decision reads THAT stored value — through the shared node-read mapper,
 * exactly as the MCP doors report it.
 *
 * Pinned at the presentation-module level on purpose: the React component and
 * toRFNodes only thread the decision through, so the module is the one seam
 * where "the ring style follows the stored column" is a fact rather than a
 * hope.
 *
 * The unchanged halves — never-assessed means no treatment, fixed means
 * uncertainty 0 with a solid ring — keep their pins in the reshaped
 * beliefPresentation.test.ts; this file is only the reversal.
 *
 * Arguments are cast through the function's own parameter type because the
 * BeliefPresentationNodeFields swap (masses out, belief_uncertainty in) is
 * part of the red this file drives.
 */

import { describe, expect, it } from 'vitest';

import { deriveBeliefPresentation } from '@/services/belief/beliefPresentation';

// One node row as the map hands it to the presentation module after this
// slice: the stored display-belief columns, no masses.
interface StoredUncertaintyPresentationRow {
  belief_credence: number | null;
  belief_credence_is_fixed: number;
  belief_uncertainty: number | null;
}

// Run the derivation over a stored-uncertainty row, cast because the module's
// declared parameter type still names the dead mass columns today.
function derivePresentationFromStoredRow(row: StoredUncertaintyPresentationRow) {
  return deriveBeliefPresentation(
    row as unknown as Parameters<typeof deriveBeliefPresentation>[0]
  );
}

describe('deriveBeliefPresentation rides the stored belief_uncertainty', () => {
  // The dashed ring: a stored uncertainty at or above 0.5 marks the credence
  // as questionable — the exact behaviour the masses used to feed, now fed by
  // the stored column.
  it('renders a dashed ring when the stored uncertainty is above the 0.5 threshold', () => {
    const presentation = derivePresentationFromStoredRow({
      belief_credence: 0.62,
      belief_credence_is_fixed: 0,
      belief_uncertainty: 0.74,
    });
    expect(presentation.beliefRingStyle).toBe('dashed');
    // The stored value itself reaches the consumer (hover card, text).
    expect(presentation.beliefUncertainty).toBe(0.74);
    expect(presentation.beliefRingHue).toBe('for');
  });

  // The solid ring: a stored uncertainty below 0.5 means the credence rests
  // on enough evidence to draw a firm boundary.
  it('renders a solid ring when the stored uncertainty is below the threshold', () => {
    const presentation = derivePresentationFromStoredRow({
      belief_credence: -0.62,
      belief_credence_is_fixed: 0,
      belief_uncertainty: 0.3,
    });
    expect(presentation.beliefRingStyle).toBe('solid');
    expect(presentation.beliefUncertainty).toBe(0.3);
    expect(presentation.beliefRingHue).toBe('against');
  });

  // The boundary belongs to dashed: exactly 0.5 stored reads as questionable,
  // preserving the >= semantics the derived value had.
  it('renders exactly 0.5 stored uncertainty as dashed (boundary included)', () => {
    const presentation = derivePresentationFromStoredRow({
      belief_credence: 0.1,
      belief_credence_is_fixed: 0,
      belief_uncertainty: 0.5,
    });
    expect(presentation.beliefRingStyle).toBe('dashed');
  });

  // The accessible text speaks the stored number in the enforced vocabulary —
  // credence then uncertainty, nothing renamed.
  it('speaks the stored uncertainty in the accessible text', () => {
    const presentation = derivePresentationFromStoredRow({
      belief_credence: 0.62,
      belief_credence_is_fixed: 0,
      belief_uncertainty: 0.74,
    });
    expect(presentation.beliefAccessibleText).toContain('credence 0.62');
    expect(presentation.beliefAccessibleText).toContain('uncertainty 0.74');
  });
});
