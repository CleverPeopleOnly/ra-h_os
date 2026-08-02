/**
 * FIXED-CREDENCE writes through the app: POST /api/belief/fixed-credence
 * (app/api/belief/fixed-credence/route.ts — new, this is the red).
 *
 * Both app-backed MCP doors are HTTP proxies with no database of their own,
 * so the new rah_set_belief_fixed_credence tool needs an app endpoint to
 * forward to. This route is the app-side twin of the standalone door's
 * setBeliefFixedCredence and must behave identically:
 *
 *  - it sets nodes.belief_credence to the asserted number, marks
 *    belief_credence_is_fixed = 1 and stamps belief_computed_at,
 *  - it appends a belief_movements row with trigger
 *    'belief-fixed-credence-set' ONLY when the credence actually changed —
 *    re-asserting the same number is not a change and logs nothing,
 *  - an unknown node is refused with 404 and an error naming the node,
 *  - a credence at or beyond ±1 is refused with 400 and nothing is written:
 *    the interval is OPEN because total certainty is not expressible. The
 *    doors' schemas refuse these too, but the app is a public surface of its
 *    own and must not rely on a well-behaved caller.
 *
 * Seam: tests/unit/belief/helpers/tempBeliefDatabase.ts, with the route
 * module imported dynamically AFTER the temp database opens so it binds to
 * the same fresh sqlite-client generation. The import path is the module
 * this MR must create, so today the import itself fails — a feature-missing
 * red, not a broken assertion.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from '../belief/helpers/tempBeliefDatabase';

// The success payload the route must answer with — the standalone door's
// reply shape, which the MCP doors pass through to their callers.
interface BeliefFixedCredenceSetReply {
  success: boolean;
  node_id: number;
  belief_credence: number;
  belief_credence_is_fixed: number;
  belief_computed_at: string;
  message: string;
}

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

// Import the route module under test, bound to THIS temp-database
// generation. The literal path names a module that does not exist yet.
async function importBeliefFixedCredenceRoute() {
  return import('../../../app/api/belief/fixed-credence/route');
}

// Drive the route's POST handler with a JSON body, exactly as the app would
// receive it from a door.
async function postFixedCredenceAssertion(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await importBeliefFixedCredenceRoute();
  const fixedCredenceSetRequest = new Request('http://127.0.0.1/api/belief/fixed-credence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(fixedCredenceSetRequest);
}

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('POST /api/belief/fixed-credence', () => {
  // The whole write in one pass: node columns, movement row, and the reply.
  it('asserts a credence on an ungraded node, stamps it fixed, and logs one movement', async () => {
    const assertedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Node about to receive an asserted credence',
    });

    const routeResponse = await postFixedCredenceAssertion({
      node_id: assertedNodeId,
      belief_credence: 0.7,
    });
    expect(routeResponse.status).toBe(200);
    const setReply = (await routeResponse.json()) as BeliefFixedCredenceSetReply;

    // The reply mirrors the standalone door's shape, field for field.
    expect(setReply.success).toBe(true);
    expect(setReply.node_id).toBe(assertedNodeId);
    expect(setReply.belief_credence).toBe(0.7);
    expect(setReply.belief_credence_is_fixed).toBe(1);
    expect(typeof setReply.belief_computed_at).toBe('string');
    expect(typeof setReply.message).toBe('string');

    // The node now carries the asserted credence, flagged as fixed.
    expect(tempBeliefDb.readNodeBelief(assertedNodeId)).toEqual({
      belief_credence: 0.7,
      belief_computed_at: setReply.belief_computed_at,
    });
    expect(tempBeliefDb.readNodeBeliefCredenceIsFixed(assertedNodeId)).toBe(1);

    // Exactly one movement: from ungraded (null — never 0) to the assertion.
    const beliefMovements = tempBeliefDb.readBeliefMovements(assertedNodeId);
    expect(beliefMovements).toHaveLength(1);
    expect(beliefMovements[0]).toMatchObject({
      from_credence: null,
      to_credence: 0.7,
      trigger: 'belief-fixed-credence-set',
    });
    // One timestamp shared by the node stamp and the movement row.
    expect(beliefMovements[0].occurred_at).toBe(setReply.belief_computed_at);
  });

  // Re-asserting a DIFFERENT credence replaces it in place and logs the
  // change, recording where the credence came from.
  it('logs a second movement when the asserted credence changes', async () => {
    const reassertedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Node whose asserted credence is corrected',
    });
    await postFixedCredenceAssertion({ node_id: reassertedNodeId, belief_credence: 0.7 });

    const secondSetResponse = await postFixedCredenceAssertion({
      node_id: reassertedNodeId,
      belief_credence: -0.2,
    });
    expect(secondSetResponse.status).toBe(200);

    expect(tempBeliefDb.readNodeBelief(reassertedNodeId).belief_credence).toBe(-0.2);
    const beliefMovements = tempBeliefDb.readBeliefMovements(reassertedNodeId);
    expect(beliefMovements).toHaveLength(2);
    expect(beliefMovements[1]).toMatchObject({
      from_credence: 0.7,
      to_credence: -0.2,
      trigger: 'belief-fixed-credence-set',
    });
  });

  // A movement records the credence CHANGING; re-asserting the same literal
  // number is not a change, so the second call succeeds but logs nothing.
  it('writes NO second movement when the same credence is asserted twice', async () => {
    const twiceAssertedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Node asserted to the same credence twice',
    });
    await postFixedCredenceAssertion({ node_id: twiceAssertedNodeId, belief_credence: 0.5 });

    const repeatSetResponse = await postFixedCredenceAssertion({
      node_id: twiceAssertedNodeId,
      belief_credence: 0.5,
    });

    // Still a success — the assertion stands — but the log gains nothing.
    expect(repeatSetResponse.status).toBe(200);
    const repeatReply = (await repeatSetResponse.json()) as BeliefFixedCredenceSetReply;
    expect(repeatReply.success).toBe(true);
    expect(tempBeliefDb.readBeliefMovements(twiceAssertedNodeId)).toHaveLength(1);
  });

  // An unknown node is an error, never a silent no-op: asserting a credence
  // about nothing must tell the caller so, naming the node it looked for.
  it('refuses an unknown node with 404 and an error naming the node, writing nothing', async () => {
    // A node id no fixture created, so the route cannot find it.
    const unknownNodeId = 424242;

    const missingNodeResponse = await postFixedCredenceAssertion({
      node_id: unknownNodeId,
      belief_credence: 0.5,
    });

    expect(missingNodeResponse.status).toBe(404);
    const missingNodeReply = (await missingNodeResponse.json()) as {
      success: boolean;
      error: string;
    };
    expect(missingNodeReply.success).toBe(false);
    expect(missingNodeReply.error).toContain(String(unknownNodeId));
    // Nothing was logged for the node that does not exist.
    expect(tempBeliefDb.readBeliefMovements(unknownNodeId)).toHaveLength(0);
  });

  // The open interval is enforced by the app itself, not only by the doors'
  // schemas: ±1 would claim total certainty, which is not expressible.
  it('refuses a credence at or beyond the interval endpoints with 400 and writes nothing', async () => {
    const guardedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Node guarded from a total-certainty assertion',
    });

    for (const rejectedCredence of [1, -1, 1.5, -2]) {
      const rejectedSetResponse = await postFixedCredenceAssertion({
        node_id: guardedNodeId,
        belief_credence: rejectedCredence,
      });
      expect(
        rejectedSetResponse.status,
        `a credence of ${rejectedCredence} must be refused`
      ).toBe(400);
    }

    // The node is untouched: still ungraded, still unfixed, nothing logged.
    expect(tempBeliefDb.readNodeBelief(guardedNodeId).belief_credence).toBeNull();
    expect(tempBeliefDb.readNodeBeliefCredenceIsFixed(guardedNodeId)).toBe(0);
    expect(tempBeliefDb.readBeliefMovements(guardedNodeId)).toHaveLength(0);
  });

  // A malformed body never reaches the database: no node, no credence, or a
  // credence that is not a number at all are each a 400.
  it('refuses a body missing node_id, missing belief_credence, or carrying a non-number', async () => {
    const wellFormedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Node protected from malformed assertions',
    });

    // Each malformed body alongside why it must be refused.
    const malformedAssertionBodies: Array<[Record<string, unknown>, string]> = [
      [{ belief_credence: 0.5 }, 'a body without node_id asserts about nothing'],
      [{ node_id: wellFormedNodeId }, 'a body without belief_credence asserts nothing'],
      [
        { node_id: wellFormedNodeId, belief_credence: '0.5' },
        'a numeric string must not be coerced into a credence',
      ],
    ];

    for (const [malformedBody, refusalReason] of malformedAssertionBodies) {
      const malformedResponse = await postFixedCredenceAssertion(malformedBody);
      expect(malformedResponse.status, refusalReason).toBe(400);
    }
    expect(tempBeliefDb.readBeliefMovements(wellFormedNodeId)).toHaveLength(0);
  });
});
