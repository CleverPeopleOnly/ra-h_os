/**
 * FAILING-FIRST tests for the duplicate branch of POST /api/edges
 * (app/api/edges/route.ts): when a same-direction edge already occupies the
 * slot, the short-circuit must answer the EXISTING edge's full stored row.
 *
 * WHY. Today that branch answers success:true with an "Edge already exists"
 * message and `data` carrying ONLY the two node ids — no id of the existing
 * edge, no stored explanation. The remote MCP door builds its rah_create_edge
 * answer from this reply, so with no id to relay it answers `edgeId: 0` — an
 * id that names no edge. This slice makes the branch answer honestly:
 * UNCHANGED semantics (still 200, still success:true, still the already-exists
 * message, still no row written), but `data` becomes the existing edge's row —
 * at minimum id, from_node_id, to_node_id, explanation, in the stored
 * orientation. The door-side relay of this reply is pinned in
 * tests/unit/mcp/remote-mcp-route-edge-write-answers-carry-stored-row.test.ts.
 *
 * KNOWN CONFLICT, left untouched: tests/unit/belief/edgeSwapCollisionPin.test.ts
 * ("a same-direction duplicate is answered success-with-message, no id…")
 * CHARACTERIZES today's dishonest shape — it asserts `data` equals exactly the
 * two node ids and carries no id key. That pin and this file cannot both pass;
 * the Reviewer decides which stands before implementation starts.
 *
 * Seam (same as edgeSwapCollisionPin.test.ts): a fresh temp-file database per
 * test via tempBeliefDatabase, with the route module imported dynamically
 * AFTER the temp database opens so it binds to the same client generation.
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

// The reply shape this slice pins for the duplicate short-circuit: `data` is
// the EXISTING edge's stored row, no longer just the two node ids, and
// `already_existed` says structurally that nothing new was written — the
// indication the MCP doors relay, so a caller never has to parse the message.
interface DuplicateEdgeCreateReply {
  success: boolean;
  already_existed?: boolean;
  data?: {
    id?: number;
    from_node_id: number;
    to_node_id: number;
    explanation?: string | null;
  };
  message?: string;
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
// aimed at the given ends. The explanation is prose the classifier stores
// as-written ("Related to…" infers related_to, no swap) and specific enough to
// pass the route's edge-explanation quality check, so the request reaches the
// duplicate guard rather than being refused earlier.
function buildConfirmedDuplicateEdgeBody(
  fromNodeId: number,
  toNodeId: number
): Record<string, unknown> {
  return {
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    explanation: 'Related to the neighbouring claim by a measured result.',
    source: 'user',
    created_via: 'mcp',
    confirmed_by_user: true,
  };
}

// Count the stored rows occupying one exact direction slot, straight from
// SQLite — proof the guard still writes nothing.
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

describe('POST /api/edges duplicate short-circuit answers the existing row', () => {
  // The core lie fixed at its source: the answer must name the EXISTING
  // edge's real id, because the id is what a caller (and the MCP door built
  // on this reply) needs to follow up on the edge that actually exists.
  it('answers the existing edge real id on a same-direction duplicate', async () => {
    db = await openTempBeliefDatabase();
    // A is the from-end, B the to-end of the occupied slot.
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A, the occupied slot from-end' });
    const sourceNodeBId = db.insertNodeFixture({ title: 'source node B, the occupied slot to-end' });
    // The edge that already occupies the A→B slot; the id the answer must name.
    const existingEdgeId = db.insertNonEvidenceEdgeFixture({
      fromNodeId: claimNodeAId,
      toNodeId: sourceNodeBId,
    });

    // The refused write: same direction as the stored edge.
    const duplicateWriteResponse = await postEdgeThroughRestRoute(
      buildConfirmedDuplicateEdgeBody(claimNodeAId, sourceNodeBId)
    );

    // UNCHANGED semantics: 200, success, the already-exists message.
    expect(duplicateWriteResponse.status).toBe(200);
    const duplicateWriteReply = (await duplicateWriteResponse.json()) as DuplicateEdgeCreateReply;
    expect(duplicateWriteReply.success).toBe(true);
    expect(duplicateWriteReply.message).toMatch(/already exists/i);
    // The structural indication the MCP doors relay: nothing new was written.
    expect(
      duplicateWriteReply.already_existed,
      'the duplicate answer must say already_existed: true'
    ).toBe(true);
    // The honest part: the existing edge's real id, present and correct.
    expect(
      duplicateWriteReply.data?.id,
      'the duplicate answer must carry the EXISTING edge id'
    ).toBe(existingEdgeId);
    // And still nothing written: the guard's refusal itself is unchanged.
    expect(countStoredEdgeRowsInSlot(db, claimNodeAId, sourceNodeBId)).toBe(1);
  });

  // Beyond the id, the answer must be the stored ROW: the ends in the stored
  // orientation and the stored explanation — the recorded reasoning of the
  // edge that exists, not an echo of the refused request's prose.
  it('answers the existing edge full stored row, not an echo of the refused request', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeAId = db.insertNodeFixture({ title: 'claim node A, the occupied slot from-end' });
    const sourceNodeBId = db.insertNodeFixture({ title: 'source node B, the occupied slot to-end' });
    // The occupying edge; the fixture stores the explanation
    // 'plain non-evidence edge fixture', which deliberately differs from the
    // refused request's prose so an echo cannot pass as the stored row.
    const existingEdgeId = db.insertNonEvidenceEdgeFixture({
      fromNodeId: claimNodeAId,
      toNodeId: sourceNodeBId,
    });

    const duplicateWriteResponse = await postEdgeThroughRestRoute(
      buildConfirmedDuplicateEdgeBody(claimNodeAId, sourceNodeBId)
    );

    expect(duplicateWriteResponse.status).toBe(200);
    const duplicateWriteReply = (await duplicateWriteResponse.json()) as DuplicateEdgeCreateReply;
    // The stored row: real id, stored orientation, stored prose.
    expect(duplicateWriteReply.data).toMatchObject({
      id: existingEdgeId,
      from_node_id: claimNodeAId,
      to_node_id: sourceNodeBId,
      explanation: 'plain non-evidence edge fixture',
    });
  });
});
