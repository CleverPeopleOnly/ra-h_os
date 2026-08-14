/**
 * The node-read surface after the display-belief slice: belief_uncertainty is
 * a STORED column, so the shared node-read pieces stop deriving it from the
 * dead evidence masses and carry the stored value instead.
 *
 * Pins:
 *  - BELIEF_NODE_READ_COLUMNS_SQL (src/services/belief/beliefNodeReadColumnsSql.ts)
 *    names belief_uncertainty and NEITHER mass column — the masses died with
 *    this slice, so no node-read SELECT may still ask for them,
 *  - the shared node-read mapper beliefFieldsForNodeRead
 *    (src/services/belief/beliefMcpToolContract.js) answers the STORED
 *    belief_uncertainty for a non-fixed node, and answers null when the
 *    stored column is null or missing — even when stowaway mass keys still
 *    ride the row, because there is no derivation left to win.
 *
 * The fixed-node rule is UNCHANGED and deliberately not re-pinned here: a
 * hand-asserted credence is dogmatic, so the mapper keeps answering 0 for a
 * fixed node regardless of the stored column — that pin already lives in the
 * (reshaped) beliefMcpToolContractUncertaintyNodeReadFields tests.
 */

import { describe, expect, it } from 'vitest';

import { BELIEF_NODE_READ_COLUMNS_SQL } from '@/services/belief/beliefNodeReadColumnsSql';
import { beliefFieldsForNodeRead } from '@/services/belief/beliefMcpToolContract';

describe('BELIEF_NODE_READ_COLUMNS_SQL after the display-belief slice', () => {
  // The shared fragment is the ONE place every node-read SELECT takes its
  // belief columns from, so it must swap the two mass columns for the stored
  // belief_uncertainty — and keep the three columns that were already there.
  it('names belief_uncertainty and neither mass column', () => {
    expect(BELIEF_NODE_READ_COLUMNS_SQL).toContain('n.belief_uncertainty');
    expect(BELIEF_NODE_READ_COLUMNS_SQL).not.toContain('belief_evidence_for_mass');
    expect(BELIEF_NODE_READ_COLUMNS_SQL).not.toContain('belief_evidence_against_mass');
    // The three columns that predate this slice still ride every SELECT.
    expect(BELIEF_NODE_READ_COLUMNS_SQL).toContain('n.belief_credence');
    expect(BELIEF_NODE_READ_COLUMNS_SQL).toContain('n.belief_computed_at');
    expect(BELIEF_NODE_READ_COLUMNS_SQL).toContain('n.belief_credence_is_fixed');
  });
});

describe('beliefFieldsForNodeRead answers the STORED belief_uncertainty', () => {
  // The core reversal: the stored column IS the answer for a non-fixed node.
  // Today the mapper ignores a stored belief_uncertainty and derives from the
  // masses; after this slice the stored value passes through verbatim.
  it('passes a non-fixed node\'s stored belief_uncertainty through verbatim', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: 0.62,
      belief_computed_at: '2026-08-01T09:00:00.000Z',
      belief_credence_is_fixed: 0,
      belief_uncertainty: 0.42,
    });
    expect(mappedBeliefFields.belief_uncertainty).toBe(0.42);
  });

  // The exact four-field reply for a stored-uncertainty row: nothing derived,
  // nothing extra, the stored numbers verbatim.
  it('reports exactly the four belief fields, with the stored uncertainty among them', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: -0.15,
      belief_computed_at: '2026-08-02T09:00:00.000Z',
      belief_credence_is_fixed: 0,
      belief_uncertainty: 0.9,
    });
    expect(mappedBeliefFields).toEqual({
      belief_credence: -0.15,
      belief_computed_at: '2026-08-02T09:00:00.000Z',
      belief_credence_is_fixed: 0,
      belief_uncertainty: 0.9,
    });
  });

  // The masses are DEAD: a row that still carries stowaway mass keys but no
  // stored belief_uncertainty must answer null — never the old derivation
  // (which would answer 2/(3+1+2) = 0.333... for these keys).
  it('answers null for a row without stored uncertainty, even when stowaway mass keys ride it', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: 0.3333,
      belief_computed_at: '2026-08-03T09:00:00.000Z',
      belief_credence_is_fixed: 0,
      belief_evidence_for_mass: 3,
      belief_evidence_against_mass: 1,
    });
    expect(mappedBeliefFields.belief_uncertainty).toBeNull();
  });

  // A stored NULL is a real never-assessed answer — it must stay null and
  // never be coerced to a number.
  it('keeps a stored NULL belief_uncertainty as null', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: null,
      belief_computed_at: null,
      belief_credence_is_fixed: 0,
      belief_uncertainty: null,
      // Stowaway masses beside a NULL stored column change nothing.
      belief_evidence_for_mass: 5,
      belief_evidence_against_mass: 0,
    });
    expect(mappedBeliefFields.belief_uncertainty).toBeNull();
  });
});
