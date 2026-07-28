/**
 * Tests for the /api/edges POST route's belief-evidence pass-through: a
 * request body carrying the two writable evidence fields
 * (belief_evidence_direction, belief_evidence_strength) must reach
 * edgeService.createEdge with those fields intact, because the route rebuilds
 * the createEdge argument from an explicit field list.
 *
 * belief_evidence_origin_key is REMOVED: the route must no longer name it in
 * that rebuild, so a stale client that still sends it gets a normal 201 with
 * the field simply absent from the createEdge argument (ignored, not an
 * error, and never invented for bodies that omit it).
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
  // EDITED from the three-field forwarding case: the two surviving evidence
  // fields must still reach createEdge intact, while a stale
  // belief_evidence_origin_key in the body is ignored — the request still
  // succeeds and the key never appears on the createEdge argument.
  it('forwards belief_evidence_direction and belief_evidence_strength, ignoring a stale belief_evidence_origin_key', async () => {
    const response = await POST(
      buildEdgesPostRequest({
        ...confirmedMcpEdgeBody,
        belief_evidence_direction: 'for',
        belief_evidence_strength: 0.8,
        belief_evidence_origin_key: 'origin:route-evidence-test',
      })
    );

    // Ignored, not rejected: the stale field still produces a created edge.
    expect(response.status).toBe(201);
    expect(vi.mocked(edgeService.createEdge)).toHaveBeenCalledTimes(1);

    const createEdgeArgument = vi.mocked(edgeService.createEdge).mock.calls[0][0];
    // Non-evidence fields still arrive as before.
    expect(createEdgeArgument).toMatchObject({
      from_node_id: 2,
      to_node_id: 1,
      explanation: 'Reports a measured result that supports the claim node.',
    });
    // The surviving evidence fields must reach createEdge intact.
    expect(createEdgeArgument.belief_evidence_direction).toBe('for');
    expect(createEdgeArgument.belief_evidence_strength).toBeCloseTo(0.8, 10);
    // The removed field must not be rebuilt onto the createEdge argument at
    // all — not even as an explicit undefined key.
    expect(Object.keys(createEdgeArgument)).not.toContain('belief_evidence_origin_key');
  });

  // GUARD: an evidence-free body must keep producing an evidence-free
  // createEdge call — the route must not invent evidence values for plain
  // relationship edges, and must not name the removed origin key either.
  it('GUARD: an evidence-free body reaches createEdge without any evidence fields set', async () => {
    const response = await POST(buildEdgesPostRequest(confirmedMcpEdgeBody));

    expect(response.status).toBe(201);
    expect(vi.mocked(edgeService.createEdge)).toHaveBeenCalledTimes(1);

    const createEdgeArgument = vi.mocked(edgeService.createEdge).mock.calls[0][0];
    expect(createEdgeArgument.belief_evidence_direction ?? null).toBeNull();
    expect(createEdgeArgument.belief_evidence_strength ?? null).toBeNull();
    expect(Object.keys(createEdgeArgument)).not.toContain('belief_evidence_origin_key');
  });
});
