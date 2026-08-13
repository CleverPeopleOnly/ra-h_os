/**
 * FAILING-FIRST tests for PUT /api/edges/[id] under the
 * no-same-direction-parallel-edges rule: an update that would land an edge on
 * an OCCUPIED direction slot is refused atomically.
 *
 * THE FEATURE. Two same-direction parallel edges between two nodes must not
 * exist (a UNIQUE index on edges(from_node_id, to_node_id) in the database
 * file). An update can collide with that rule two ways, and both must be
 * refused with a clear error naming the OCCUPYING edge's id, leaving the
 * edited edge's stored row untouched — no partial write, and no graph_events
 * journal row from the refused attempt:
 *  - explicit new ends aimed at an occupied slot, and
 *  - an explanation edit whose re-inference FLIPS the stored ends onto an
 *    occupied slot (updateEdgeSQLite re-infers a context.explanation edit and
 *    applies swap_direction to the STORED ends).
 *
 * Today neither refusal exists: the UPDATE goes through, storing a duplicate
 * slot occupant — these tests are RED until the slice lands.
 *
 * SEAM (the edgeSwapCollisionPin.test.ts idiom): a fresh temp-file database
 * per test via tempBeliefDatabase, with the route module imported dynamically
 * AFTER the temp database opens so it binds to the same client generation.
 * The flip is induced deterministically with a "Contains…" explanation (the
 * heuristic fast-path in edges.ts infers part_of with swap_direction: true,
 * no LLM involved).
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from '../belief/helpers/tempBeliefDatabase';

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// The reply shape PUT /api/edges/[id] answers with: the updated edge row on
// success, an error message on a refusal.
interface EdgeUpdateRouteReply {
  success: boolean;
  data?: { id?: number; from_node_id?: number; to_node_id?: number };
  error?: string;
  message?: string;
}

// An explanation whose "Contains…" prefix hits the deterministic heuristic
// classifier (part_of, swap_direction: true) — no LLM call, guaranteed flip
// of the stored ends on re-inference.
const FLIP_INDUCING_EXPLANATION = 'Contains the finding the derived claim rests on.';

// The id given to the edge already occupying the target slot. Deliberately
// far from every node id in these tests (nodes count from 1), so an error
// message that merely echoed a node id could never satisfy the
// names-the-occupying-edge assertion by coincidence.
const OCCUPYING_EDGE_DISTINCTIVE_ID = 7777;

// Drive the REST route's PUT handler directly with a JSON body, exactly as a
// caller's update arrives. Imported dynamically so the route binds to the
// current temp-database generation.
async function putEdgeUpdateThroughRestRoute(
  editedEdgeId: number,
  body: Record<string, unknown>
): Promise<Response> {
  const { PUT } = await import('../../../app/api/edges/[id]/route');
  const updateEdgeRequest = new Request(`http://127.0.0.1/api/edges/${editedEdgeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return PUT(updateEdgeRequest, { params: Promise.resolve({ id: String(editedEdgeId) }) });
}

// Insert the edge that already occupies the collision-target slot, with the
// distinctive id above, straight into the edges table.
function insertOccupyingEdgeWithDistinctiveId(
  context: TempBeliefDatabase,
  fromNodeId: number,
  toNodeId: number
): number {
  context.sqlite
    .prepare(
      `INSERT INTO edges (id, from_node_id, to_node_id, source, explanation)
       VALUES (?, ?, ?, 'user', 'the edge already occupying the direction slot')`
    )
    .run(OCCUPYING_EDGE_DISTINCTIVE_ID, fromNodeId, toNodeId);
  return OCCUPYING_EDGE_DISTINCTIVE_ID;
}

// Read one edge's ENTIRE stored row — every column SQLite holds for it — so a
// before/after comparison catches any partial write the refusal left behind,
// not just the columns a test happened to think of.
function readWholeStoredEdgeRow(
  context: TempBeliefDatabase,
  edgeId: number
): Record<string, unknown> {
  return context.sqlite
    .prepare('SELECT * FROM edges WHERE id = ?')
    .get(edgeId) as Record<string, unknown>;
}

// Count every row of the graph_events journal — the number that must not move
// across a refused update.
function countGraphEventJournalRows(context: TempBeliefDatabase): number {
  const countRow = context.sqlite
    .prepare('SELECT COUNT(*) AS journal_row_count FROM graph_events')
    .get() as { journal_row_count: number };
  return countRow.journal_row_count;
}

describe('PUT /api/edges/[id] refuses an update onto an occupied direction slot', () => {
  // The explicit case: the caller re-points the edited edge straight at ends
  // another edge already holds. The refusal must be a non-2xx answer whose
  // error names the OCCUPYING edge's id (so the caller can go look at it),
  // and the edited edge's stored row must be byte-unchanged.
  it('explicit new ends onto an occupied slot: non-2xx naming the occupying edge id, edited row byte-unchanged', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A, the derived end' });
    const sourceNodeBId = db.insertNodeFixture({ title: 'source node B the claim derives from' });
    const otherSourceNodeCId = db.insertNodeFixture({ title: 'other source node C' });
    // The occupied slot: A→B, held by the distinctively-numbered edge.
    const occupyingEdgeId = insertOccupyingEdgeWithDistinctiveId(db, claimNodeAId, sourceNodeBId);
    // The edited edge sits in its own slot, C→B, before the collision attempt.
    const editedEdgeId = db.insertNonEvidenceEdgeFixture({
      fromNodeId: otherSourceNodeCId,
      toNodeId: sourceNodeBId,
    });
    const editedEdgeRowBeforeRefusal = readWholeStoredEdgeRow(db, editedEdgeId);

    // The colliding update: explicit new ends aimed at the occupied A→B slot.
    const collidingUpdateResponse = await putEdgeUpdateThroughRestRoute(editedEdgeId, {
      from_node_id: claimNodeAId,
      to_node_id: sourceNodeBId,
    });

    // Refused, not applied — today this answers 200, which is this test's red.
    expect(
      collidingUpdateResponse.status,
      'an update onto an occupied slot must be refused with a non-2xx status'
    ).toBeGreaterThanOrEqual(400);
    const collidingUpdateReply = (await collidingUpdateResponse.json()) as EdgeUpdateRouteReply;
    expect(collidingUpdateReply.success).toBe(false);
    // The error names the edge already holding the slot, by id.
    expect(collidingUpdateReply.error).toMatch(new RegExp(`\\b${occupyingEdgeId}\\b`));

    // The edited edge's stored row is byte-unchanged: same ends, same
    // everything.
    expect(readWholeStoredEdgeRow(db, editedEdgeId)).toEqual(editedEdgeRowBeforeRefusal);
    // And the occupying edge still holds its slot alone.
    expect(readWholeStoredEdgeRow(db, occupyingEdgeId)).toMatchObject({
      from_node_id: claimNodeAId,
      to_node_id: sourceNodeBId,
    });
  });

  // The inference case: the caller edits only the PROSE, but re-inference of
  // the new explanation flips the stored ends ("Contains…" infers part_of
  // with swap_direction: true) — and the flip target is occupied. The refusal
  // must be ATOMIC: the edited edge keeps BOTH its old ends AND its old
  // explanation (no half-applied update where the prose landed but the flip
  // was refused, or vice versa), and the refused attempt writes NO
  // graph_events journal row — a refused re-orientation never happened, so it
  // must not be journalled as one.
  it('an explanation edit whose re-inference flips onto an occupied slot is refused atomically, journalling nothing', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A, the derived end' });
    const sourceNodeBId = db.insertNodeFixture({ title: 'source node B the claim derives from' });
    // The occupied slot: A→B, held by the distinctively-numbered edge.
    const occupyingEdgeId = insertOccupyingEdgeWithDistinctiveId(db, claimNodeAId, sourceNodeBId);
    // The edited edge is stored B→A; the "Contains…" re-inference will swap
    // its stored ends to A→B — exactly the occupied slot.
    const editedEdgeId = db.insertNonEvidenceEdgeFixture({
      fromNodeId: sourceNodeBId,
      toNodeId: claimNodeAId,
    });
    const editedEdgeRowBeforeRefusal = readWholeStoredEdgeRow(db, editedEdgeId);

    // Guard against a vacuous "no journal row": the graph_events table exists
    // (it has since the slice-2 journal), and its row count is snapshotted so
    // "gained nothing" is measured, not assumed.
    expect(
      db.hasTable('graph_events'),
      'graph_events must exist before a no-journal-row assertion means anything'
    ).toBe(true);
    const journalRowCountBeforeRefusal = countGraphEventJournalRows(db);

    // The colliding update: prose only — the flip comes from re-inference.
    const proseFlipUpdateResponse = await putEdgeUpdateThroughRestRoute(editedEdgeId, {
      context: { explanation: FLIP_INDUCING_EXPLANATION },
    });

    // Refused, not applied — today this answers 200 and flips the ends, which
    // is this test's red.
    expect(
      proseFlipUpdateResponse.status,
      'a prose edit whose re-inference lands on an occupied slot must be refused with a non-2xx status'
    ).toBeGreaterThanOrEqual(400);
    const proseFlipUpdateReply = (await proseFlipUpdateResponse.json()) as EdgeUpdateRouteReply;
    expect(proseFlipUpdateReply.success).toBe(false);
    // The error names the edge already holding the flip-target slot, by id.
    expect(proseFlipUpdateReply.error).toMatch(new RegExp(`\\b${occupyingEdgeId}\\b`));

    // ATOMICITY: the edited edge's whole stored row is unchanged — its old
    // B→A ends AND its old explanation both survive; neither half of the
    // update landed.
    expect(readWholeStoredEdgeRow(db, editedEdgeId)).toEqual(editedEdgeRowBeforeRefusal);

    // The refused attempt journalled nothing: no edge_reoriented (or any
    // other) row was added by an update that never happened.
    expect(countGraphEventJournalRows(db)).toBe(journalRowCountBeforeRefusal);
  });
});
