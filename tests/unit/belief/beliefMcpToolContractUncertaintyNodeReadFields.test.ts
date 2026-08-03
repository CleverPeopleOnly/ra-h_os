/**
 * Tests for the v2 NODE-read uncertainty surface of the shared MCP tool
 * contract (src/services/belief/beliefMcpToolContract.js), per
 * docs/belief-model-subjective-logic.md §2 and §6: belief_uncertainty is
 * returned ALONGSIDE belief_credence on node reads, DERIVED on read from the
 * evidence masses — never stored:
 *
 *   uncertainty = W / (r + s + W),  W = 2
 *
 * Pinned here, on the contract module directly (the doors' use of it is
 * pinned in tests/unit/mcp/mcp-doors-agree-on-belief-uncertainty-node-read.test.ts):
 *  - beliefFieldsForNodeRead derives belief_uncertainty from the row's
 *    belief_evidence_for_mass / belief_evidence_against_mass,
 *  - NULL when the node was never assessed (masses NULL),
 *  - 0 for a fixed-credence node — the dogmatic opinion u = 0 of spec §2
 *    (its masses are NULL, but an assertion is not "never assessed");
 *    SPEC GAP flagged for the Reviewer: §2 defines the dogmatic opinion but
 *    does not spell out the read-surface value, so this file pins the
 *    formalism's own answer,
 *  - derivation WINS over any stored value: a bogus belief_uncertainty key on
 *    the row is ignored, because a stored uncertainty is exactly the stale
 *    cache §2 refuses to create,
 *  - the mapper now reports exactly FOUR fields, and
 *    beliefNodeReadOutputSchemaFields declares belief_uncertainty as a
 *    nullable number.
 *
 * No database is involved: the module under test imports nothing but zod.
 * The v2 surface is reached through a namespace cast — the suite's standard
 * red pattern for exports that do not exist yet.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as beliefMcpToolContract from '@/services/belief/beliefMcpToolContract';
import {
  expectedBeliefUncertainty,
} from './helpers/beliefEvidenceMassExpectations';

// The four belief fields of one node as a v2 node-read tool must report them.
type BeliefNodeReadFieldsV2 = {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  belief_uncertainty: number | null;
};

// The mapper and schema fragment under test, cast because the .d.ts does not
// declare the v2 shape yet.
const { beliefFieldsForNodeRead, beliefNodeReadOutputSchemaFields } =
  beliefMcpToolContract as unknown as {
    // Normalise one node row's belief columns for a node read, deriving
    // belief_uncertainty from the row's evidence masses.
    beliefFieldsForNodeRead: (nodeRow: Record<string, unknown>) => BeliefNodeReadFieldsV2;
    // The output-schema fragment the doors spread into their per-node schema.
    beliefNodeReadOutputSchemaFields: Record<string, z.ZodTypeAny>;
  };

// A timestamp fixture in the ISO shape the app stamps belief_computed_at with.
const GRADED_BELIEF_COMPUTED_AT = '2026-08-01T09:00:00.000Z';

describe('belief_uncertainty on the node-read mapper (v2)', () => {
  // The headline derivation: §3 row 1's masses (0.45, 0) read back with
  // uncertainty 2/2.45 ≈ 0.816 beside the cached credence.
  it('derives belief_uncertainty = 2/(r+s+2) from the row masses (§3 row 1)', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: 0.45 / 2.45,
      belief_computed_at: GRADED_BELIEF_COMPUTED_AT,
      belief_credence_is_fixed: 0,
      belief_evidence_for_mass: 0.45,
      belief_evidence_against_mass: 0,
    });

    expect(mappedBeliefFields.belief_uncertainty).toBeCloseTo(
      expectedBeliefUncertainty(0.45, 0),
      10
    );
    expect(mappedBeliefFields.belief_uncertainty).toBeCloseTo(2 / 2.45, 10);
  });

  // §3 row 3: heavy conflict is a CONFIDENT zero — credence 0 with
  // uncertainty 0.25 — the pair v1 could not express and the read surface
  // exists to expose.
  it('reports a heavily contested credence 0 with uncertainty 0.25 (§3 row 3)', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: 0,
      belief_computed_at: GRADED_BELIEF_COMPUTED_AT,
      belief_credence_is_fixed: 0,
      belief_evidence_for_mass: 3,
      belief_evidence_against_mass: 3,
    });

    expect(mappedBeliefFields.belief_credence).toBe(0);
    expect(mappedBeliefFields.belief_uncertainty).toBeCloseTo(0.25, 10);
  });

  // Never assessed stays NULL across the whole row: no masses, no credence,
  // no uncertainty — §3 row 7 at the read surface.
  it('reports belief_uncertainty null for a never-assessed node (§3 row 7)', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: null,
      belief_computed_at: null,
      belief_credence_is_fixed: 0,
      belief_evidence_for_mass: null,
      belief_evidence_against_mass: null,
    });

    expect(mappedBeliefFields.belief_uncertainty).toBeNull();
    expect(mappedBeliefFields.belief_credence).toBeNull();
  });

  // A fixed credence is the dogmatic opinion: u = 0 by definition (spec §2),
  // even though its masses are NULL — there is no evidence ledger behind an
  // assertion, but an assertion is the OPPOSITE of "never assessed".
  it('reports belief_uncertainty 0 for a fixed-credence node (the dogmatic opinion)', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: -0.4,
      belief_computed_at: GRADED_BELIEF_COMPUTED_AT,
      belief_credence_is_fixed: 1,
      belief_evidence_for_mass: null,
      belief_evidence_against_mass: null,
    });

    expect(mappedBeliefFields.belief_uncertainty).toBe(0);
    expect(mappedBeliefFields.belief_credence).toBe(-0.4);
  });

  // Derived, not stored: a belief_uncertainty value arriving ON the row is a
  // stale cache by definition and must lose to the live derivation.
  it('ignores a stored belief_uncertainty key on the row — the derivation wins', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: 0.45 / 2.45,
      belief_computed_at: GRADED_BELIEF_COMPUTED_AT,
      belief_credence_is_fixed: 0,
      belief_evidence_for_mass: 0.45,
      belief_evidence_against_mass: 0,
      // The bogus stored value the mapper must not echo.
      belief_uncertainty: 0.99,
    });

    expect(mappedBeliefFields.belief_uncertainty).toBeCloseTo(2 / 2.45, 10);
  });

  // The mapper reports the four belief fields and nothing else — the masses
  // themselves are STATE, not read surface (spec §6 adds only uncertainty).
  it('reports exactly the four belief fields, masses not among them', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      id: 5,
      title: 'A graded node',
      belief_credence: 0.31,
      belief_computed_at: GRADED_BELIEF_COMPUTED_AT,
      belief_credence_is_fixed: 0,
      belief_evidence_for_mass: 0.9,
      belief_evidence_against_mass: 0,
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
