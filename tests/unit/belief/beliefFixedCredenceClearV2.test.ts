/**
 * Behaviour and contract tests for the v2 UN-FIX DOOR
 * (docs/belief-model-subjective-logic.md §2 "Fixed credence — the dogmatic
 * opinion", new in v2).
 *
 * A single operation — clearBeliefFixedCredence in
 * src/services/belief/beliefFixedCredence.ts, the twin of the existing
 * setBeliefFixedCredence — clears belief_credence_is_fixed to 0 and NULLs
 * the three display columns directly, landing the node never-assessed (see
 * beliefClearFixedCredenceWithoutEngine.test.ts for the engine-free pins).
 *
 * deleted in the evidence-leaves-the-edges-table slice: the
 * regrades-from-its-evidence test and the propagates-through-the-cleared-node
 * test — both had edge evidence itself as their subject.
 *
 * reshaped in the display-belief-door-writable slice: the mass columns are
 * gone, so the cleared-state assertion now reads the stored
 * belief_uncertainty (NULL after a clear) instead of the two evidence masses.
 *
 * Also pinned: the shared MCP tool contract
 * (src/services/belief/beliefMcpToolContract.js) grows the input and output
 * schema fields both app doors need to advertise the door as
 * rah_clear_belief_fixed_credence; the doors' agreement on those schemas is
 * pinned in tests/unit/mcp/mcp-doors-agree-on-belief-unfix-door.test.ts.
 *
 * Every not-yet-existing export is reached through a namespace import +
 * cast, the suite's standard red pattern.
 *
 * Spec gap flagged for the Reviewer: clearing a fixed node whose regrade
 * lands UNGRADED (no counted evidence) cannot log a movement, because
 * belief_movements.to_credence is NOT NULL — this file pins "no movement row"
 * for that case, mirroring the engine's existing rule that an ungraded
 * outcome is never a movement.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';
import * as beliefMcpToolContract from '@/services/belief/beliefMcpToolContract';

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// What one successful clear reports back; shaped like the set's return so the
// two doors of the fixed-credence module mirror each other. beliefCredence is
// null when the regrade lands ungraded.
interface BeliefFixedCredenceClearance {
  beliefCredence: number | null;
}

// Import the fixed-credence module bound to the current database generation
// and hand back the clear operation (undefined until implemented — the red).
async function importClearBeliefFixedCredence(): Promise<
  (nodeId: number) => Promise<BeliefFixedCredenceClearance | null> | BeliefFixedCredenceClearance | null
> {
  const beliefFixedCredenceModule = (await import(
    '@/services/belief/beliefFixedCredence'
  )) as unknown as {
    clearBeliefFixedCredence: (
      nodeId: number
    ) => Promise<BeliefFixedCredenceClearance | null> | BeliefFixedCredenceClearance | null;
  };
  return beliefFixedCredenceModule.clearBeliefFixedCredence;
}

describe('clearBeliefFixedCredence (v2 un-fix door, service semantics)', () => {
  // Withdrawing the assertion of a node with NO evidence leaves it ungraded —
  // credence, timestamp and stored uncertainty all NULL. No movement row: an
  // ungraded outcome has no to_credence to record (see the header's spec-gap
  // note).
  it('clearing a fixed node with no evidence leaves it ungraded and logs nothing new', async () => {
    db = await openTempBeliefDatabase();
    const evidencelessNodeId = db.insertNodeFixture({ title: 'assertion with nothing behind it' });
    const { setBeliefFixedCredence } = await import('@/services/belief/beliefFixedCredence');
    setBeliefFixedCredence(evidencelessNodeId, 0.8);
    // One movement so far: the set itself.
    expect(db.readBeliefMovements(evidencelessNodeId)).toHaveLength(1);
    const clearBeliefFixedCredence = await importClearBeliefFixedCredence();

    await clearBeliefFixedCredence(evidencelessNodeId);

    expect(db.readNodeBeliefCredenceIsFixed(evidencelessNodeId)).toBe(0);
    const clearedBelief = db.readNodeBelief(evidencelessNodeId);
    expect(clearedBelief.belief_credence).toBeNull();
    expect(clearedBelief.belief_computed_at).toBeNull();
    const clearedStoredUncertaintyRow = db.sqlite
      .prepare('SELECT belief_uncertainty FROM nodes WHERE id = ?')
      .get(evidencelessNodeId) as { belief_uncertainty: number | null };
    expect(clearedStoredUncertaintyRow.belief_uncertainty).toBeNull();
    expect(db.readBeliefMovements(evidencelessNodeId)).toHaveLength(1);
  });

  // Mirror of setBeliefFixedCredence: clearing a node that does not exist is
  // a refusal (null) the caller can turn into an error, never a silent no-op.
  it('answers null for an unknown node', async () => {
    db = await openTempBeliefDatabase();
    const clearBeliefFixedCredence = await importClearBeliefFixedCredence();

    // No node was ever inserted, so any id is unknown.
    expect(await clearBeliefFixedCredence(4242)).toBeNull();
  });
});

describe('the shared MCP tool contract grows the un-fix door schemas', () => {
  // The two new schema exports, typed locally because the contract does not
  // declare them yet — the missing surface is the red.
  const { beliefClearFixedCredenceInputSchemaFields, beliefClearFixedCredenceOutputSchemaFields } =
    beliefMcpToolContract as unknown as {
      // Input schema fields of rah_clear_belief_fixed_credence.
      beliefClearFixedCredenceInputSchemaFields: { node_id: z.ZodTypeAny };
      // Output schema fields of rah_clear_belief_fixed_credence.
      beliefClearFixedCredenceOutputSchemaFields: Record<string, z.ZodTypeAny>;
    };

  // Un-fixing needs exactly one argument: which node. A credence input here
  // would contradict the door's whole meaning (the engine decides now).
  it('declares node_id as the only input field, a positive integer', () => {
    expect(Object.keys(beliefClearFixedCredenceInputSchemaFields)).toEqual(['node_id']);
    const nodeIdSchema = beliefClearFixedCredenceInputSchemaFields.node_id;
    expect(nodeIdSchema.safeParse(7).success).toBe(true);
    for (const rejectedNodeId of [0, -1, 1.5, '7', null] as const) {
      expect(
        nodeIdSchema.safeParse(rejectedNodeId).success,
        `node_id ${JSON.stringify(rejectedNodeId)} must be rejected`
      ).toBe(false);
    }
  });

  // The reply mirrors the set tool's shape, with the two signs flipped by the
  // door's meaning: the fixed flag is the LITERAL 0 (a successful clear
  // always leaves the node un-fixed) and the credence is NULLABLE (the
  // regrade may land ungraded — a real outcome, never an error).
  it('declares an output whose fixed flag is literally 0 and whose credence is nullable', () => {
    expect(Object.keys(beliefClearFixedCredenceOutputSchemaFields)).toEqual(
      expect.arrayContaining(['success', 'node_id', 'belief_credence', 'belief_credence_is_fixed'])
    );
    const clearedFixedFlagSchema =
      beliefClearFixedCredenceOutputSchemaFields.belief_credence_is_fixed;
    expect(clearedFixedFlagSchema.safeParse(0).success, 'a cleared node reports 0').toBe(true);
    expect(clearedFixedFlagSchema.safeParse(1).success, '1 would claim the clear failed').toBe(
      false
    );
    const clearedCredenceSchema = beliefClearFixedCredenceOutputSchemaFields.belief_credence;
    expect(clearedCredenceSchema.safeParse(0.31).success).toBe(true);
    expect(clearedCredenceSchema.safeParse(null).success, 'ungraded is a real outcome').toBe(true);
    expect(clearedCredenceSchema.safeParse('0.31').success).toBe(false);
  });
});
