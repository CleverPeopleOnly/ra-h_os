/**
 * DISPLAY-BELIEF writes through the app: POST /api/belief/display
 * (app/api/belief/display/route.ts — new, this is the red).
 *
 * The remote MCP door's rah_write_display_belief is an HTTP proxy with no
 * database of its own, so it needs this app endpoint to forward to. samai —
 * the owner of the belief engine since the storage split — writes each node's
 * display belief here, and the endpoint is a PLAIN COLUMN WRITE with exactly
 * two legal shapes:
 *
 *  - a GRADE: belief_credence (number in [-1, 1]), belief_uncertainty
 *    (number in (0, 1]) and belief_computed_at (ISO-8601 string) ALL
 *    non-null — the three columns land verbatim,
 *  - an UNGRADE: all three null — the three columns clear together.
 *
 * Any mixture is refused with 400 and a message naming the two shapes. An
 * unknown node is refused with 404 naming the node. A FIXED node
 * (belief_credence_is_fixed = 1) is refused with 409 and a message naming
 * the flag — a hand-asserted credence is only changed through the
 * assert/clear tools. NEITHER legal write logs a belief_movements row:
 * movement history is samai's now.
 *
 * Seam: tests/unit/belief/helpers/tempBeliefDatabase.ts, with the route
 * module imported dynamically AFTER the temp database opens. The import path
 * names a module this slice must create, so today the import itself fails —
 * a feature-missing red, not a broken assertion.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from '../belief/helpers/tempBeliefDatabase';

// The reply a successful display write answers with: the stored row's four
// belief columns, exactly as they now stand.
interface DisplayBeliefWriteReply {
  success: boolean;
  node_id: number;
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
}

// The refusal shape every rejected write answers with.
interface DisplayBeliefRefusalReply {
  success: boolean;
  error: string;
}

// The grade this file writes on every happy path: an honest credence with the
// uncertainty samai derived beside it, stamped when samai computed it.
const WRITTEN_BELIEF_CREDENCE = 0.62;
const WRITTEN_BELIEF_UNCERTAINTY = 0.42;
const WRITTEN_BELIEF_COMPUTED_AT = '2026-08-05T10:00:00.000Z';

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

// Import the route module under test, bound to THIS temp-database generation.
async function importBeliefDisplayRoute() {
  return import('../../../app/api/belief/display/route');
}

// Drive the route's POST handler with a JSON body, as the door would call it.
async function postDisplayBelief(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await importBeliefDisplayRoute();
  const displayWriteRequest = new Request('http://127.0.0.1/api/belief/display', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(displayWriteRequest);
}

// Read one node's stored display-belief columns straight from the database.
function readStoredDisplayBeliefRow(nodeId: number): {
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
} {
  return tempBeliefDb.sqlite
    .prepare(
      `SELECT belief_credence, belief_uncertainty, belief_computed_at, belief_credence_is_fixed
       FROM nodes WHERE id = ?`
    )
    .get(nodeId) as ReturnType<typeof readStoredDisplayBeliefRow>;
}

// The GRADE body for one node, spread-and-overridden by the refusal tests.
function gradeBodyForNode(nodeId: number): Record<string, unknown> {
  return {
    node_id: nodeId,
    belief_credence: WRITTEN_BELIEF_CREDENCE,
    belief_uncertainty: WRITTEN_BELIEF_UNCERTAINTY,
    belief_computed_at: WRITTEN_BELIEF_COMPUTED_AT,
  };
}

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('POST /api/belief/display — the two legal shapes', () => {
  // The GRADE in one pass: the three columns land verbatim, the reply is the
  // stored row, and no movement is logged.
  it('a GRADE lands all three columns verbatim, answers the stored row, and logs no movement', async () => {
    const gradedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node samai grades' });

    const response = await postDisplayBelief(gradeBodyForNode(gradedNodeId));
    expect(response.status).toBe(200);
    const reply = (await response.json()) as DisplayBeliefWriteReply;
    expect(reply.success).toBe(true);
    expect(reply.node_id).toBe(gradedNodeId);
    expect(reply.belief_credence).toBe(WRITTEN_BELIEF_CREDENCE);
    expect(reply.belief_uncertainty).toBe(WRITTEN_BELIEF_UNCERTAINTY);
    expect(reply.belief_computed_at).toBe(WRITTEN_BELIEF_COMPUTED_AT);
    expect(reply.belief_credence_is_fixed).toBe(0);

    // The stored row is what the reply claimed it is.
    const storedRow = readStoredDisplayBeliefRow(gradedNodeId);
    expect(storedRow.belief_credence).toBe(WRITTEN_BELIEF_CREDENCE);
    expect(storedRow.belief_uncertainty).toBe(WRITTEN_BELIEF_UNCERTAINTY);
    expect(storedRow.belief_computed_at).toBe(WRITTEN_BELIEF_COMPUTED_AT);

    // Movement history is samai's now: a display write logs NOTHING.
    expect(tempBeliefDb.readBeliefMovements(gradedNodeId)).toHaveLength(0);
  });

  // The UNGRADE: all three columns clear together, and still no movement.
  it('an UNGRADE nulls all three columns, answers the stored nulls, and logs no movement', async () => {
    const gradedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node samai ungrades' });
    // Grade first through the route itself, so the ungrade has something to clear.
    await postDisplayBelief(gradeBodyForNode(gradedNodeId));

    const response = await postDisplayBelief({
      node_id: gradedNodeId,
      belief_credence: null,
      belief_uncertainty: null,
      belief_computed_at: null,
    });
    expect(response.status).toBe(200);
    const reply = (await response.json()) as DisplayBeliefWriteReply;
    expect(reply.success).toBe(true);
    expect(reply.belief_credence).toBeNull();
    expect(reply.belief_uncertainty).toBeNull();
    expect(reply.belief_computed_at).toBeNull();

    const storedRow = readStoredDisplayBeliefRow(gradedNodeId);
    expect(storedRow.belief_credence).toBeNull();
    expect(storedRow.belief_uncertainty).toBeNull();
    expect(storedRow.belief_computed_at).toBeNull();
    expect(tempBeliefDb.readBeliefMovements(gradedNodeId)).toHaveLength(0);
  });

  // The interval boundaries: credence lives in the CLOSED interval [-1, 1]
  // here (samai's engine may derive the endpoints), and uncertainty's top end
  // 1 is legal (assessed but resting on nothing).
  it('accepts credence -1 and +1 and uncertainty 1 — the closed boundaries are legal', async () => {
    const boundaryNodeId = tempBeliefDb.insertNodeFixture({ title: 'Boundary-grade node' });

    const fullDisbeliefResponse = await postDisplayBelief({
      ...gradeBodyForNode(boundaryNodeId),
      belief_credence: -1,
      belief_uncertainty: 1,
    });
    expect(fullDisbeliefResponse.status).toBe(200);

    const fullBeliefResponse = await postDisplayBelief({
      ...gradeBodyForNode(boundaryNodeId),
      belief_credence: 1,
    });
    expect(fullBeliefResponse.status).toBe(200);
    expect(readStoredDisplayBeliefRow(boundaryNodeId).belief_credence).toBe(1);
  });
});

describe('POST /api/belief/display — refusals', () => {
  // A mixture is neither shape: refused with 400 and a message naming the two
  // legal shapes, and the stored row untouched.
  it('refuses a mixture of nulls and values with 400 naming the two shapes, writing nothing', async () => {
    const untouchedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node a mixture aims at' });

    const response = await postDisplayBelief({
      node_id: untouchedNodeId,
      belief_credence: WRITTEN_BELIEF_CREDENCE,
      belief_uncertainty: null,
      belief_computed_at: null,
    });
    expect(response.status).toBe(400);
    const refusal = (await response.json()) as DisplayBeliefRefusalReply;
    expect(refusal.success).toBe(false);
    // The message must name both legal shapes: all three non-null, or all
    // three null.
    expect(refusal.error).toMatch(/all three/i);

    // Nothing landed.
    const storedRow = readStoredDisplayBeliefRow(untouchedNodeId);
    expect(storedRow.belief_credence).toBeNull();
    expect(storedRow.belief_computed_at).toBeNull();
  });

  // Uncertainty's interval is OPEN at 0: 0 is the dogmatic opinion, reserved
  // for a hand-asserted credence, so samai may never write it.
  it('refuses belief_uncertainty 0 with 400 — the dogmatic opinion is not writable here', async () => {
    const untouchedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node a zero aims at' });

    const response = await postDisplayBelief({
      ...gradeBodyForNode(untouchedNodeId),
      belief_uncertainty: 0,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as DisplayBeliefRefusalReply).success).toBe(false);
  });

  // Out-of-interval numbers are refused before anything is written.
  it('refuses a credence beyond the interval and an uncertainty above 1 with 400', async () => {
    const untouchedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node bad numbers aim at' });

    const oversizedCredenceResponse = await postDisplayBelief({
      ...gradeBodyForNode(untouchedNodeId),
      belief_credence: 1.5,
    });
    expect(oversizedCredenceResponse.status).toBe(400);

    const oversizedUncertaintyResponse = await postDisplayBelief({
      ...gradeBodyForNode(untouchedNodeId),
      belief_uncertainty: 1.5,
    });
    expect(oversizedUncertaintyResponse.status).toBe(400);
  });

  // A body that cannot name its node writes about nothing.
  it('refuses a missing or non-numeric node_id with 400', async () => {
    const missingNodeIdResponse = await postDisplayBelief({
      belief_credence: null,
      belief_uncertainty: null,
      belief_computed_at: null,
    });
    expect(missingNodeIdResponse.status).toBe(400);

    const stringNodeIdResponse = await postDisplayBelief({
      ...gradeBodyForNode(1),
      node_id: 'not-a-node',
    });
    expect(stringNodeIdResponse.status).toBe(400);
  });

  // An unknown node is an error naming the node — never a silent no-op.
  it('refuses an unknown node with 404 naming it', async () => {
    const response = await postDisplayBelief(gradeBodyForNode(424242));
    expect(response.status).toBe(404);
    const refusal = (await response.json()) as DisplayBeliefRefusalReply;
    expect(refusal.success).toBe(false);
    expect(refusal.error).toContain('424242');
  });

  // A FIXED node's credence is hand-asserted: only the assert/clear tools may
  // change it, so a display write is refused naming the flag — 409, because
  // the request was well-formed and the stored state is what refuses it.
  it('refuses a fixed node with 409 naming belief_credence_is_fixed, writing nothing', async () => {
    const fixedNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
      title: 'Node whose credence a human asserted',
      beliefCredence: -0.4,
    });

    const response = await postDisplayBelief(gradeBodyForNode(fixedNodeId));
    expect(response.status).toBe(409);
    const refusal = (await response.json()) as DisplayBeliefRefusalReply;
    expect(refusal.success).toBe(false);
    expect(refusal.error).toContain('belief_credence_is_fixed');

    // The asserted credence survives untouched.
    const storedRow = readStoredDisplayBeliefRow(fixedNodeId);
    expect(storedRow.belief_credence).toBeCloseTo(-0.4, 12);
    expect(storedRow.belief_credence_is_fixed).toBe(1);
  });
});
