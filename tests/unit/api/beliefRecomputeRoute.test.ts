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
 *    the answered credence is the one actually persisted on the node,
 *  - the engine's movement row (trigger 'mcp-recompute', v2 §5) reaches the
 *    belief_movements table when the credence moved, and a repeat over an
 *    unchanged graph appends nothing,
 *  - belief_credence NULL is a REAL answer, not an error: a node with no
 *    counted evidence is ungraded, and null must never be coerced to 0,
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

// Seed the smallest gradeable graph — a derived node deriving from a
// fixed-credence source over one canon evidence edge (derived→source) — and
// return the derived node's id.
function seedGradeableTargetNode(): number {
  // The bootstrap source: its human-asserted credence is the credence its
  // evidence carries.
  const fixedCredenceSourceNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
    title: 'Fixed-credence source node',
    beliefCredence: 0.8,
  });
  // The node the recompute will grade.
  const gradeableTargetNodeId = tempBeliefDb.insertNodeFixture({
    title: 'Derived node awaiting a grade',
  });
  tempBeliefDb.insertEvidenceEdgeFixture({
    derivedNodeId: gradeableTargetNodeId,
    sourceNodeId: fixedCredenceSourceNodeId,
    support: 0.5,
  });
  return gradeableTargetNodeId;
}

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('POST /api/belief/recompute', () => {
  // The whole path in one pass: engine invoked, node stamped, movement
  // logged, and the reply carries the credence that was actually persisted.
  it('grades a node from its evidence and answers the persisted credence', async () => {
    const gradedNodeId = seedGradeableTargetNode();

    const recomputeResponse = await postBeliefRecompute({ node_id: gradedNodeId });
    expect(recomputeResponse.status).toBe(200);
    const recomputeReply = (await recomputeResponse.json()) as BeliefRecomputeReply;

    expect(recomputeReply.success).toBe(true);
    expect(recomputeReply.node_id).toBe(gradedNodeId);
    // The exact number belongs to the grading policy's own tests; here the
    // contract is that a graded credence exists and matches what was stored.
    expect(typeof recomputeReply.belief_credence).toBe('number');
    const persistedNodeBelief = tempBeliefDb.readNodeBelief(gradedNodeId);
    expect(recomputeReply.belief_credence).toBe(persistedNodeBelief.belief_credence);
    expect(persistedNodeBelief.belief_computed_at).not.toBeNull();

    // The engine's movement row reached the table: ungraded -> the new grade.
    const beliefMovements = tempBeliefDb.readBeliefMovements(gradedNodeId);
    expect(beliefMovements).toHaveLength(1);
    expect(beliefMovements[0]).toMatchObject({
      from_credence: null,
      to_credence: recomputeReply.belief_credence,
      // EDITED per belief model v2 §5: the trigger names the actual entry
      // point — this route is the doors' engine door, 'mcp-recompute'; the
      // v1 constant 'belief-recompute' is retired.
      trigger: 'mcp-recompute',
    });
  });

  // Recomputing an unchanged graph lands on the same credence, and a
  // movement records the credence CHANGING — so the log must not grow.
  it('appends no second movement when a repeat recompute lands on the same credence', async () => {
    const stableNodeId = seedGradeableTargetNode();
    await postBeliefRecompute({ node_id: stableNodeId });

    const repeatRecomputeResponse = await postBeliefRecompute({ node_id: stableNodeId });

    expect(repeatRecomputeResponse.status).toBe(200);
    const repeatReply = (await repeatRecomputeResponse.json()) as BeliefRecomputeReply;
    expect(repeatReply.success).toBe(true);
    expect(tempBeliefDb.readBeliefMovements(stableNodeId)).toHaveLength(1);
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
