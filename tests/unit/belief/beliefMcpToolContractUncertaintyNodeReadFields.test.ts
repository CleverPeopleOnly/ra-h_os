/**
 * Tests for the NODE-read uncertainty surface of the shared MCP tool
 * contract (src/services/belief/beliefMcpToolContract.js):
 * belief_uncertainty is returned ALONGSIDE belief_credence on node reads.
 *
 * Pinned here, on the contract module directly (the doors' use of it is
 * pinned in tests/unit/mcp/mcp-doors-agree-on-belief-uncertainty-node-read.test.ts):
 *  - NULL when the node was never assessed,
 *  - 0 for a fixed-credence node — the dogmatic opinion u = 0
 *    (its stored uncertainty is NULL, but an assertion is not
 *    "never assessed"),
 *  - the mapper reports exactly FOUR fields, and
 *    beliefNodeReadOutputSchemaFields declares belief_uncertainty as a
 *    nullable number.
 *
 * deleted in the display-belief-door-writable slice: the mass-derivation
 * tests and the "ignores a stored belief_uncertainty key" test — the mass
 * columns are gone and belief_uncertainty is now STORED on the row, so the
 * stored value is exactly what the mapper reports (pinned in
 * beliefNodeReadStoredUncertainty.test.ts); the old rule is inverted, not
 * merely reshaped.
 *
 * No database is involved: the module under test imports nothing but zod.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as beliefMcpToolContract from '@/services/belief/beliefMcpToolContract';

// The four belief fields of one node as a v2 node-read tool must report them.
type BeliefNodeReadFieldsV2 = {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  belief_uncertainty: number | null;
};

// The mapper and schema fragment under test, cast so the row input can stay
// an open record of raw column values.
const { beliefFieldsForNodeRead, beliefNodeReadOutputSchemaFields } =
  beliefMcpToolContract as unknown as {
    // Normalise one node row's belief columns for a node read, reporting the
    // row's stored belief_uncertainty.
    beliefFieldsForNodeRead: (nodeRow: Record<string, unknown>) => BeliefNodeReadFieldsV2;
    // The output-schema fragment the doors spread into their per-node schema.
    beliefNodeReadOutputSchemaFields: Record<string, z.ZodTypeAny>;
  };

// A timestamp fixture in the ISO shape the app stamps belief_computed_at with.
const GRADED_BELIEF_COMPUTED_AT = '2026-08-01T09:00:00.000Z';

describe('belief_uncertainty on the node-read mapper (v2)', () => {
  // Never assessed stays NULL across the whole row: no stored uncertainty,
  // no credence — never-assessed at the read surface.
  it('reports belief_uncertainty null for a never-assessed node', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: null,
      belief_computed_at: null,
      belief_credence_is_fixed: 0,
      belief_uncertainty: null,
    });

    expect(mappedBeliefFields.belief_uncertainty).toBeNull();
    expect(mappedBeliefFields.belief_credence).toBeNull();
  });

  // A fixed credence is the dogmatic opinion: u = 0 by definition, even
  // though its stored uncertainty is NULL — an assertion carries no
  // uncertainty of its own, but it is the OPPOSITE of "never assessed".
  it('reports belief_uncertainty 0 for a fixed-credence node (the dogmatic opinion)', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: -0.4,
      belief_computed_at: GRADED_BELIEF_COMPUTED_AT,
      belief_credence_is_fixed: 1,
      belief_uncertainty: null,
    });

    expect(mappedBeliefFields.belief_uncertainty).toBe(0);
    expect(mappedBeliefFields.belief_credence).toBe(-0.4);
  });

  // The mapper reports the four belief fields and nothing else.
  it('reports exactly the four belief fields', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      id: 5,
      title: 'A graded node',
      belief_credence: 0.31,
      belief_computed_at: GRADED_BELIEF_COMPUTED_AT,
      belief_credence_is_fixed: 0,
      belief_uncertainty: 0.69,
    });

    expect(Object.keys(mappedBeliefFields).sort()).toEqual([
      'belief_computed_at',
      'belief_credence',
      'belief_credence_is_fixed',
      'belief_uncertainty',
    ]);
  });
});

describe('belief_uncertainty on the node-read output schema (v2)', () => {
  // The fragment gains belief_uncertainty beside the original three columns,
  // so both doors advertise it structurally.
  it('declares belief_uncertainty among the belief columns', () => {
    expect(Object.keys(beliefNodeReadOutputSchemaFields).sort()).toEqual([
      'belief_computed_at',
      'belief_credence',
      'belief_credence_is_fixed',
      'belief_uncertainty',
    ]);
  });

  // belief_uncertainty must accept every state the mapper can produce — a
  // number in [0, 1] (0 is the dogmatic opinion, values near 1 a bare shrug)
  // and null for never assessed — and refuse a non-number.
  it('accepts number-or-null uncertainty, including 0, and rejects a string', () => {
    const beliefUncertaintySchema = beliefNodeReadOutputSchemaFields.belief_uncertainty;

    expect(beliefUncertaintySchema.safeParse(0.25).success).toBe(true);
    expect(beliefUncertaintySchema.safeParse(1).success).toBe(true);
    expect(beliefUncertaintySchema.safeParse(0).success, 'the dogmatic opinion is 0').toBe(true);
    expect(beliefUncertaintySchema.safeParse(null).success, 'never assessed is null').toBe(true);
    expect(beliefUncertaintySchema.safeParse('0.25').success).toBe(false);
  });
});
