/**
 * Tests for the /api/edges POST route's belief-evidence pass-through: a
 * request body carrying the one signed evidence field
 * (belief_evidence_support) must reach edgeService.createEdge with that field
 * intact, because the route rebuilds the createEdge argument from an explicit
 * field list.
 *
 * belief_evidence_direction and belief_evidence_strength are MERGED AWAY into
 * that signed field: the route must no longer name either in the rebuild, so
 * a stale client that still sends them gets a normal 201 with both fields
 * simply absent from the createEdge argument (ignored, not an error, and
 * never invented for bodies that omit them). The resulting edge carries no
 * support, which is a legitimate plain non-evidence edge.
 *
 * Seam: the route imports { edgeService } from '@/services/database', so
 * that module is vi.mocked wholesale and the route handler is invoked
 * directly with a plain Request. No database is ever opened; the
 * tempBeliefDatabase helper is imported first purely for its module-load
 * sentinel (it pins SQLITE_DB_PATH to a throwaway temp file so no accidental
 * transitive import can touch the real database).
 */

// FIRST import: arms the temp-file SQLITE_DB_PATH sentinel at module load.
import '../belief/helpers/tempBeliefDatabase';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import type { EdgeData } from '@/types/database';

// Replace the whole database service barrel: the route only needs
// edgeService.edgeExists (no duplicate) and edgeService.createEdge (the spy
// whose received argument this test pins).
vi.mock('@/services/database', () => ({
  edgeService: {
    edgeExists: vi.fn(async () => false),
    createEdge: vi.fn(async (edgeData: EdgeData) => ({
      id: 77,
      from_node_id: edgeData.from_node_id,
      to_node_id: edgeData.to_node_id,
      source: edgeData.source,
      context: {},
      created_at: '2026-07-22T00:00:00.000Z',
    })),
    getEdges: vi.fn(async () => []),
  },
}));

import { edgeService } from '@/services/database';
import { POST } from '../../../app/api/edges/route';

// Build a POST Request for the route handler with the given JSON body.
function buildEdgesPostRequest(body: Record<string, unknown>): NextRequest {
  return new Request('http://127.0.0.1/api/edges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

// A confirmed MCP-style edge body that passes every existing route
// validation (explanation quality, source whitelist, confirmation gate).
const confirmedMcpEdgeBody = {
  from_node_id: 2,
  to_node_id: 1,
  explanation: 'Reports a measured result that supports the claim node.',
  source: 'user',
  created_via: 'mcp',
  confirmed_by_user: true,
};

beforeEach(() => {
  vi.mocked(edgeService.edgeExists).mockClear();
  vi.mocked(edgeService.createEdge).mockClear();
});

describe('/api/edges POST evidence forwarding', () => {
  // EDITED from the two-field forwarding case: the one signed evidence field
  // must reach createEdge intact, while stale belief_evidence_direction /
  // belief_evidence_strength values in the same body are ignored — the
  // request still succeeds and neither merged-away name appears on the
  // createEdge argument.
  it('forwards belief_evidence_support, ignoring stale belief_evidence_direction and belief_evidence_strength', async () => {
    const response = await POST(
      buildEdgesPostRequest({
        ...confirmedMcpEdgeBody,
        belief_evidence_support: 0.8,
        belief_evidence_direction: 'against',
        belief_evidence_strength: 0.4,
      })
    );

    // Ignored, not rejected: the stale fields still produce a created edge.
    expect(response.status).toBe(201);
    expect(vi.mocked(edgeService.createEdge)).toHaveBeenCalledTimes(1);

    const createEdgeArgument = vi.mocked(edgeService.createEdge).mock.calls[0][0];
    // Non-evidence fields still arrive as before.
    expect(createEdgeArgument).toMatchObject({
      from_node_id: 2,
      to_node_id: 1,
      explanation: 'Reports a measured result that supports the claim node.',
    });
    // The signed evidence field must reach createEdge intact.
    expect(createEdgeArgument.belief_evidence_support).toBeCloseTo(0.8, 10);
    // Neither merged-away field may be rebuilt onto the createEdge argument
    // at all — not even as an explicit undefined key. Note the stale pair
    // said 'against' 0.4: if either survived, the edge's meaning would flip.
    expect(Object.keys(createEdgeArgument)).not.toContain('belief_evidence_direction');
    expect(Object.keys(createEdgeArgument)).not.toContain('belief_evidence_strength');
  });

  // Sign pass-through: a negative support is a contradiction and must reach
  // createEdge with its sign intact — support is the only signed term, so the
  // route must never normalise it to a magnitude.
  it('forwards a negative belief_evidence_support with its sign intact', async () => {
    const response = await POST(
      buildEdgesPostRequest({
        ...confirmedMcpEdgeBody,
        belief_evidence_support: -0.6,
      })
    );

    expect(response.status).toBe(201);
    const createEdgeArgument = vi.mocked(edgeService.createEdge).mock.calls[0][0];
    expect(createEdgeArgument.belief_evidence_support).toBeCloseTo(-0.6, 10);
  });

  // GUARD: an evidence-free body must keep producing an evidence-free
  // createEdge call — the route must not invent a support value for plain
  // relationship edges, and must not name the merged-away pair either.
  it('GUARD: an evidence-free body reaches createEdge without any evidence fields set', async () => {
    const response = await POST(buildEdgesPostRequest(confirmedMcpEdgeBody));

    expect(response.status).toBe(201);
    expect(vi.mocked(edgeService.createEdge)).toHaveBeenCalledTimes(1);

    const createEdgeArgument = vi.mocked(edgeService.createEdge).mock.calls[0][0];
    expect(createEdgeArgument.belief_evidence_support ?? null).toBeNull();
    expect(Object.keys(createEdgeArgument)).not.toContain('belief_evidence_direction');
    expect(Object.keys(createEdgeArgument)).not.toContain('belief_evidence_strength');
  });
});
