/**
 * The duplicate-guard / inference-swap collision
 * (docs/belief-model-subjective-logic.md §8, "the duplicate-guard collision")
 * — part characterization pin, part FAILING-FIRST set for the
 * no-same-direction-parallel-edges slice.
 *
 * WHY THIS FILE EXISTS. The samai-diagnostic adapter writes evidence edges
 * through the remote MCP door, which forwards to POST /api/edges. That
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
 *  - case 2: the belief consequence of that merge — the colliding evidence
 *    write's support goes nowhere: the stored edge keeps its support, the
 *    derived node's masses and credence are unchanged, no movement is
 *    appended. The old double-count is dead,
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
 *    row, real id included — and the support riding on the refused write is
 *    silently dropped: no column write, no regrade, no movement.
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
import {
  expectedBeliefCredenceProjection,
  readBeliefEvidenceMasses,
} from './helpers/beliefEvidenceMassExpectations';

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

  // Case 2 — the belief consequence of the merge (RED until the
  // no-same-direction-parallel-edges slice lands). The old behaviour landed a
  // second A→B evidence row and DOUBLE-COUNTED it in A's masses. Now the
  // colliding evidence write merges into the existing edge and its riding
  // support goes nowhere: the stored edge keeps support 0.5, A's masses and
  // credence stay exactly the single-edge grade, and no belief movement is
  // appended. The double-count is dead.
  it('a colliding evidence write leaves belief untouched: stored support, masses, credence and movements unchanged', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A, the derived end' });
    // The source's fixed credence is the weight the stored edge's evidence carries.
    const sourceNodeBId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed source node B the claim derives from',
      beliefCredence: 0.8,
    });
    // The occupied slot: one canon evidence edge A→B, support 0.5, graded so
    // there is a real baseline for "unchanged" to mean something.
    const existingEvidenceEdgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeAId,
      sourceNodeId: sourceNodeBId,
      support: 0.5,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeAId);
    // The single-edge baseline: for-mass 0.8 × 0.5 = 0.4, nothing against.
    const singleEdgeForMass = 0.8 * 0.5;
    const claimCredenceBeforeCollision = Number(db.readNodeBelief(claimNodeAId).belief_credence);
    const claimMovementCountBeforeCollision = db.readBeliefMovements(claimNodeAId).length;
    // PRECONDITION: the baseline grade is real — a non-trivial mass and
    // credence — so "unchanged" below cannot be an ungraded node staying
    // ungraded.
    expect(
      Number(readBeliefEvidenceMasses(db, claimNodeAId).belief_evidence_for_mass)
    ).toBeCloseTo(singleEdgeForMass, 10);
    expect(claimCredenceBeforeCollision).toBeCloseTo(
      expectedBeliefCredenceProjection(singleEdgeForMass, 0),
      10
    );

    // The colliding evidence write: B→A as written, support 0.7 riding it,
    // swapped by the classifier into the occupied A→B slot — merged, so the
    // 0.7 must go nowhere.
    const collidingEvidenceResponse = await postEdgeThroughRestRoute(
      buildConfirmedMcpEdgeBody(sourceNodeBId, claimNodeAId, {
        explanation: SWAP_INDUCING_EXPLANATION,
        belief_evidence_support: 0.7,
      })
    );
    expect(collidingEvidenceResponse.status).toBe(200);
    const collidingEvidenceReply = (await collidingEvidenceResponse.json()) as EdgesRouteReply;
    expect(collidingEvidenceReply.already_existed).toBe(true);

    // No second row landed; the stored edge keeps its OLD support.
    expect(countStoredEdgeRowsInSlot(db, claimNodeAId, sourceNodeBId)).toBe(1);
    const storedSupportRow = db.sqlite
      .prepare('SELECT belief_evidence_support FROM edges WHERE id = ?')
      .get(existingEvidenceEdgeId) as { belief_evidence_support: number | null };
    expect(Number(storedSupportRow.belief_evidence_support)).toBeCloseTo(0.5, 10);

    // A's masses and credence are byte-for-byte the single-edge grade: no
    // regrade ran, so the 0.7 contribution never entered the basis.
    const claimMassesAfterCollision = readBeliefEvidenceMasses(db, claimNodeAId);
    expect(Number(claimMassesAfterCollision.belief_evidence_for_mass)).toBeCloseTo(
      singleEdgeForMass,
      10
    );
    expect(Number(claimMassesAfterCollision.belief_evidence_against_mass)).toBeCloseTo(0, 10);
    expect(Number(db.readNodeBelief(claimNodeAId).belief_credence)).toBeCloseTo(
      claimCredenceBeforeCollision,
      10
    );
    // And no belief movement was appended by the refused-and-merged write.
    expect(db.readBeliefMovements(claimNodeAId)).toHaveLength(
      claimMovementCountBeforeCollision
    );
  });

  // Case 3 — the same-direction guard short-circuit: its honest answer, and
  // what it silently drops. The ANSWER half pins the shape the
  // door-answers-carry-stored-row slice introduces (RED until it lands): a
  // second A→B write still answers 200 success:true with an "already exists"
  // message and writes no row, but now says already_existed explicitly and
  // carries the EXISTING edge's full stored row — real id included — instead
  // of just the two node ids. The BELIEF half is unchanged, recorded
  // behaviour: the support riding on the refused write goes nowhere — the
  // stored support keeps its old value, no regrade runs, no movement is
  // appended. A caller "correcting" a support through a repeated create is
  // silently ignored (true until a later slice removes that parameter).
  it('a same-direction duplicate answers the existing edge row with already_existed, and its support is silently dropped', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A, the derived end' });
    const sourceNodeBId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed source node B the claim derives from',
      beliefCredence: 0.8,
    });
    // The occupied slot: one canon evidence edge, support 0.5, graded so
    // there is a baseline credence and movement count to hold still.
    const existingEvidenceEdgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeAId,
      sourceNodeId: sourceNodeBId,
      support: 0.5,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeAId);
    const claimCredenceBeforeDuplicate = Number(db.readNodeBelief(claimNodeAId).belief_credence);
    const claimMovementCountBeforeDuplicate = db.readBeliefMovements(claimNodeAId).length;

    // The refused write: same direction as stored, carrying a DIFFERENT
    // support (0.9) that must go nowhere.
    const duplicateWriteResponse = await postEdgeThroughRestRoute(
      buildConfirmedMcpEdgeBody(claimNodeAId, sourceNodeBId, {
        explanation: NON_SWAPPING_EXPLANATION,
        belief_evidence_support: 0.9,
      })
    );

    // The unchanged half of the answer: 200 success:true with the message.
    expect(duplicateWriteResponse.status).toBe(200);
    const duplicateWriteReply = (await duplicateWriteResponse.json()) as EdgesRouteReply;
    expect(duplicateWriteReply.success).toBe(true);
    expect(duplicateWriteReply.message).toMatch(/already exists/i);

    // The BELIEF half — recorded behaviour, asserted BEFORE the red block
    // below so it stays verified while the answer-shape half is failing:
    // nothing was written and nothing regraded — one row, old support, same
    // credence, same movement log.
    expect(countStoredEdgeRowsInSlot(db, claimNodeAId, sourceNodeBId)).toBe(1);
    const storedSupportRow = db.sqlite
      .prepare('SELECT belief_evidence_support FROM edges WHERE id = ?')
      .get(existingEvidenceEdgeId) as { belief_evidence_support: number | null };
    expect(Number(storedSupportRow.belief_evidence_support)).toBeCloseTo(0.5, 10);
    expect(Number(db.readNodeBelief(claimNodeAId).belief_credence)).toBeCloseTo(
      claimCredenceBeforeDuplicate,
      10
    );
    expect(db.readBeliefMovements(claimNodeAId)).toHaveLength(claimMovementCountBeforeDuplicate);

    // The guard's HONEST answer shape (RED until the
    // door-answers-carry-stored-row slice lands): the explicit already_existed
    // indication and the EXISTING edge's stored row, so the caller (and the
    // MCP doors built on this reply) can follow up on the edge that actually
    // exists.
    expect(
      duplicateWriteReply.already_existed,
      'the duplicate answer must say already_existed: true'
    ).toBe(true);
    // The existing edge's row: real id, stored orientation, stored prose (the
    // evidence-edge fixture's explanation — not the refused write's).
    expect(duplicateWriteReply.data).toMatchObject({
      id: existingEvidenceEdgeId,
      from_node_id: claimNodeAId,
      to_node_id: sourceNodeBId,
      explanation: 'evidence edge fixture',
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
