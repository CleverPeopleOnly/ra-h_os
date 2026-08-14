/**
 * The duplicate-guard / inference-swap collision ("the duplicate-guard
 * collision" — recorded in samai's belief-model docs since the model prose
 * left this fork) — part characterization pin, part FAILING-FIRST set for
 * the no-same-direction-parallel-edges slice.
 *
 * WHY THIS FILE EXISTS. The samai-diagnostic adapter writes edges through
 * the remote MCP door, which forwards to POST /api/edges. That
 * consumer needs to know what the store answers when a write collides with an
 * edge that already occupies a direction slot — and, crucially, what happens
 * when the prose classifier SWAPS a write into an occupied slot. This file
 * began as a pure characterization pin of the old duplicate tolerance; the
 * reckoning it deferred is now here, so its cases split two ways:
 *
 *  RED — the no-same-direction-parallel-edges slice (a UNIQUE index on
 *  edges(from_node_id, to_node_id) in the database file; colliding creates
 *  merge into the existing edge), failing until it lands:
 *  - case 1: a B→A write whose explanation makes inference swap it into the
 *    occupied A→B slot no longer lands a second row — it answers 200 with
 *    already_existed: true and the EXISTING edge's full stored row, the same
 *    answer shape the as-written duplicate branch already ships,
 *  - case 2: the belief consequence of that merge — a colliding create
 *    still merges and touches no belief state: the derived node's credence
 *    is unchanged,
 *  - case 4: edgeService.createEdge itself, handed an exact duplicate,
 *    answers the EXISTING stored row (same id) and writes no second row — the
 *    guard is no longer the callers' job alone.
 *
 *  GREEN — recorded behaviour that stands:
 *  - case 1b: the guard is per-direction by design — an occupied A→B slot
 *    does not block a genuine B→A write; bidirectional coexists, one row per
 *    direction slot,
 *  - case 3: the as-written duplicate short-circuit answers honestly (shipped
 *    by the door-answers-carry-stored-row slice): 200 success:true with an
 *    explicit already_existed indication and the EXISTING edge's full stored
 *    row, real id included — and the refused write touches no belief state.
 *
 * reshaped in the evidence-leaves-the-edges-table slice: the two cases that
 * exercised a support riding on the colliding write — the door has shed the
 * support parameter and edges carry no evidence, so the surviving idea is
 * that a colliding create merges and touches no belief state at all.
 *
 * The tool-side guard (src/tools/database/createEdge.ts answers
 * success:false) is already pinned in tests/unit/tools/createEdge.test.ts and
 * is not repeated here; the route is the door the samai adapter meets.
 *
 * Runs against a fresh temp-file database per test (see
 * tempBeliefDatabase.ts for the safety seam); the route module is imported
 * dynamically AFTER the temp database opens so it binds to the same client
 * generation. The swap is induced deterministically with a "Contains…"
 * explanation (the heuristic fast-path in edges.ts infers part_of with
 * swap_direction: true, no LLM involved) — the same trick as the swap test in
 * edgeEvidenceHook.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
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

// The reply shape POST /api/edges answers with; data carries a full edge row
// on a create AND on a duplicate short-circuit, where already_existed marks
// that nothing was written — the shape the as-written branch already ships
// and cases 1 and 2 extend to post-inference collisions.
interface EdgesRouteReply {
  success: boolean;
  already_existed?: boolean;
  data?: {
    id?: number;
    from_node_id: number;
    to_node_id: number;
    explanation?: string | null;
  };
  message?: string;
  error?: string;
}

// Drive the REST route's POST handler directly with a JSON body, exactly as
// the remote MCP door's forwarded request arrives. Imported dynamically so
// the route binds to the current temp-database generation.
async function postEdgeThroughRestRoute(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import('../../../app/api/edges/route');
  const createEdgeRequest = new Request('http://127.0.0.1/api/edges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(createEdgeRequest);
}

// A confirmed MCP-shaped create body — the shape the remote door forwards —
// with the caller-chosen ends and any extra fields laid on top.
function buildConfirmedMcpEdgeBody(
  fromNodeId: number,
  toNodeId: number,
  extraFields: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    source: 'user',
    created_via: 'mcp',
    confirmed_by_user: true,
    ...extraFields,
  };
}

// Count the stored rows occupying one exact direction slot, straight from
// SQLite — the raw fact every collision assertion rests on.
function countStoredEdgeRowsInSlot(
  context: TempBeliefDatabase,
  fromNodeId: number,
  toNodeId: number
): number {
  const countRow = context.sqlite
    .prepare('SELECT COUNT(*) AS slot_row_count FROM edges WHERE from_node_id = ? AND to_node_id = ?')
    .get(fromNodeId, toNodeId) as { slot_row_count: number };
  return countRow.slot_row_count;
}

// An explanation whose "Contains…" prefix hits the deterministic heuristic
// classifier (part_of, swap_direction: true) — no LLM call, guaranteed swap.
const SWAP_INDUCING_EXPLANATION = 'Contains the finding the derived claim rests on.';

// An explanation the classifier stores as-written ("related to…" infers
// related_to with no swap) — for the writes that must NOT swap.
const NON_SWAPPING_EXPLANATION = 'Related to the neighbouring claim by a measured result.';

describe('duplicate-guard / inference-swap collision (pin + failing-first merge set)', () => {
  // Case 1 — the collision, resolved by merge (RED until the
  // no-same-direction-parallel-edges slice lands). An A→B row exists; a B→A
  // write with swap-inducing prose is swapped by inference into the occupied
  // A→B slot. The old pre-inference edgeExists guard could not see this
  // coming (it checked the EMPTY B→A slot, as-written), which is why
  // enforcement now sits AFTER inference: the colliding create merges into
  // the existing edge — 200 with already_existed: true and the EXISTING
  // edge's full stored row, no second row written.
  it('a swapped write into an occupied slot merges: 200 already_existed with the existing stored row, one A→B row', async () => {
    db = await openTempBeliefDatabase();
    // A is the derived claim (from-end under canon), B the source it derives from.
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A, the derived end' });
    const sourceNodeBId = db.insertNodeFixture({ title: 'source node B the claim derives from' });
    // The occupied slot: one stored A→B row (plain — occupancy is about the
    // exact ends, not evidence-ness). Its id and fixture explanation are what
    // the merge answer must carry back.
    const occupyingEdgeId = db.insertNonEvidenceEdgeFixture({
      fromNodeId: claimNodeAId,
      toNodeId: sourceNodeBId,
    });

    // The colliding write, phrased so the classifier re-orients it: written
    // B→A, aimed by inference at the occupied A→B slot.
    const collidingWriteResponse = await postEdgeThroughRestRoute(
      buildConfirmedMcpEdgeBody(sourceNodeBId, claimNodeAId, {
        explanation: SWAP_INDUCING_EXPLANATION,
      })
    );

    // Merged, not created: the same 200 answer shape the as-written duplicate
    // branch ships, extended to the post-inference collision.
    expect(collidingWriteResponse.status).toBe(200);
    const collidingWriteReply = (await collidingWriteResponse.json()) as EdgesRouteReply;
    expect(collidingWriteReply.success).toBe(true);
    expect(
      collidingWriteReply.already_existed,
      'the colliding write must say already_existed: true'
    ).toBe(true);
    // The EXISTING edge's stored row travels back: real id, stored A→B ends,
    // the fixture's explanation — not an echo of the refused write's prose.
    expect(collidingWriteReply.data).toMatchObject({
      id: occupyingEdgeId,
      from_node_id: claimNodeAId,
      to_node_id: sourceNodeBId,
      explanation: 'plain non-evidence edge fixture',
    });
    // Exactly ONE row in the A→B slot — no duplicate — and none in B→A.
    expect(countStoredEdgeRowsInSlot(db, claimNodeAId, sourceNodeBId)).toBe(1);
    expect(countStoredEdgeRowsInSlot(db, sourceNodeBId, claimNodeAId)).toBe(0);
  });

  // Case 1b — the per-direction half on its own, without a swap: an occupied
  // A→B slot does not block a genuine B→A write, and the two directions
  // coexist as two distinct rows. This is the door the collision walks
  // through; pinned separately so a future bidirectional guard cannot land
  // without this test noticing.
  it('the guard is per-direction: A→B occupied, a non-swapping B→A write coexists as its own row', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A' });
    const sourceNodeBId = db.insertNodeFixture({ title: 'source node B' });
    db.insertNonEvidenceEdgeFixture({ fromNodeId: claimNodeAId, toNodeId: sourceNodeBId });

    // Written B→A with prose the classifier keeps as-written (related_to,
    // no swap), so this pins the guard alone, not the swap.
    const oppositeDirectionResponse = await postEdgeThroughRestRoute(
      buildConfirmedMcpEdgeBody(sourceNodeBId, claimNodeAId, {
        explanation: NON_SWAPPING_EXPLANATION,
      })
    );

    expect(oppositeDirectionResponse.status).toBe(201);
    const oppositeDirectionReply = (await oppositeDirectionResponse.json()) as EdgesRouteReply;
    // PRECONDITION: stored as written — no swap on this prose.
    expect(oppositeDirectionReply.data?.from_node_id).toBe(sourceNodeBId);
    expect(oppositeDirectionReply.data?.to_node_id).toBe(claimNodeAId);
    // Both directions now coexist, one row each.
    expect(countStoredEdgeRowsInSlot(db, claimNodeAId, sourceNodeBId)).toBe(1);
    expect(countStoredEdgeRowsInSlot(db, sourceNodeBId, claimNodeAId)).toBe(1);
  });

  // Case 2 — the belief consequence of the merge: a colliding create still
  // merges and touches no belief state. The derived node keeps exactly the
  // belief it had (here: never-assessed, the only state a graph without edge
  // evidence produces for a non-fixed node).
  it('a colliding create merges and touches no belief state: credence unchanged', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A, the derived end' });
    const sourceNodeBId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed source node B the claim derives from',
      beliefCredence: 0.8,
    });
    // The occupied slot: one stored A→B row.
    db.insertNonEvidenceEdgeFixture({
      fromNodeId: claimNodeAId,
      toNodeId: sourceNodeBId,
    });

    // The colliding write: B→A as written, swapped by the classifier into
    // the occupied A→B slot — merged.
    const collidingWriteResponse = await postEdgeThroughRestRoute(
      buildConfirmedMcpEdgeBody(sourceNodeBId, claimNodeAId, {
        explanation: SWAP_INDUCING_EXPLANATION,
      })
    );
    expect(collidingWriteResponse.status).toBe(200);
    const collidingWriteReply = (await collidingWriteResponse.json()) as EdgesRouteReply;
    expect(collidingWriteReply.already_existed).toBe(true);

    // No second row landed.
    expect(countStoredEdgeRowsInSlot(db, claimNodeAId, sourceNodeBId)).toBe(1);

    // No belief state moved anywhere: the claim is still never-assessed and
    // the fixed source keeps its asserted credence.
    expect(db.readNodeBelief(claimNodeAId).belief_credence).toBeNull();
    expect(Number(db.readNodeBelief(sourceNodeBId).belief_credence)).toBeCloseTo(0.8, 10);
  });

  // Case 3 — the same-direction guard short-circuit answers honestly: a
  // second A→B write answers 200 success:true with an "already exists"
  // message, writes no row, says already_existed explicitly and carries the
  // EXISTING edge's full stored row — real id included. And the refused
  // write touches no belief state.
  it('a same-direction duplicate answers the existing edge row with already_existed and touches no belief state', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A, the derived end' });
    const sourceNodeBId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed source node B the claim derives from',
      beliefCredence: 0.8,
    });
    // The occupied slot: one stored A→B row.
    const existingEdgeId = db.insertNonEvidenceEdgeFixture({
      fromNodeId: claimNodeAId,
      toNodeId: sourceNodeBId,
    });

    // The refused write: same direction as stored.
    const duplicateWriteResponse = await postEdgeThroughRestRoute(
      buildConfirmedMcpEdgeBody(claimNodeAId, sourceNodeBId, {
        explanation: NON_SWAPPING_EXPLANATION,
      })
    );

    // 200 success:true with the message.
    expect(duplicateWriteResponse.status).toBe(200);
    const duplicateWriteReply = (await duplicateWriteResponse.json()) as EdgesRouteReply;
    expect(duplicateWriteReply.success).toBe(true);
    expect(duplicateWriteReply.message).toMatch(/already exists/i);

    // Nothing was written and no belief state moved: one row, the claim
    // still never-assessed.
    expect(countStoredEdgeRowsInSlot(db, claimNodeAId, sourceNodeBId)).toBe(1);
    expect(db.readNodeBelief(claimNodeAId).belief_credence).toBeNull();

    // The guard's honest answer shape: the explicit already_existed
    // indication and the EXISTING edge's stored row, so the caller (and the
    // MCP doors built on this reply) can follow up on the edge that actually
    // exists.
    expect(
      duplicateWriteReply.already_existed,
      'the duplicate answer must say already_existed: true'
    ).toBe(true);
    // The existing edge's row: real id, stored orientation, stored prose
    // (the fixture's explanation — not the refused write's).
    expect(duplicateWriteReply.data).toMatchObject({
      id: existingEdgeId,
      from_node_id: claimNodeAId,
      to_node_id: sourceNodeBId,
      explanation: 'plain non-evidence edge fixture',
    });
  });

  // Case 4 — the service layer itself now merges (RED until the
  // no-same-direction-parallel-edges slice lands): edgeService.createEdge
  // called directly with an exact duplicate answers the EXISTING stored row —
  // same id as the first create — and writes no second row. The guard is no
  // longer the callers' job alone, so a new write path that skips the route
  // guard no longer inherits duplicates by default.
  it('edgeService.createEdge itself merges an exact duplicate: same stored row back, one row in the slot', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A' });
    const sourceNodeBId = db.insertNodeFixture({ title: 'source node B' });
    const { edgeService } = await db.importEdgeService();

    // The identical write, twice, straight at the service (skip_inference so
    // the stored ends are exactly as written both times).
    const identicalEdgeInput = {
      from_node_id: claimNodeAId,
      to_node_id: sourceNodeBId,
      explanation: 'Related to the neighbouring node by the same measured result.',
      created_via: 'workflow' as const,
      source: 'user' as const,
      skip_inference: true,
    };
    const firstStoredEdge = await edgeService.createEdge(identicalEdgeInput);
    const secondCreateAnswer = await edgeService.createEdge(identicalEdgeInput);

    // The service's answer shape is the stored row itself, so the merge is
    // pinned as same-id + single-row: the second create answers the FIRST
    // create's row, and the slot still holds exactly one row.
    expect(secondCreateAnswer.id).toBe(firstStoredEdge.id);
    expect(countStoredEdgeRowsInSlot(db, claimNodeAId, sourceNodeBId)).toBe(1);
  });
});
