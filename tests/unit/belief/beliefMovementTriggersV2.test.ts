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
 * INTERIM WORLD (the evidence-leaves-the-edges-table slice): belief evidence
 * moved out of this fork into samai's own store, so no edge carries evidence
 * and every non-fixed recompute lands never-assessed — credence NULL with no
 * movement row, because an ungraded outcome has no to_credence to record.
 * The only entry point that still logs a movement is a human asserting a
 * credence ('belief-fixed-credence-set'). This file pins that each surviving
 * entry point behaves that way:
 *
 *   embed-grade                    the auto-embed queue's post-embed regrade
 *                                  lands never-assessed, logging nothing
 *   mcp-recompute                  POST /api/belief/recompute (the doors'
 *                                  engine door) lands never-assessed,
 *                                  logging nothing
 *   belief-fixed-credence-set      a human asserting a credence — still a
 *                                  real movement
 *   belief-fixed-credence-cleared  the un-fix door — the clear regrades to
 *                                  never-assessed, so no movement is logged
 *
 * deleted in the evidence-leaves-the-edges-table slice: the
 * 'evidence-edge-write' tests (EdgeService createEdge/updateEdge no longer
 * touch belief state at all — pinned in edgeWritesTouchNoBeliefState.test.ts)
 * and the 'recovery-sweep' test (the recovery service is deleted — pinned in
 * beliefRecoveryServiceRemoved.test.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// Replace the real embedding pipeline with an instantly-successful stub so
// the auto-embed queue reaches its completion path (and its belief hook)
// without network or vector work — same seam as autoEmbedBeliefHook.test.ts,
// but WITHOUT mocking the belief service: the stored outcome must be real.
vi.mock('@/services/embedding/ingestion', () => ({
  embedNodeContent: vi.fn(async () => ({ success: true })),
}));

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
  // The auto-embed queue's post-embed regrade is the embed-grade entry
  // point. In the interim world its recompute of a non-fixed node lands
  // never-assessed: the node's stale credence is cleared to NULL and NO
  // movement is logged (an ungraded outcome has no to_credence to record).
  it("the auto-embed queue's post-embed regrade lands never-assessed and logs no movement", async () => {
    db = await openTempBeliefDatabase();
    // A stale seeded credence makes the regrade observable: the recompute
    // clears it to NULL, which is how the test knows the hook actually ran.
    const claimNodeId = db.insertNodeFixture({
      title: 'claim regraded after embedding',
      beliefCredence: 0.4,
    });
    // Bind the (mocked) ingestion module and the real queue to this database
    // generation before enqueueing.
    await db.importIngestionModule();
    const { AutoEmbedQueue } = await db.importAutoEmbedQueueModule();

    const autoEmbedQueue = new AutoEmbedQueue();
    autoEmbedQueue.enqueue(claimNodeId, { force: true, reason: 'trigger-vocabulary-test' });

    // The queue completes asynchronously; wait for its regrade to land as
    // never-assessed.
    await vi.waitFor(
      () => {
        expect(
          (db as TempBeliefDatabase).readNodeBelief(claimNodeId).belief_credence
        ).toBeNull();
      },
      { timeout: 2000, interval: 25 }
    );

    // Never-assessed is not a movement: nothing was logged for the node.
    expect(db.readBeliefMovements(claimNodeId)).toEqual([]);
  });

  // The app's recompute endpoint — what both app-backed MCP doors forward
  // rah_recompute_node_belief to — is the mcp-recompute entry point. In the
  // interim world a recompute of a non-fixed node lands never-assessed and
  // logs NO movement.
  it('POST /api/belief/recompute lands never-assessed and logs no movement', async () => {
    db = await openTempBeliefDatabase();
    // A stale seeded credence makes the recompute observable: it is cleared
    // to NULL rather than regraded to a new value.
    const claimNodeId = db.insertNodeFixture({
      title: 'claim recomputed through the engine door',
      beliefCredence: 0.4,
    });
    // Import the route bound to this database generation, then drive its POST
    // handler exactly as a door would.
    const { POST } = await import('../../../app/api/belief/recompute/route');
    const recomputeRequest = new Request('http://127.0.0.1/api/belief/recompute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: claimNodeId }),
    }) as unknown as NextRequest;

    const recomputeResponse = await POST(recomputeRequest);

    expect(recomputeResponse.status).toBe(200);
    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeNull();
    expect(db.readBeliefMovements(claimNodeId)).toEqual([]);
  });

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
  // beliefEngineWithoutEdgeEvidence — here only the vocabulary outcome: the
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

    // The regrade after the clear has no evidence to read: never-assessed.
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
