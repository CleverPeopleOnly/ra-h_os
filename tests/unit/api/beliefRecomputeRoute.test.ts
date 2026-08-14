/**
 * RECOMPUTE requests through the app: POST /api/belief/recompute
 * (app/api/belief/recompute/route.ts — new, this is the red).
 *
 * Both app-backed MCP doors are HTTP proxies with no database of their own,
 * so the new rah_recompute_node_belief tool needs this app endpoint to
 * forward to. The route stands on the engine that already exists —
 * recomputeNodeBelief in src/services/belief/beliefService.ts — and the
 * grading arithmetic is pinned by that engine's own tests. What THIS file
 * pins is the route's contract around it:
 *
 *  - a recompute answers { success, node_id, belief_credence, message } and
 *    the answered credence is the one actually persisted on the node. In the
 *    interim world of the evidence-leaves-the-edges-table slice no edge
 *    carries evidence, so a recompute of a non-fixed node lands
 *    never-assessed — credence NULL, computed_at NULL, no movement row —
 *    whatever edges the node has,
 *  - belief_credence NULL is a REAL answer, not an error: an ungraded node
 *    answers null, and null must never be coerced to 0,
 *  - an unknown node is refused with 404 naming the node — the engine itself
 *    would quietly answer "ungraded" for any id, and a caller with a typo'd
 *    node id must not be told its node is merely ungraded,
 *  - a missing or non-numeric node_id is refused with 400.
 *
 * Seam: tests/unit/belief/helpers/tempBeliefDatabase.ts, with the route
 * module imported dynamically AFTER the temp database opens. The import path
 * names a module this MR must create, so today the import itself fails — a
 * feature-missing red, not a broken assertion.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from '../belief/helpers/tempBeliefDatabase';

// The reply the route must answer a recompute with. belief_credence is null
// exactly when the node has no counted evidence — ungraded, a real state.
interface BeliefRecomputeReply {
  success: boolean;
  node_id: number;
  belief_credence: number | null;
  message: string;
}

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

// Import the route module under test, bound to THIS temp-database generation.
async function importBeliefRecomputeRoute() {
  return import('../../../app/api/belief/recompute/route');
}

// Drive the route's POST handler with a JSON body, as a door would call it.
async function postBeliefRecompute(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await importBeliefRecomputeRoute();
  const recomputeRequest = new Request('http://127.0.0.1/api/belief/recompute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(recomputeRequest);
}

// Seed a target node with an edge to a graded fixed source — the shape that
// USED to be gradeable. Since the evidence-leaves-the-edges-table slice the
// edge is a plain relationship, so a recompute of the target lands
// never-assessed; the fixture proves that outcome holds even with edges to
// graded nodes present.
function seedTargetNodeWithEdgeToFixedSource(): number {
  const fixedCredenceSourceNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
    title: 'Fixed-credence source node',
    beliefCredence: 0.8,
  });
  // The node the recompute will land never-assessed.
  const recomputeTargetNodeId = tempBeliefDb.insertNodeFixture({
    title: 'Node awaiting a recompute',
  });
  tempBeliefDb.insertNonEvidenceEdgeFixture({
    fromNodeId: recomputeTargetNodeId,
    toNodeId: fixedCredenceSourceNodeId,
  });
  return recomputeTargetNodeId;
}

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('POST /api/belief/recompute', () => {
  // The whole path in one pass, reshaped to the interim world: engine
  // invoked, and the reply carries what was actually persisted — which for a
  // non-fixed node is never-assessed, even with an edge to a graded node.
  it('recomputes a non-fixed node to never-assessed and answers the persisted null credence', async () => {
    const recomputedNodeId = seedTargetNodeWithEdgeToFixedSource();

    const recomputeResponse = await postBeliefRecompute({ node_id: recomputedNodeId });
    expect(recomputeResponse.status).toBe(200);
    const recomputeReply = (await recomputeResponse.json()) as BeliefRecomputeReply;

    expect(recomputeReply.success).toBe(true);
    expect(recomputeReply.node_id).toBe(recomputedNodeId);
    // Never-assessed is the real answer, and it matches what was stored.
    expect(recomputeReply.belief_credence).toBeNull();
    const persistedNodeBelief = tempBeliefDb.readNodeBelief(recomputedNodeId);
    expect(persistedNodeBelief.belief_credence).toBeNull();
    expect(persistedNodeBelief.belief_computed_at).toBeNull();

    // An ungraded outcome is never a movement: nothing was logged.
    expect(tempBeliefDb.readBeliefMovements(recomputedNodeId)).toHaveLength(0);
  });

  // A repeat recompute lands on the same never-assessed outcome, and the
  // movement log must not grow: there is still no to_credence to record.
  it('appends no movement when a repeat recompute lands never-assessed again', async () => {
    const stableNodeId = seedTargetNodeWithEdgeToFixedSource();
    await postBeliefRecompute({ node_id: stableNodeId });

    const repeatRecomputeResponse = await postBeliefRecompute({ node_id: stableNodeId });

    expect(repeatRecomputeResponse.status).toBe(200);
    const repeatReply = (await repeatRecomputeResponse.json()) as BeliefRecomputeReply;
    expect(repeatReply.success).toBe(true);
    expect(tempBeliefDb.readBeliefMovements(stableNodeId)).toHaveLength(0);
  });

  // Ungraded is a real outcome: a node with no counted evidence answers a
  // null credence with success TRUE — and null, never 0, which would claim
  // the node was assessed and believed neither way.
  it('answers belief_credence null with success for a node with no counted evidence', async () => {
    const evidencelessNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Node with no evidence at all',
    });

    const ungradedResponse = await postBeliefRecompute({ node_id: evidencelessNodeId });
    expect(ungradedResponse.status).toBe(200);
    const ungradedReply = (await ungradedResponse.json()) as BeliefRecomputeReply;

    expect(ungradedReply.success).toBe(true);
    expect(ungradedReply.belief_credence).toBeNull();
    expect(ungradedReply.belief_credence).not.toBe(0);
    // Nothing changed, so nothing was logged.
    expect(tempBeliefDb.readBeliefMovements(evidencelessNodeId)).toHaveLength(0);
  });

  // The engine quietly answers "ungraded" for ANY id, so the route must
  // check existence itself: a typo'd node id is an error, not an ungraded
  // node — the same null-versus-absent line the whole belief surface keeps.
  it('refuses an unknown node with 404 and an error naming the node', async () => {
    // A node id no fixture created, so the route cannot find it.
    const unknownNodeId = 424242;

    const missingNodeResponse = await postBeliefRecompute({ node_id: unknownNodeId });

    expect(missingNodeResponse.status).toBe(404);
    const missingNodeReply = (await missingNodeResponse.json()) as {
      success: boolean;
      error: string;
    };
    expect(missingNodeReply.success).toBe(false);
    expect(missingNodeReply.error).toContain(String(unknownNodeId));
  });

  // A recompute that cannot name its node is refused before the engine runs.
  it('refuses a body missing node_id or carrying a non-numeric one with 400', async () => {
    // Each malformed body alongside why it must be refused.
    const malformedRecomputeBodies: Array<[Record<string, unknown>, string]> = [
      [{}, 'a body without node_id names no node'],
      [{ node_id: 'abc' }, 'a non-numeric node_id names no node'],
    ];

    for (const [malformedBody, refusalReason] of malformedRecomputeBodies) {
      const malformedResponse = await postBeliefRecompute(malformedBody);
      expect(malformedResponse.status, refusalReason).toBe(400);
    }
  });
});
