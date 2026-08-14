/**
 * THE RECOMPUTE SURFACE DIES with the display-belief slice — service half.
 *
 * recomputeNodeBelief leaves beliefService: samai owns the engine, and a
 * fork-side recompute that writes "never assessed" would erase samai's
 * display writes. The one caller that still needed it — the un-fix door
 * clearBeliefFixedCredence — now clears the flag and writes
 * credence/uncertainty/computed_at to NULL DIRECTLY, with no engine
 * involved. The observable outcome is unchanged (never-assessed), which this
 * file pins on the new four-column schema: the write must work on a database
 * whose mass columns are gone, and must null the stored belief_uncertainty
 * along with the other two.
 *
 * Seam: tests/unit/belief/helpers/tempBeliefDatabase.ts, with the fixed-
 * credence module imported dynamically AFTER the temp database opens.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('recomputeNodeBelief leaves beliefService', () => {
  // The structural proof that no engine is involved anywhere: the service
  // module simply no longer exports a recompute.
  it('beliefService no longer exports recomputeNodeBelief', async () => {
    const beliefServiceModule = await tempBeliefDb.importBeliefService();
    expect(
      'recomputeNodeBelief' in beliefServiceModule,
      'recomputeNodeBelief must leave beliefService — samai owns the engine now'
    ).toBe(false);
  });
});

describe('clearBeliefFixedCredence writes never-assessed directly', () => {
  // The un-fix door's whole outcome on the four-column schema: flag cleared,
  // all three display columns NULL (belief_uncertainty INCLUDED — the stored
  // column must not survive a withdrawal), no movement logged, and null
  // reported — the same observable outcome the engine used to produce.
  it('clears the flag, nulls credence/uncertainty/computed_at, logs no movement and reports null', async () => {
    const fixedNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
      title: 'Node whose assertion is withdrawn',
      beliefCredence: 0.8,
    });

    // The un-fix door bound to THIS temp-database generation.
    const { clearBeliefFixedCredence } = await import('@/services/belief/beliefFixedCredence');
    const clearance = await clearBeliefFixedCredence(fixedNodeId);

    // Null credence reported: the node is never-assessed now — a real
    // outcome, not an error.
    expect(clearance).not.toBeNull();
    expect(clearance?.beliefCredence).toBeNull();

    // The stored row: flag 0 and ALL THREE display columns NULL.
    const storedRowAfterClear = tempBeliefDb.sqlite
      .prepare(
        `SELECT belief_credence, belief_uncertainty, belief_computed_at, belief_credence_is_fixed
         FROM nodes WHERE id = ?`
      )
      .get(fixedNodeId) as {
      belief_credence: number | null;
      belief_uncertainty: number | null;
      belief_computed_at: string | null;
      belief_credence_is_fixed: number;
    };
    expect(storedRowAfterClear.belief_credence_is_fixed).toBe(0);
    expect(storedRowAfterClear.belief_credence).toBeNull();
    expect(storedRowAfterClear.belief_uncertainty).toBeNull();
    expect(storedRowAfterClear.belief_computed_at).toBeNull();

    // No movement: an ungraded outcome has no to_credence to record, and the
    // fixture was seeded directly so the log starts empty.
    expect(tempBeliefDb.readBeliefMovements(fixedNodeId)).toHaveLength(0);
  });

  // (The unknown-node refusal is unchanged behaviour and keeps its pin in the
  // reshaped beliefFixedCredenceClearV2 tests — no green re-pin here.)
});
