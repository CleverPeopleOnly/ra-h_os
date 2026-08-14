/**
 * Behaviour tests for the v2 MOVEMENT TRIGGER vocabulary
 * (docs/belief-model-subjective-logic.md §5) against a real temp-file SQLite
 * database (see tempBeliefDatabase.ts for the safety seam).
 *
 * V1 writes the constant 'belief-recompute' on every engine movement, so the
 * log can never answer WHY a credence moved. V2 makes `trigger` the actual
 * cause, one value per entry point — and the constant 'belief-recompute'
 * disappears.
 *
 * The only entry point that still logs a movement is a human asserting a
 * credence ('belief-fixed-credence-set'). This file pins that each surviving
 * entry point behaves that way:
 *
 *   belief-fixed-credence-set      a human asserting a credence — still a
 *                                  real movement
 *   belief-fixed-credence-cleared  the un-fix door — the clear lands
 *                                  never-assessed, so no movement is logged
 *
 * deleted in the evidence-leaves-the-edges-table slice: the
 * 'evidence-edge-write' tests (EdgeService createEdge/updateEdge no longer
 * touch belief state at all — pinned in edgeWritesTouchNoBeliefState.test.ts)
 * and the 'recovery-sweep' test (the recovery service is deleted — pinned in
 * beliefRecoveryServiceRemoved.test.ts).
 *
 * deleted in the display-belief-door-writable slice: the auto-embed regrade
 * test and the POST /api/belief/recompute test — the recompute surface is
 * gone (the route is deleted and the auto-embed queue's post-embed regrade
 * with it; pinned in autoEmbedTouchesNoBeliefState.test.ts and
 * beliefRecomputeRouteGone.test.ts), so neither entry point exists to log
 * anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// The trigger of a node's most recent movement row, or undefined when the
// node has no movements yet.
function latestMovementTrigger(context: TempBeliefDatabase, nodeId: number): string | undefined {
  const movements = context.readBeliefMovements(nodeId);
  return movements[movements.length - 1]?.trigger;
}

describe('movement triggers name their entry point (v2)', () => {
  // Restated v1 behaviour: a human assertion logs belief-fixed-credence-set.
  // Kept here so the whole trigger vocabulary is pinned in one file.
  it("setBeliefFixedCredence logs trigger 'belief-fixed-credence-set'", async () => {
    db = await openTempBeliefDatabase();
    const assertedNodeId = db.insertNodeFixture({ title: 'node about to be asserted' });
    const { setBeliefFixedCredence } = await import('@/services/belief/beliefFixedCredence');

    setBeliefFixedCredence(assertedNodeId, 0.7);

    expect(latestMovementTrigger(db, assertedNodeId)).toBe('belief-fixed-credence-set');
  });

  // The un-fix door's full semantics live in beliefFixedCredenceClearV2 and
  // beliefClearFixedCredenceWithoutEngine — here only the vocabulary outcome: the
  // clear's regrade lands never-assessed, so NO 'belief-fixed-credence-cleared'
  // movement is logged (an ungraded outcome has no to_credence to record).
  it('clearBeliefFixedCredence lands never-assessed and logs no cleared movement', async () => {
    db = await openTempBeliefDatabase();
    const assertedNodeId = db.insertNodeFixture({ title: 'node asserted then un-fixed' });
    const { setBeliefFixedCredence, clearBeliefFixedCredence } = await import(
      '@/services/belief/beliefFixedCredence'
    );
    setBeliefFixedCredence(assertedNodeId, -0.9);

    await clearBeliefFixedCredence(assertedNodeId);

    // The clear NULLs the display columns directly: never-assessed.
    expect(db.readNodeBelief(assertedNodeId).belief_credence).toBeNull();
    // Only the assertion itself is in the log; the clear logged nothing.
    const movementTriggersLoggedForClearedNode = db
      .readBeliefMovements(assertedNodeId)
      .map(movement => movement.trigger);
    expect(movementTriggersLoggedForClearedNode).toEqual(['belief-fixed-credence-set']);
  });

  // GUARD (spec §5): the constant 'belief-recompute' disappears from the
  // engine — checked at the source so no entry point can quietly fall back to
  // it. Source scan rather than behaviour because absence over every possible
  // call path is not observable from any one call.
  it("GUARD: the string 'belief-recompute' no longer appears in the belief services", () => {
    // Every belief service module that can write movements today.
    const beliefServiceSourcePaths = [
      path.join(process.cwd(), 'src', 'services', 'belief', 'beliefService.ts'),
      path.join(process.cwd(), 'src', 'services', 'belief', 'beliefFixedCredence.ts'),
    ];
    for (const beliefServiceSourcePath of beliefServiceSourcePaths) {
      const beliefServiceSource = fs.readFileSync(beliefServiceSourcePath, 'utf8');
      expect(
        beliefServiceSource.includes("'belief-recompute'"),
        `${path.basename(beliefServiceSourcePath)} must not carry the retired constant 'belief-recompute'`
      ).toBe(false);
    }
  });
});
