/**
 * Behaviour tests for the v2 MOVEMENT TRIGGER vocabulary
 * (docs/belief-model-subjective-logic.md §5) against a real temp-file SQLite
 * database (see tempBeliefDatabase.ts for the safety seam).
 *
 * V1 writes the constant 'belief-recompute' on every engine movement, so the
 * log can never answer WHY a credence moved. V2 makes `trigger` the actual
 * cause, one value per entry point:
 *
 *   evidence-edge-write            EdgeService create/update of an evidence edge
 *   embed-grade                    the auto-embed queue's post-embed regrade
 *   recovery-sweep                 the startup recovery sweep
 *   propagation                    downstream regrades inside a sweep
 *   mcp-recompute                  POST /api/belief/recompute (the doors' engine door)
 *   belief-fixed-credence-set      a human asserting a credence
 *   belief-fixed-credence-cleared  the un-fix door
 *
 * and the constant 'belief-recompute' disappears. The 'propagation' trigger
 * is pinned beside the sweep mechanics in beliefPropagationSweepV2.test.ts,
 * and 'belief-fixed-credence-cleared' beside the un-fix semantics in
 * beliefFixedCredenceClearV2.test.ts; every other entry point is pinned here.
 * (The 'belief-fixed-credence-set' case already holds under v1 and is
 * restated so the vocabulary is pinned in one place.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { EdgeData } from '@/types/database';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// Replace the real embedding pipeline with an instantly-successful stub so
// the auto-embed queue reaches its completion path (and its belief hook)
// without network or vector work — same seam as autoEmbedBeliefHook.test.ts,
// but WITHOUT mocking the belief service: the movement row must be real.
vi.mock('@/services/embedding/ingestion', () => ({
  embedNodeContent: vi.fn(async () => ({ success: true })),
}));

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// Seed a claim fed by one evidence edge from a fixed source, so any entry
// point that regrades the claim produces a real movement row to inspect.
function seedGradeableClaim(
  context: TempBeliefDatabase
): { claimNodeId: number; sourceNodeId: number; edgeId: number } {
  const claimNodeId = context.insertNodeFixture({ title: 'claim awaiting a trigger' });
  const sourceNodeId = context.insertFixedBeliefCredenceNodeFixture({
    title: 'fixed source feeding the claim',
    beliefCredence: 0.9,
  });
  const edgeId = context.insertEvidenceEdgeFixture({
    fromNodeId: sourceNodeId,
    toNodeId: claimNodeId,
    support: 0.5,
  });
  return { claimNodeId, sourceNodeId, edgeId };
}

// The trigger of a node's most recent movement row, or undefined when the
// node has no movements yet.
function latestMovementTrigger(context: TempBeliefDatabase, nodeId: number): string | undefined {
  const movements = context.readBeliefMovements(nodeId);
  return movements[movements.length - 1]?.trigger;
}

describe('movement triggers name their entry point (v2)', () => {
  // Creating an evidence edge through EdgeService is the evidence-edge-write
  // entry point, and the movement it causes must say so.
  it("EdgeService.createEdge logs the regrade with trigger 'evidence-edge-write'", async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim graded by an edge write' });
    const sourceNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed source writing evidence',
      beliefCredence: 0.9,
    });
    const { edgeService } = await db.importEdgeService();

    // skip_inference + explicit explanation: no LLM path is ever exercised.
    const evidenceEdgeInput: EdgeData = {
      from_node_id: sourceNodeId,
      to_node_id: claimNodeId,
      explanation: 'Evidence edge written to pin its movement trigger.',
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
      belief_evidence_support: 0.5,
    };
    await edgeService.createEdge(evidenceEdgeInput);

    expect(latestMovementTrigger(db, claimNodeId)).toBe('evidence-edge-write');
  });

  // Correcting a stored support through EdgeService is the same entry point:
  // the write door is the edge write, whichever verb carried it.
  it("EdgeService.updateEdge support correction logs trigger 'evidence-edge-write'", async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId } = seedGradeableClaim(db);
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const { edgeService } = await db.importEdgeService();

    await edgeService.updateEdge(edgeId, { belief_evidence_support: 0.9 });

    expect(latestMovementTrigger(db, claimNodeId)).toBe('evidence-edge-write');
  });

  // The auto-embed queue's post-embed regrade is the embed-grade entry point.
  it("the auto-embed queue's post-embed regrade logs trigger 'embed-grade'", async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedGradeableClaim(db);
    // Bind the (mocked) ingestion module and the real queue to this database
    // generation before enqueueing.
    await db.importIngestionModule();
    const { AutoEmbedQueue } = await db.importAutoEmbedQueueModule();

    const autoEmbedQueue = new AutoEmbedQueue();
    autoEmbedQueue.enqueue(claimNodeId, { force: true, reason: 'trigger-vocabulary-test' });

    // The queue completes asynchronously; wait for its regrade to land.
    await vi.waitFor(
      () => {
        expect(latestMovementTrigger(db as TempBeliefDatabase, claimNodeId)).toBe('embed-grade');
      },
      { timeout: 2000, interval: 25 }
    );
  });

  // The startup recovery sweep is its own entry point. The v2 sweep export is
  // reached through a cast — see beliefRecoverySweepStaleStampsV2.test.ts for
  // the sweep's behaviour tests.
  it("the recovery sweep logs its regrades with trigger 'recovery-sweep'", async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedGradeableClaim(db);
    const beliefRecoveryModule = (await import(
      '@/services/belief/beliefRecoveryService'
    )) as unknown as { runBeliefRecoverySweep: () => Promise<{ regradedNodeIds: number[] }> };

    await beliefRecoveryModule.runBeliefRecoverySweep();

    expect(latestMovementTrigger(db, claimNodeId)).toBe('recovery-sweep');
  });

  // The app's recompute endpoint — what both app-backed MCP doors forward
  // rah_recompute_node_belief to — is the mcp-recompute entry point.
  it("POST /api/belief/recompute logs the regrade with trigger 'mcp-recompute'", async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedGradeableClaim(db);
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
    expect(latestMovementTrigger(db, claimNodeId)).toBe('mcp-recompute');
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

  // The un-fix door logs belief-fixed-credence-cleared; its full semantics
  // live in beliefFixedCredenceClearV2.test.ts — here only the vocabulary.
  it("clearBeliefFixedCredence logs trigger 'belief-fixed-credence-cleared'", async () => {
    db = await openTempBeliefDatabase();
    // A fixed node WITH evidence behind it, so the clear's regrade lands on a
    // real credence and must therefore log a movement.
    const { claimNodeId } = seedGradeableClaim(db);
    const { setBeliefFixedCredence } = await import('@/services/belief/beliefFixedCredence');
    setBeliefFixedCredence(claimNodeId, -0.9);
    const beliefFixedCredenceModule = (await import(
      '@/services/belief/beliefFixedCredence'
    )) as unknown as { clearBeliefFixedCredence: (nodeId: number) => unknown };

    beliefFixedCredenceModule.clearBeliefFixedCredence(claimNodeId);

    expect(latestMovementTrigger(db, claimNodeId)).toBe('belief-fixed-credence-cleared');
  });

  // GUARD (spec §5): the constant 'belief-recompute' disappears from the
  // engine — checked at the source so no entry point can quietly fall back to
  // it. Source scan rather than behaviour because absence over every possible
  // call path is not observable from any one call.
  it("GUARD: the string 'belief-recompute' no longer appears in the belief services", () => {
    // Every belief service module that writes movements today.
    const beliefServiceSourcePaths = [
      path.join(process.cwd(), 'src', 'services', 'belief', 'beliefService.ts'),
      path.join(process.cwd(), 'src', 'services', 'belief', 'beliefRecoveryService.ts'),
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
