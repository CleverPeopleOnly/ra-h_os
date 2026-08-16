/**
 * FIXED-CREDENCE writes through the app: POST /api/belief/fixed (the hand
 * assertion) and POST /api/belief/fixed/clear (its withdrawal) — both new,
 * this is the red.
 *
 * Since the belief-storage split NOTHING in the fork can set or clear
 * belief_credence_is_fixed: the old machinery left with the engine and the
 * column is write-orphaned. Yet a hand-asserted credence is the one credence
 * bootstrap the whole belief model has — samai's projection can never output
 * uncertainty 0, because a fixed credence is decreed, not derived — so the
 * app grows two endpoints the remote MCP door will forward to:
 *
 *  - the ASSERTION lands all four columns in ONE act: belief_credence
 *    verbatim (OPEN interval −1 < c < 1 — the open interval belongs to a
 *    hand assertion, unlike the display write's closed one),
 *    belief_uncertainty 0 (the dogmatic opinion — supplied by the ROUTE,
 *    never the caller, so an illegal combination cannot be requested),
 *    belief_computed_at verbatim (samai stamps the instant, the store lands
 *    it), belief_credence_is_fixed 1,
 *  - the CLEAR drops the flag and NOTHING else: this store never grades, so
 *    the regrade after a clear is samai's, done through the display write
 *    afterwards — the three display columns keep the stale hand-asserted
 *    figures.
 *
 * Refusals mirror the display write's: an unknown node is 404 naming the
 * node; asserting over an already-fixed node is 409 naming
 * belief_credence_is_fixed (re-asserting requires an explicit clear first);
 * clearing an unfixed node is 409 named plainly — a caller error, never a
 * silent no-op. Every answer carries the STORED row's four belief columns
 * read back, never an echo of the request.
 *
 * Seam: tests/unit/belief/helpers/tempBeliefDatabase.ts, with the route
 * modules imported dynamically AFTER the temp database opens. The import
 * paths name modules this slice must create, so today the imports themselves
 * fail — a feature-missing red, not a broken assertion (the same red shape
 * beliefDisplayRoute.test.ts started from).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from '../belief/helpers/tempBeliefDatabase';

// The reply a successful fixed-credence write (assert or clear) answers with:
// the stored row's four belief columns, exactly as they now stand.
interface FixedCredenceWriteReply {
  success: boolean;
  node_id: number;
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  message: string;
}

// The refusal shape every rejected write answers with.
interface FixedCredenceRefusalReply {
  success: boolean;
  error: string;
}

// The hand assertion this file lands on every happy path: the decreed
// credence and the instant samai stamped it.
const ASSERTED_BELIEF_CREDENCE = 0.73;
const ASSERTED_BELIEF_COMPUTED_AT = '2026-08-12T09:00:00.000Z';

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

// Import the assertion route module under test, bound to THIS temp-database
// generation. The module does not exist yet — that failure is the red.
async function importFixedCredenceAssertRoute() {
  return import('../../../app/api/belief/fixed/route');
}

// Import the clear route module under test, bound to the same generation.
async function importFixedCredenceClearRoute() {
  return import('../../../app/api/belief/fixed/clear/route');
}

// Import the EXISTING display route, for the interlock tests that prove the
// flag the new routes move is the very flag the display write obeys.
async function importBeliefDisplayRoute() {
  return import('../../../app/api/belief/display/route');
}

// Drive the assertion route's POST handler with a JSON body, as the door
// would call it.
async function postAssertFixedCredence(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await importFixedCredenceAssertRoute();
  const assertRequest = new Request('http://127.0.0.1/api/belief/fixed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(assertRequest);
}

// Drive the clear route's POST handler the same way.
async function postClearFixedCredence(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await importFixedCredenceClearRoute();
  const clearRequest = new Request('http://127.0.0.1/api/belief/fixed/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(clearRequest);
}

// Drive the existing display route, for the interlock tests.
async function postDisplayBelief(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await importBeliefDisplayRoute();
  const displayWriteRequest = new Request('http://127.0.0.1/api/belief/display', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(displayWriteRequest);
}

// Read one node's stored belief columns straight from the database — the
// ground truth every reply is checked against.
function readStoredBeliefRow(nodeId: number): {
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
    .get(nodeId) as ReturnType<typeof readStoredBeliefRow>;
}

// The well-formed assertion body for one node, spread-and-overridden by the
// refusal tests.
function assertionBodyForNode(nodeId: number): Record<string, unknown> {
  return {
    node_id: nodeId,
    belief_credence: ASSERTED_BELIEF_CREDENCE,
    belief_computed_at: ASSERTED_BELIEF_COMPUTED_AT,
  };
}

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('POST /api/belief/fixed — the hand assertion', () => {
  // The whole assertion in ONE act: the caller sends a node, a credence and a
  // stamp, and the stored row comes out carrying all FOUR columns — credence
  // verbatim, uncertainty 0, stamp verbatim, flag 1. No sequence of writes
  // can be caught halfway.
  it('lands all four columns in one act: credence verbatim, uncertainty 0, stamp verbatim, flag 1', async () => {
    const assertedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node a human asserts' });

    const response = await postAssertFixedCredence(assertionBodyForNode(assertedNodeId));
    expect(response.status).toBe(200);

    // The STORED row is the assertion's real output — asserted from the
    // database, not from the reply.
    const storedRow = readStoredBeliefRow(assertedNodeId);
    expect(storedRow.belief_credence).toBe(ASSERTED_BELIEF_CREDENCE);
    expect(storedRow.belief_uncertainty).toBe(0);
    expect(storedRow.belief_computed_at).toBe(ASSERTED_BELIEF_COMPUTED_AT);
    expect(storedRow.belief_credence_is_fixed).toBe(1);
  });

  // The reply is the stored row read back, never an echo: it reports
  // belief_uncertainty 0 and belief_credence_is_fixed 1 — two figures the
  // request never carried, so they can only have come from the row the route
  // read back after writing.
  it('answers the stored row read back, not an echo of the request', async () => {
    const assertedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node whose reply is read back' });

    const response = await postAssertFixedCredence(assertionBodyForNode(assertedNodeId));
    expect(response.status).toBe(200);
    const reply = (await response.json()) as FixedCredenceWriteReply;
    expect(reply.success).toBe(true);
    expect(reply.node_id).toBe(assertedNodeId);
    expect(typeof reply.message).toBe('string');

    // Field for field, the reply is the stored row.
    const storedRow = readStoredBeliefRow(assertedNodeId);
    expect(reply.belief_credence).toBe(storedRow.belief_credence);
    expect(reply.belief_uncertainty).toBe(storedRow.belief_uncertainty);
    expect(reply.belief_computed_at).toBe(storedRow.belief_computed_at);
    expect(reply.belief_credence_is_fixed).toBe(storedRow.belief_credence_is_fixed);
    // And the two route-owned figures are there even though the request
    // never sent them.
    expect(reply.belief_uncertainty).toBe(0);
    expect(reply.belief_credence_is_fixed).toBe(1);
  });

  // A hand assertion may disbelieve: the credence is signed, and a negative
  // figure lands exactly as a positive one does.
  it('accepts a negative credence — a hand assertion may disbelieve', async () => {
    const disbelievedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node a human disbelieves' });

    const response = await postAssertFixedCredence({
      ...assertionBodyForNode(disbelievedNodeId),
      belief_credence: -0.85,
    });
    expect(response.status).toBe(200);

    const storedRow = readStoredBeliefRow(disbelievedNodeId);
    expect(storedRow.belief_credence).toBe(-0.85);
    expect(storedRow.belief_credence_is_fixed).toBe(1);
  });

  // Credence's interval is OPEN here, unlike the display write's closed one:
  // the endpoints belong to derivation, not decree, so −1 and 1 are refused —
  // and anything beyond them with them — before a row is touched.
  it('refuses credence at or beyond the closed endpoints with 400 — the open interval belongs to a hand assertion', async () => {
    const untouchedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node endpoint credences aim at' });

    for (const refusedCredence of [-1, 1, 1.5, -1.5]) {
      const response = await postAssertFixedCredence({
        ...assertionBodyForNode(untouchedNodeId),
        belief_credence: refusedCredence,
      });
      expect(response.status, `credence ${refusedCredence} must be refused`).toBe(400);
    }

    // Nothing landed: the node is still unfixed and ungraded.
    const storedRow = readStoredBeliefRow(untouchedNodeId);
    expect(storedRow.belief_credence).toBeNull();
    expect(storedRow.belief_credence_is_fixed).toBe(0);
  });

  // The route owns belief_uncertainty (always 0 on an assertion) and
  // belief_credence_is_fixed (always 1): a body that tries to supply either
  // is refused rather than silently overridden — refused, never
  // reinterpreted, the same rule the display route applies to its ranges.
  it('refuses a body supplying belief_uncertainty or belief_credence_is_fixed with 400 — the route owns those figures', async () => {
    const untouchedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node a smuggled figure aims at' });

    const smuggledUncertaintyResponse = await postAssertFixedCredence({
      ...assertionBodyForNode(untouchedNodeId),
      belief_uncertainty: 0.5,
    });
    expect(smuggledUncertaintyResponse.status).toBe(400);

    const smuggledFlagResponse = await postAssertFixedCredence({
      ...assertionBodyForNode(untouchedNodeId),
      belief_credence_is_fixed: 1,
    });
    expect(smuggledFlagResponse.status).toBe(400);

    // Neither smuggle landed anything.
    expect(readStoredBeliefRow(untouchedNodeId).belief_credence_is_fixed).toBe(0);
  });

  // A body that cannot name its node, name its credence, or stamp its
  // instant asserts nothing: each malformed field is refused with 400.
  it('refuses a malformed node_id, a missing credence, and an unparseable stamp with 400', async () => {
    const untouchedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node malformed bodies aim at' });

    // A node_id that is not a positive integer.
    const stringNodeIdResponse = await postAssertFixedCredence({
      ...assertionBodyForNode(untouchedNodeId),
      node_id: 'not-a-node',
    });
    expect(stringNodeIdResponse.status).toBe(400);

    // No credence at all: there is no default decree.
    const missingCredenceResponse = await postAssertFixedCredence({
      node_id: untouchedNodeId,
      belief_computed_at: ASSERTED_BELIEF_COMPUTED_AT,
    });
    expect(missingCredenceResponse.status).toBe(400);

    // A stamp that does not parse is refused, never normalised — the store
    // lands samai's instant verbatim or not at all.
    const unparseableStampResponse = await postAssertFixedCredence({
      ...assertionBodyForNode(untouchedNodeId),
      belief_computed_at: 'not-an-instant',
    });
    expect(unparseableStampResponse.status).toBe(400);

    // No stamp at all: samai stamps the instant, so a stampless assertion is
    // incomplete.
    const missingStampResponse = await postAssertFixedCredence({
      node_id: untouchedNodeId,
      belief_credence: ASSERTED_BELIEF_CREDENCE,
    });
    expect(missingStampResponse.status).toBe(400);

    expect(readStoredBeliefRow(untouchedNodeId).belief_credence_is_fixed).toBe(0);
  });

  // An unknown node is an error naming the node — never a silent no-op.
  it('refuses an unknown node with 404 naming it', async () => {
    const response = await postAssertFixedCredence(assertionBodyForNode(424242));
    expect(response.status).toBe(404);
    const refusal = (await response.json()) as FixedCredenceRefusalReply;
    expect(refusal.success).toBe(false);
    expect(refusal.error).toContain('424242');
  });

  // Re-asserting over a standing assertion requires an explicit clear first:
  // an already-fixed node refuses a second decree with 409 naming the flag,
  // and the standing figures survive untouched.
  it('refuses an already-fixed node with 409 naming belief_credence_is_fixed, writing nothing', async () => {
    const alreadyFixedNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
      title: 'Node already asserted by hand',
      beliefCredence: -0.4,
    });
    const storedRowBeforeRefusal = readStoredBeliefRow(alreadyFixedNodeId);

    const response = await postAssertFixedCredence(assertionBodyForNode(alreadyFixedNodeId));
    expect(response.status).toBe(409);
    const refusal = (await response.json()) as FixedCredenceRefusalReply;
    expect(refusal.success).toBe(false);
    expect(refusal.error).toContain('belief_credence_is_fixed');

    // The standing assertion is exactly as it stood.
    expect(readStoredBeliefRow(alreadyFixedNodeId)).toEqual(storedRowBeforeRefusal);
  });
});

describe('POST /api/belief/fixed/clear — withdrawing the assertion', () => {
  // The clear drops the flag and ONLY the flag: this store never grades, so
  // the regrade after a clear is samai's, done through the display write
  // afterwards — the three display columns keep the stale hand-asserted
  // figures until then.
  it('drops the flag and only the flag — the three display columns keep the hand-asserted figures', async () => {
    const assertedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node asserted then cleared' });
    // Assert through the route itself — the only legitimate setter — so the
    // clear withdraws a real assertion.
    await postAssertFixedCredence(assertionBodyForNode(assertedNodeId));

    const response = await postClearFixedCredence({ node_id: assertedNodeId });
    expect(response.status).toBe(200);
    const reply = (await response.json()) as FixedCredenceWriteReply;
    expect(reply.success).toBe(true);
    expect(reply.node_id).toBe(assertedNodeId);
    // The reply is the stored row as it now stands: flag down, figures stale.
    expect(reply.belief_credence_is_fixed).toBe(0);
    expect(reply.belief_credence).toBe(ASSERTED_BELIEF_CREDENCE);
    expect(reply.belief_uncertainty).toBe(0);
    expect(reply.belief_computed_at).toBe(ASSERTED_BELIEF_COMPUTED_AT);

    // And the stored row says the same thing.
    const storedRow = readStoredBeliefRow(assertedNodeId);
    expect(storedRow.belief_credence_is_fixed).toBe(0);
    expect(storedRow.belief_credence).toBe(ASSERTED_BELIEF_CREDENCE);
    expect(storedRow.belief_uncertainty).toBe(0);
    expect(storedRow.belief_computed_at).toBe(ASSERTED_BELIEF_COMPUTED_AT);
  });

  // An unknown node is an error naming the node, exactly as on the assertion.
  it('refuses an unknown node with 404 naming it', async () => {
    const response = await postClearFixedCredence({ node_id: 424242 });
    expect(response.status).toBe(404);
    const refusal = (await response.json()) as FixedCredenceRefusalReply;
    expect(refusal.success).toBe(false);
    expect(refusal.error).toContain('424242');
  });

  // Clearing a node nobody asserted is a caller error, named plainly — 409,
  // because the request was well-formed and the stored state is what refuses
  // it, the same reasoning as the display write's fixed-node refusal.
  it('refuses an unfixed node with 409 saying plainly the node is not fixed', async () => {
    const unfixedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node nobody asserted' });

    const response = await postClearFixedCredence({ node_id: unfixedNodeId });
    expect(response.status).toBe(409);
    const refusal = (await response.json()) as FixedCredenceRefusalReply;
    expect(refusal.success).toBe(false);
    expect(refusal.error).toContain(String(unfixedNodeId));
    expect(refusal.error).toMatch(/not fixed/i);
  });
});

describe('the interlock the fixed routes share with the display write', () => {
  // The flag the new route raises is the very flag the display write obeys:
  // after an assertion through the ONLY legitimate setter, a display write is
  // refused with the existing fixed-node 409 — pinning the interlock with a
  // flag set through the new route, not a fixture's hand-planted one.
  it('after an assert, a display write is refused with the fixed-node 409', async () => {
    const assertedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Node the display write must not overwrite' });
    await postAssertFixedCredence(assertionBodyForNode(assertedNodeId));

    const displayWriteResponse = await postDisplayBelief({
      node_id: assertedNodeId,
      belief_credence: 0.1,
      belief_uncertainty: 0.9,
      belief_computed_at: '2026-08-13T00:00:00.000Z',
    });
    expect(displayWriteResponse.status).toBe(409);
    const refusal = (await displayWriteResponse.json()) as FixedCredenceRefusalReply;
    expect(refusal.error).toContain('belief_credence_is_fixed');

    // The decreed figures survive the attempt.
    const storedRow = readStoredBeliefRow(assertedNodeId);
    expect(storedRow.belief_credence).toBe(ASSERTED_BELIEF_CREDENCE);
    expect(storedRow.belief_uncertainty).toBe(0);
    expect(storedRow.belief_credence_is_fixed).toBe(1);
  });

  // The other side of the interlock: the display write's refusal was the
  // flag's doing and nothing else's, so once the clear drops the flag the
  // very same display write succeeds and samai's regrade lands.
  it('after a clear, a display write to the node succeeds — the refusal was the flag\'s doing', async () => {
    const clearedNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
      title: 'Node cleared then regraded',
      beliefCredence: -0.4,
    });
    const clearResponse = await postClearFixedCredence({ node_id: clearedNodeId });
    expect(clearResponse.status).toBe(200);

    const displayWriteResponse = await postDisplayBelief({
      node_id: clearedNodeId,
      belief_credence: 0.25,
      belief_uncertainty: 0.8,
      belief_computed_at: '2026-08-13T00:00:00.000Z',
    });
    expect(displayWriteResponse.status).toBe(200);

    // samai's regrade is now the stored row, flag still down.
    const storedRow = readStoredBeliefRow(clearedNodeId);
    expect(storedRow.belief_credence).toBe(0.25);
    expect(storedRow.belief_uncertainty).toBe(0.8);
    expect(storedRow.belief_credence_is_fixed).toBe(0);
  });
});
