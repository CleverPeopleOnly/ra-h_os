/**
 * A SUPPORT-ONLY agent update through PUT /api/edges/[id]
 * (app/api/edges/[id]/route.ts) — correcting how strongly a source node talks
 * about its neighbour WITHOUT rewriting the explanation stored beside it.
 *
 * WHY THIS FILE EXISTS. The explanation on an edge is the recorded human
 * reasoning for why the connection exists. A support correction is not an
 * occasion to rewrite it, and there is no read-one-edge-by-id MCP tool to fetch
 * it and hand it straight back — so an agent correcting a support today must
 * either invent prose over those words or give up. Three separate things in
 * this route make that so, and all three have to change together:
 *
 *  1. The route refuses any agent-driven update that carries no explanation, so
 *     even a widened MCP schema never gets past it.
 *  2. A body carrying `created_via` top-level has it folded INTO
 *     `updatePayload.context`, and edgeService.updateEdge writes `context`
 *     wholesale — so a support-only body that names itself 'mcp' would store
 *     `context: { created_via: 'mcp' }` and DESTROY the stored explanation.
 *  3. Dodging (2) by omitting `created_via` is worse, not better: the route
 *     defaults createdVia to 'ui' when it finds none, and the confirmation gate
 *     only fires for agent/mcp/workflow — so an unconfirmed support write with
 *     no created_via sails straight through today. That hole is pinned shut
 *     here.
 *
 * Seam (same as tests/unit/api/edgesIdRouteSupportUpdate.test.ts): the route
 * imports { edgeService } from '@/services/database', so that module is
 * vi.mocked wholesale and the handler is invoked directly with a plain Request.
 * The mock keeps ONE stored edge in memory and applies updates the way the real
 * service does — assigning `context` WHOLESALE rather than merging it — so a
 * read-back after the update can show byte-for-byte whether the explanation
 * survived. No database is ever opened; the tempBeliefDatabase helper is
 * imported first purely for its module-load sentinel (it pins SQLITE_DB_PATH to
 * a throwaway temp file so no accidental transitive import can touch the real
 * database).
 *
 * NOT DUPLICATED HERE: that an un-assessment clears the edge's
 * belief_evidence_contribution and regrades the target node is service-layer
 * behaviour and is already covered against a real database in
 * tests/unit/belief/edgeServiceUpdateEdgeEvidenceHook.test.ts. This file's job
 * is only to prove the un-assessment now REACHES that service through the
 * explanation-free path.
 */

// FIRST import: arms the temp-file SQLITE_DB_PATH sentinel at module load.
import '../belief/helpers/tempBeliefDatabase';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// The edge id every correction in this file is aimed at.
const CORRECTED_EDGE_ID = 31;

// The explanation the stored edge already carries: Marelie's recorded reasoning,
// the words a support-only correction must leave byte-for-byte intact.
const STORED_EDGE_EXPLANATION =
  'The source node reports a measured result bearing on the target node.';

// A replacement explanation, used only by the tests that deliberately edit it.
const REPLACEMENT_EDGE_EXPLANATION =
  'The source node reports a second measured result about the target node.';

// The stored context of the edge under test, as the app writes it: the
// explanation plus the inference metadata the route must not disturb.
type StoredEdgeContext = {
  explanation: string;
  created_via: string;
  type: string;
  confidence: number;
};

// The one edge this file corrects, held in memory by the mocked service.
type StoredEdgeRecord = {
  id: number;
  from_node_id: number;
  to_node_id: number;
  source: string;
  context: StoredEdgeContext;
  belief_evidence_support: number | null;
  created_at: string;
};

// The stored edge, reset before every test. Declared before the vi.mock factory
// because vitest hoists the factory above the imports, and the factory only
// dereferences this at call time.
const storedEdgeBeforeCorrection: StoredEdgeRecord = {
  id: CORRECTED_EDGE_ID,
  from_node_id: 2,
  to_node_id: 1,
  source: 'user',
  context: {
    explanation: STORED_EDGE_EXPLANATION,
    created_via: 'ui',
    type: 'supports',
    confidence: 0.8,
  },
  belief_evidence_support: 0.9,
  created_at: '2026-07-22T00:00:00.000Z',
};

// The live copy the mocked service reads and writes.
let storedEdgeRecord: StoredEdgeRecord = { ...storedEdgeBeforeCorrection };

// Replace the whole database service barrel. updateEdge deliberately assigns
// every supplied key WHOLESALE, exactly as the real service's dynamic UPDATE
// does for `context` — that wholesale write is the reason a stray context key
// destroys the stored explanation, so a merging mock would hide the very defect
// these tests exist to catch.
vi.mock('@/services/database', () => ({
  edgeService: {
    getEdgeById: vi.fn(async () => storedEdgeRecord),
    updateEdge: vi.fn(async (edgeId: number, updateFields: Record<string, unknown>) => {
      storedEdgeRecord = { ...storedEdgeRecord, ...updateFields, id: edgeId } as StoredEdgeRecord;
      return storedEdgeRecord;
    }),
    deleteEdge: vi.fn(),
  },
}));

import { edgeService } from '@/services/database';
import { PUT } from '../../../app/api/edges/[id]/route';

// Build a PUT Request for the route handler with the given JSON body.
function buildEdgeUpdateRequest(edgeUpdateBody: Record<string, unknown>): NextRequest {
  return new Request(`http://127.0.0.1/api/edges/${CORRECTED_EDGE_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(edgeUpdateBody),
  }) as unknown as NextRequest;
}

// The route's second argument: the awaited dynamic segment carrying the edge id.
function buildEdgeIdRouteParams(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: String(CORRECTED_EDGE_ID) }) };
}

// The update object the route handed to edgeService.updateEdge on its first
// call, or undefined if it never called it.
function getForwardedEdgeUpdateFields(): Record<string, unknown> | undefined {
  const firstCallArguments = vi.mocked(edgeService.updateEdge).mock.calls[0] as
    | [number, Record<string, unknown>]
    | undefined;
  return firstCallArguments?.[1];
}

/**
 * Asks buildSupportOnlyMcpCorrectionBody to leave the `confirmed_by_user` key
 * OUT of the body altogether — a body that never mentions confirmation at all,
 * which is a different journey through the route's gate from one that mentions
 * it and says false.
 *
 * It needs a name of its own because `undefined` cannot carry this meaning. A
 * JavaScript default parameter applies to an explicitly passed `undefined` just
 * as it does to a missing argument, so spelling the omitted case as
 * `(0.4, undefined)` silently yields the CONFIRMED default and makes the case
 * unreachable — the guard test then sends a body byte-identical to the accepted
 * one and demands the opposite status, which no implementation can satisfy. A
 * sentinel the default can never produce is the only way to tell "omit the key"
 * apart from "use the default", and naming it puts the intent in the call.
 */
const CONFIRMED_BY_USER_KEY_OMITTED = 'confirmed-by-user-key-omitted';

// What a caller may say about the body's `confirmed_by_user` key: write it as
// true, write it as false, or leave the key out of the body entirely.
type ConfirmedByUserKeyChoice = boolean | typeof CONFIRMED_BY_USER_KEY_OMITTED;

// The body an MCP door sends for a support-only correction once the doors are
// fixed: no context at all (a context with no explanation inside it would
// overwrite the stored one) and created_via top-level so the confirmation gate
// still fires. The confirmation key defaults to a confirmed true, because every
// caller that omits the argument is testing an ACCEPTED correction.
function buildSupportOnlyMcpCorrectionBody(
  correctedSupport: number | null,
  confirmedByUserKey: ConfirmedByUserKeyChoice = true
): Record<string, unknown> {
  return {
    created_via: 'mcp',
    belief_evidence_support: correctedSupport,
    ...(confirmedByUserKey === CONFIRMED_BY_USER_KEY_OMITTED
      ? {}
      : { confirmed_by_user: confirmedByUserKey }),
  };
}

beforeEach(() => {
  storedEdgeRecord = { ...storedEdgeBeforeCorrection };
  vi.mocked(edgeService.updateEdge).mockClear();
  vi.mocked(edgeService.getEdgeById).mockClear();
});

describe('PUT /api/edges/[id] accepts a support-only agent update', () => {
  // The headline: without this the widened MCP schema is useless, because the
  // route refuses every agent-driven update that carries no explanation — so a
  // support correction is only possible by rewriting recorded human reasoning.
  it('accepts a confirmed support-only mcp update and forwards the corrected support', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildSupportOnlyMcpCorrectionBody(0.4)),
      buildEdgeIdRouteParams()
    );

    expect(response.status, 'a support-only agent update must no longer be refused').toBe(200);
    expect(vi.mocked(edgeService.updateEdge)).toHaveBeenCalledTimes(1);
    expect(getForwardedEdgeUpdateFields()?.belief_evidence_support).toBeCloseTo(0.4, 10);
  });

  // The destructive case. `context` is written wholesale, so restamping
  // created_via into it on a support-only update replaces the stored context
  // with one that has no explanation in it — the recorded reasoning is gone and
  // nothing in the response says so.
  it('leaves the stored explanation byte-for-byte intact', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildSupportOnlyMcpCorrectionBody(0.4)),
      buildEdgeIdRouteParams()
    );

    // Asserted first so this test cannot pass merely because the route refused
    // the update and nothing was written at all.
    expect(response.status).toBe(200);
    const edgeAfterCorrection = await edgeService.getEdgeById(CORRECTED_EDGE_ID);
    const contextAfterCorrection = (edgeAfterCorrection as StoredEdgeRecord | null)?.context;
    expect(contextAfterCorrection?.explanation).toBe(STORED_EDGE_EXPLANATION);
  });

  // The rest of the stored context is Marelie's too, by way of the app's
  // inference: the relationship type and how sure the app was of it. A
  // support correction has no business touching any of it.
  it('leaves the rest of the stored context untouched', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildSupportOnlyMcpCorrectionBody(0.4)),
      buildEdgeIdRouteParams()
    );

    // Asserted first, for the same reason: a refused update writes nothing and
    // would satisfy an equality check by accident.
    expect(response.status).toBe(200);
    const edgeAfterCorrection = await edgeService.getEdgeById(CORRECTED_EDGE_ID);
    expect((edgeAfterCorrection as StoredEdgeRecord | null)?.context).toEqual(
      storedEdgeBeforeCorrection.context
    );
  });

  // Belt and braces on the same defect, stated as the route's own contract: a
  // support-only update must hand the service no context key at all, so there
  // is nothing for the wholesale write to overwrite the stored one with.
  it('hands the service no context key and no created_via key', async () => {
    await PUT(
      buildEdgeUpdateRequest(buildSupportOnlyMcpCorrectionBody(0.4)),
      buildEdgeIdRouteParams()
    );

    // Asserted first so the absent-key checks below cannot be satisfied by the
    // route having refused the update and called nothing.
    expect(vi.mocked(edgeService.updateEdge)).toHaveBeenCalledTimes(1);
    const forwardedUpdateFields = getForwardedEdgeUpdateFields();
    expect(Object.keys(forwardedUpdateFields ?? {})).not.toContain('context');
    // created_via is not an edges column: left top-level it would reach the
    // service's dynamic UPDATE as `created_via = ?` and fail against SQL.
    expect(Object.keys(forwardedUpdateFields ?? {})).not.toContain('created_via');
    // The confirmation flag is a request-level gate, never a stored column.
    expect(Object.keys(forwardedUpdateFields ?? {})).not.toContain('confirmed_by_user');
  });

  // Un-assessment through the explanation-free path: the write that returns a
  // graded evidence edge to a plain relationship. It must reach the service
  // present AND null — a dropped key would leave the edge graded, which looks
  // identical to the correction never having happened.
  it('forwards an un-assessment as a present-and-null support', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildSupportOnlyMcpCorrectionBody(null)),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(200);
    const forwardedUpdateFields = getForwardedEdgeUpdateFields();
    expect(Object.keys(forwardedUpdateFields ?? {})).toContain('belief_evidence_support');
    expect(forwardedUpdateFields?.belief_evidence_support).toBeNull();
    // Un-assessing must not cost the explanation either.
    expect(Object.keys(forwardedUpdateFields ?? {})).not.toContain('context');
  });

  // A support of 0 is a recorded judgement — assessed, carries nothing — and
  // must survive the explanation-free path as the key 0 rather than being
  // dropped as falsy, which would read as "no support supplied".
  it('forwards a support of exactly 0 as the key 0', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildSupportOnlyMcpCorrectionBody(0)),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(200);
    expect(getForwardedEdgeUpdateFields()?.belief_evidence_support).toBe(0);
  });
});

describe('PUT /api/edges/[id] still guards a support-only agent update', () => {
  // THE BYPASS HOLE. createdVia defaults to 'ui' when the body names none, and
  // the confirmation gate only fires for agent/mcp/workflow — so a support
  // write that simply omits created_via is unconfirmed AND unguarded today. If
  // the fix routes support-only writes down the 'ui' path to escape the context
  // problem, this is the test that catches it.
  it('refuses an unconfirmed support write that names no created_via', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest({ belief_evidence_support: 0.4 }),
      buildEdgeIdRouteParams()
    );

    expect(
      response.status,
      'a support write with no confirmation must be refused however it names itself'
    ).toBe(400);
    expect(vi.mocked(edgeService.updateEdge)).not.toHaveBeenCalled();
  });

  // The same hole with the flag present and false, which is what a door would
  // send if it forwarded an unconfirmed call instead of throwing.
  it('refuses a support-only update whose confirmed_by_user is false', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildSupportOnlyMcpCorrectionBody(0.4, false)),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(400);
    expect(vi.mocked(edgeService.updateEdge)).not.toHaveBeenCalled();
  });

  // GUARD: an mcp update with the flag MISSING ENTIRELY was already refused and
  // must stay refused — the widened path must not become a second way in. This
  // is a different journey through the gate from its two siblings above: the
  // body names created_via (unlike the no-created_via case) and never mentions
  // confirmation at all (unlike the explicit false), so an implementation that
  // tested `confirmed_by_user === false` instead of `!== true` would pass both
  // of those and fail only this one.
  it('GUARD: refuses a support-only mcp update with no confirmed_by_user at all', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(
        buildSupportOnlyMcpCorrectionBody(0.4, CONFIRMED_BY_USER_KEY_OMITTED)
      ),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(400);
    expect(vi.mocked(edgeService.updateEdge)).not.toHaveBeenCalled();
  });

  // GUARD: the explanation requirement is relaxed for a support correction ONLY.
  // An agent-driven update that carries neither an explanation nor a support has
  // nothing to write and no reasoning behind it, and must still be refused.
  it('GUARD: refuses an agent update carrying neither an explanation nor a support', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest({ created_via: 'mcp', confirmed_by_user: true }),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(400);
    expect(vi.mocked(edgeService.updateEdge)).not.toHaveBeenCalled();
  });

  // GUARD: an agent update that CHANGES the relationship prose still owes an
  // explanation. A blank one is an agent writing nothing over recorded human
  // reasoning, which is the same loss the support-only path exists to prevent.
  it('GUARD: refuses an agent update whose supplied explanation is blank', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest({
        context: { explanation: '   ', created_via: 'mcp' },
        confirmed_by_user: true,
        belief_evidence_support: 0.4,
      }),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(400);
    expect(vi.mocked(edgeService.updateEdge)).not.toHaveBeenCalled();
  });

  // GUARD: the ordinary explanation-carrying correction is untouched by all of
  // this — it still travels with its context and still reaches the service.
  it('GUARD: an explanation-carrying mcp update still succeeds and forwards its context', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest({
        context: { explanation: REPLACEMENT_EDGE_EXPLANATION, created_via: 'mcp' },
        confirmed_by_user: true,
        belief_evidence_support: 0.4,
      }),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(200);
    const forwardedUpdateFields = getForwardedEdgeUpdateFields();
    expect(forwardedUpdateFields?.context).toMatchObject({
      explanation: REPLACEMENT_EDGE_EXPLANATION,
      created_via: 'mcp',
    });
    expect(forwardedUpdateFields?.belief_evidence_support).toBeCloseTo(0.4, 10);
  });

  // GUARD: the range check is unchanged on the explanation-free path — an
  // out-of-range support must never reach a REAL column just because it
  // arrived without an explanation.
  it('GUARD: refuses an out-of-range support on the support-only path', async () => {
    for (const rejectedSupport of [-0.1, 1.5]) {
      vi.mocked(edgeService.updateEdge).mockClear();
      const response = await PUT(
        buildEdgeUpdateRequest(buildSupportOnlyMcpCorrectionBody(rejectedSupport)),
        buildEdgeIdRouteParams()
      );

      expect(response.status, `a support of ${rejectedSupport} must be refused`).toBe(400);
      expect(vi.mocked(edgeService.updateEdge)).not.toHaveBeenCalled();
    }
  });
});
