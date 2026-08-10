/**
 * Correcting an edge's SUPPORT through PUT /api/edges/[id]
 * (app/api/edges/[id]/route.ts).
 *
 * This route is the middle door on the support-correction path: the app-MCP
 * proxy's rah_update_edge sends the corrected support here, and this route
 * hands it to edgeService.updateEdge, which writes the edges column. What the
 * route does NOT do today is check the range, so anything the caller sends is
 * passed straight on to a REAL column. Support is UNSIGNED, 0..1, and every
 * door on the path enforces it, so this file pins:
 *
 *  - belief_evidence_support reaches edgeService.updateEdge as a top-level
 *    update field, so it lands in the edges column and not in the app-owned
 *    context JSON,
 *  - a negative support, a support above 1, and a support that is not a number
 *    at all are each rejected with 400 and never reach the service — a value
 *    that cannot be in range must never be handed to SQL,
 *  - exactly 0 and exactly 1 are accepted and forwarded, with 0 arriving as the
 *    key 0: NULL means the edge was never assessed as evidence, 0 means it was
 *    assessed and carries nothing, and the route must not collapse the two,
 *  - an explanation-only update keeps working with no evidence field invented
 *    for it.
 *
 * Seam (same as tests/unit/api/edgesRouteEvidence.test.ts): the route imports
 * { edgeService } from '@/services/database', so that module is vi.mocked
 * wholesale and the route handler is invoked directly with a plain Request. No
 * database is ever opened; the tempBeliefDatabase helper is imported first
 * purely for its module-load sentinel (it pins SQLITE_DB_PATH to a throwaway
 * temp file so no accidental transitive import can touch the real database).
 */

// FIRST import: arms the temp-file SQLITE_DB_PATH sentinel at module load.
import '../belief/helpers/tempBeliefDatabase';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import type { Edge } from '@/types/database';

// Replace the whole database service barrel: this route only needs
// edgeService.updateEdge (the spy whose received update these tests pin),
// plus the read and delete members the module's other handlers reference.
vi.mock('@/services/database', () => ({
  edgeService: {
    getEdgeById: vi.fn(),
    updateEdge: vi.fn(async (edgeId: number) => ({
      id: edgeId,
      from_node_id: 2,
      to_node_id: 1,
      source: 'user',
      context: {},
      created_at: '2026-07-22T00:00:00.000Z',
    })),
    deleteEdge: vi.fn(),
  },
}));

import { edgeService } from '@/services/database';
import { PUT } from '../../../app/api/edges/[id]/route';

// The edge id every correction in this file is aimed at.
const CORRECTED_EDGE_ID = 31;

// The explanation an accepted correction carries: specific enough to pass the
// route's edge-explanation quality check.
const CORRECTED_EDGE_EXPLANATION =
  'The source node reports a measured result bearing on the claim node.';

// The update fields the route may hand to edgeService.updateEdge. Support is
// the field under test; explanation and context are the ones already forwarded.
type ForwardedEdgeUpdateFields = Partial<Edge> & {
  explanation?: string;
  belief_evidence_support?: number | null;
};

// Build a PUT Request for the route handler with the given JSON body.
function buildEdgeUpdateRequest(body: Record<string, unknown>): NextRequest {
  return new Request(`http://127.0.0.1/api/edges/${CORRECTED_EDGE_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

// The route's second argument: the awaited dynamic segment carrying the edge id.
function buildEdgeIdRouteParams(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: String(CORRECTED_EDGE_ID) }) };
}

// A confirmed MCP-shaped correction body, as the app-MCP proxy sends it: the
// explanation travels inside context and the confirmation flag is explicit.
function buildConfirmedMcpCorrectionBody(
  evidenceFields: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    context: { explanation: CORRECTED_EDGE_EXPLANATION, created_via: 'mcp' },
    confirmed_by_user: true,
    ...evidenceFields,
  };
}

// The update object the route handed to edgeService.updateEdge on its first call.
function getForwardedEdgeUpdateFields(): ForwardedEdgeUpdateFields | undefined {
  const firstCallArguments = vi.mocked(edgeService.updateEdge).mock.calls[0] as
    | [number, ForwardedEdgeUpdateFields]
    | undefined;
  return firstCallArguments?.[1];
}

beforeEach(() => {
  vi.mocked(edgeService.updateEdge).mockClear();
});

describe('PUT /api/edges/[id] support correction', () => {
  // The pass-through the correction path depends on: an in-range support must
  // arrive at the service as a top-level update field, ready for the column.
  it('forwards an in-range belief_evidence_support to edgeService.updateEdge', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildConfirmedMcpCorrectionBody({ belief_evidence_support: 0.42 })),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(edgeService.updateEdge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(edgeService.updateEdge).mock.calls[0][0]).toBe(CORRECTED_EDGE_ID);
    expect(getForwardedEdgeUpdateFields()?.belief_evidence_support).toBeCloseTo(0.42, 10);
  });

  // 0 is a recorded judgement — assessed, carries nothing — so the key must
  // reach the service present and zero rather than being dropped as falsy.
  it('accepts a belief_evidence_support of exactly 0 and forwards the key with value 0', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildConfirmedMcpCorrectionBody({ belief_evidence_support: 0 })),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(200);
    const forwardedUpdateFields = getForwardedEdgeUpdateFields();
    expect(Object.keys(forwardedUpdateFields ?? {})).toContain('belief_evidence_support');
    expect(forwardedUpdateFields?.belief_evidence_support).toBe(0);
  });

  // The upper boundary is in range: a correction to full-strength evidence is
  // forwarded verbatim.
  it('accepts a belief_evidence_support of exactly 1 and forwards it', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildConfirmedMcpCorrectionBody({ belief_evidence_support: 1 })),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(200);
    expect(getForwardedEdgeUpdateFields()?.belief_evidence_support).toBe(1);
  });

  // Support is unsigned, so a negative correction is an invalid write, not a
  // contradiction — contradiction comes from the source NODE's credence. The
  // route must refuse it rather than pass it to a real column.
  it('rejects a negative belief_evidence_support with 400 and never updates the edge', async () => {
    for (const rejectedNegativeSupport of [-0.1, -1]) {
      vi.mocked(edgeService.updateEdge).mockClear();
      const response = await PUT(
        buildEdgeUpdateRequest(
          buildConfirmedMcpCorrectionBody({ belief_evidence_support: rejectedNegativeSupport })
        ),
        buildEdgeIdRouteParams()
      );

      expect(
        response.status,
        `a support of ${rejectedNegativeSupport} must be rejected — support is unsigned`
      ).toBe(400);
      const responseBody = (await response.json()) as { success: boolean; error?: string };
      expect(responseBody.success).toBe(false);
      expect(vi.mocked(edgeService.updateEdge)).not.toHaveBeenCalled();
    }
  });

  // The unsigned range tops out at 1: anything above it is out of bounds.
  it('rejects a belief_evidence_support above 1 with 400 and never updates the edge', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildConfirmedMcpCorrectionBody({ belief_evidence_support: 1.5 })),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(400);
    const responseBody = (await response.json()) as { success: boolean; error?: string };
    expect(responseBody.success).toBe(false);
    expect(vi.mocked(edgeService.updateEdge)).not.toHaveBeenCalled();
  });

  // A support that is not a number cannot be in range at all, and belief_evidence_support
  // is a REAL column: a string reaching the dynamic UPDATE would be stored as
  // text, so the range check has to be a number check first.
  it('rejects a non-numeric belief_evidence_support with 400 and never updates the edge', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(
        buildConfirmedMcpCorrectionBody({ belief_evidence_support: 'quite strongly' })
      ),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(400);
    const responseBody = (await response.json()) as { success: boolean; error?: string };
    expect(responseBody.success).toBe(false);
    expect(vi.mocked(edgeService.updateEdge)).not.toHaveBeenCalled();
  });

  // GUARD: a NULL support is an UN-ASSESSMENT, not an out-of-range value: it
  // says this edge is no longer evidence at all. It must reach the service so
  // the un-assessment can be written and the derived node (the edge's
  // from-end, canon direction) regraded — pinned here
  // explicitly so nobody later "hardens" the range check by refusing null.
  it('GUARD: accepts a belief_evidence_support of null and forwards the un-assessment to updateEdge', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildConfirmedMcpCorrectionBody({ belief_evidence_support: null })),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(edgeService.updateEdge)).toHaveBeenCalledTimes(1);
    const forwardedUpdateFields = getForwardedEdgeUpdateFields();
    // Present AND null: a dropped key would leave the edge assessed as before.
    expect(Object.keys(forwardedUpdateFields ?? {})).toContain('belief_evidence_support');
    expect(forwardedUpdateFields?.belief_evidence_support).toBeNull();
  });

  // GUARD: an explanation-only correction must keep working, and the route must
  // not invent a support for it — that would turn a plain relationship edge into
  // assessed evidence.
  it('GUARD: an explanation-only update reaches updateEdge with no evidence field', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest(buildConfirmedMcpCorrectionBody()),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(200);
    const forwardedUpdateFields = getForwardedEdgeUpdateFields();
    expect(forwardedUpdateFields?.context).toMatchObject({
      explanation: CORRECTED_EDGE_EXPLANATION,
    });
    expect(Object.keys(forwardedUpdateFields ?? {})).not.toContain('belief_evidence_support');
  });

  // GUARD: the confirmation gate on agent-driven updates is unchanged — a
  // support correction must not become a way around it.
  it('GUARD: rejects an unconfirmed agent-driven support correction with 400', async () => {
    const response = await PUT(
      buildEdgeUpdateRequest({
        context: { explanation: CORRECTED_EDGE_EXPLANATION, created_via: 'mcp' },
        belief_evidence_support: 0.42,
      }),
      buildEdgeIdRouteParams()
    );

    expect(response.status).toBe(400);
    expect(vi.mocked(edgeService.updateEdge)).not.toHaveBeenCalled();
  });
});
