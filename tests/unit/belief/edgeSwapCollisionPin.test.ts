/**
 * CHARACTERIZATION PIN — the duplicate-guard / inference-swap collision
 * (docs/belief-model-subjective-logic.md §8, "the duplicate-guard collision").
 *
 * WHY THIS PIN EXISTS. The samai-diagnostic adapter writes evidence edges
 * through the remote MCP door, which forwards to POST /api/edges. That
 * consumer needs to know what the store answers when a write collides with an
 * edge that already occupies a direction slot — and, crucially, what happens
 * when the prose classifier SWAPS a write into an occupied slot. The recorded
 * answer, pinned here (one deliberate exception aside — see case 3 — no
 * change is planned):
 *
 *  - the edges table has NO uniqueness constraint on (from_node_id,
 *    to_node_id), and edgeService.createEdge has no duplicate guard of its
 *    own — the only guards live in the callers,
 *  - the REST route's guard checks edgeExists on the AS-WRITTEN ends BEFORE
 *    inference runs, and it is per-direction: an occupied A→B slot does not
 *    block a B→A write,
 *  - therefore a B→A write whose explanation makes inference swap the stored
 *    ends lands a SECOND A→B row — a duplicate in the occupied slot, with no
 *    refusal and no merge,
 *  - and the belief consequence: both A→B rows sit in A's evidence basis (A's
 *    outgoing support-bearing edges, canon direction), so the duplicate
 *    DOUBLE-COUNTS in A's masses — consistent with the recorded
 *    repetition-reinforces decision (§2), but a consumer deduplicating
 *    evidence must do it before writing,
 *  - the same-direction guard short-circuit answers success:true with an
 *    "Edge already exists" message and writes no row — and a support carried
 *    on the refused write is silently dropped: no column write, no regrade,
 *    no movement. The ANSWER SHAPE of this branch is the one planned change
 *    (the door-answers-carry-stored-row slice): case 3 now pins the HONEST
 *    duplicate answer — an explicit already_existed indication and the
 *    EXISTING edge's full stored row, real id included — and is RED until
 *    that slice lands. Its belief half (the dropped support) is unchanged
 *    and stays pinned.
 *
 * The tool-side guard (src/tools/database/createEdge.ts answers
 * success:false) is already pinned in tests/unit/tools/createEdge.test.ts and
 * is not repeated here; the route is the door the samai adapter meets.
 *
 * These tests are GREEN by design — they record what the store actually does
 * today — except case 3's answer-shape half, red on purpose as part of the
 * door-answers-carry-stored-row slice's failing set. Runs against a fresh temp-file database per test (see
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
// on a create AND (once the door-answers-carry-stored-row slice lands) on a
// guard short-circuit, where already_existed marks that nothing was written.
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

describe('duplicate-guard / inference-swap collision (characterization pin)', () => {
  // Case 1 — the collision itself. An A→B row exists; a B→A write with
  // swap-inducing prose passes the guard (it checks the EMPTY B→A slot,
  // as-written, before inference), inference swaps the stored ends, and a
  // SECOND A→B row lands in the occupied slot. No refusal, no merge.
  it('a swapped write into an occupied slot stores a duplicate row: two A→B rows, no refusal', async () => {
    db = await openTempBeliefDatabase();
    // A is the derived claim (from-end under canon), B the source it derives from.
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A, the derived end' });
    const sourceNodeBId = db.insertNodeFixture({ title: 'source node B the claim derives from' });
    // The occupied slot: one stored A→B row (plain — the guard ignores
    // evidence-ness; it matches any row on the exact ends).
    db.insertNonEvidenceEdgeFixture({ fromNodeId: claimNodeAId, toNodeId: sourceNodeBId });

    // The colliding write, phrased so the classifier re-orients it: written
    // B→A, stored A→B.
    const collidingWriteResponse = await postEdgeThroughRestRoute(
      buildConfirmedMcpEdgeBody(sourceNodeBId, claimNodeAId, {
        explanation: SWAP_INDUCING_EXPLANATION,
      })
    );

    // Accepted as a fresh create, not short-circuited by the guard.
    expect(collidingWriteResponse.status).toBe(201);
    const collidingWriteReply = (await collidingWriteResponse.json()) as EdgesRouteReply;
    expect(collidingWriteReply.success).toBe(true);
    // PRECONDITION: inference really swapped — the stored row runs A→B,
    // whatever the caller wrote. Without this the test says nothing.
    expect(collidingWriteReply.data?.from_node_id).toBe(claimNodeAId);
    expect(collidingWriteReply.data?.to_node_id).toBe(sourceNodeBId);
    // The recorded outcome: TWO rows in the A→B slot, none in B→A.
    expect(countStoredEdgeRowsInSlot(db, claimNodeAId, sourceNodeBId)).toBe(2);
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

  // Case 2 — the belief consequence of the collision. Both A→B rows carry
  // support, so BOTH sit in A's evidence basis (its outgoing support-bearing
  // edges) and A's masses count the pair: contribution₁ + contribution₂,
  // strictly more than either alone. Repetition-reinforces (§2) applied to a
  // duplicate the caller never meant to write — the consumer's deduplication
  // must happen before the write.
  it('an occupied-slot duplicate double-counts: the derived node masses hold both contributions', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A, the derived end' });
    // The source's fixed credence is the weight both edges' evidence carries.
    const sourceNodeBId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed source node B the claim derives from',
      beliefCredence: 0.8,
    });
    // The occupied slot: one canon evidence edge A→B, support 0.5.
    db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeAId,
      sourceNodeId: sourceNodeBId,
      support: 0.5,
    });

    // The colliding evidence write: B→A as written, support 0.7, swapped by
    // the classifier into the occupied A→B slot. Its create hook regrades the
    // stored from-end (A) from A's whole basis — now two edges.
    const collidingEvidenceResponse = await postEdgeThroughRestRoute(
      buildConfirmedMcpEdgeBody(sourceNodeBId, claimNodeAId, {
        explanation: SWAP_INDUCING_EXPLANATION,
        belief_evidence_support: 0.7,
      })
    );
    expect(collidingEvidenceResponse.status).toBe(201);
    const collidingEvidenceReply = (await collidingEvidenceResponse.json()) as EdgesRouteReply;
    // PRECONDITION: the duplicate landed in the occupied slot.
    expect(collidingEvidenceReply.data?.from_node_id).toBe(claimNodeAId);
    expect(countStoredEdgeRowsInSlot(db, claimNodeAId, sourceNodeBId)).toBe(2);

    // Both contributions counted: 0.8 × 0.5 + 0.8 × 0.7 = 0.96 of for-mass.
    const doubleCountedForMass = 0.8 * 0.5 + 0.8 * 0.7;
    const claimMasses = readBeliefEvidenceMasses(db, claimNodeAId);
    expect(Number(claimMasses.belief_evidence_for_mass)).toBeCloseTo(doubleCountedForMass, 10);
    expect(Number(claimMasses.belief_evidence_against_mass)).toBeCloseTo(0, 10);
    const claimCredence = Number(db.readNodeBelief(claimNodeAId).belief_credence);
    expect(claimCredence).toBeCloseTo(
      expectedBeliefCredenceProjection(doubleCountedForMass, 0),
      10
    );
    // Strictly more than either edge alone would grade to — the double-count
    // is real, not either single-edge value surviving.
    expect(claimCredence).toBeGreaterThan(expectedBeliefCredenceProjection(0.8 * 0.5, 0));
    expect(claimCredence).toBeGreaterThan(expectedBeliefCredenceProjection(0.8 * 0.7, 0));
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

  // Case 4 — the service layer has no guard of its own: edgeService.createEdge
  // called directly with an exact duplicate writes a second row. This is what
  // makes the callers' guards the ONLY protection — any new write path that
  // skips them inherits duplicates by default.
  it('edgeService.createEdge itself accepts an exact duplicate and stores a second row', async () => {
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
    const secondStoredEdge = await edgeService.createEdge(identicalEdgeInput);

    // Two distinct rows in the one slot — no refusal, no merge, no constraint.
    expect(secondStoredEdge.id).not.toBe(firstStoredEdge.id);
    expect(countStoredEdgeRowsInSlot(db, claimNodeAId, sourceNodeBId)).toBe(2);
  });
});
