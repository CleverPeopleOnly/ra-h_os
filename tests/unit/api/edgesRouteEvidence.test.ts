/**
 * MR-B test for the /api/edges POST route: a request body carrying the three
 * writable evidence fields (belief_evidence_direction, belief_evidence_strength,
 * belief_evidence_origin_key) must reach edgeService.createEdge with those
 * fields intact — today the route rebuilds the createEdge argument from an
 * explicit field list and silently drops them.
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

describe('/api/edges POST evidence forwarding (MR-B)', () => {
  // The pinned behavior: the three evidence fields in the request body must
  // survive the route's argument rebuild and arrive at createEdge intact.
  it('forwards belief_evidence_direction, belief_evidence_strength, and belief_evidence_origin_key to edgeService.createEdge', async () => {
    const response = await POST(
      buildEdgesPostRequest({
        ...confirmedMcpEdgeBody,
        belief_evidence_direction: 'for',
        belief_evidence_strength: 0.8,
        belief_evidence_origin_key: 'origin:route-evidence-test',
      })
    );

    expect(response.status).toBe(201);
    expect(vi.mocked(edgeService.createEdge)).toHaveBeenCalledTimes(1);

    const createEdgeArgument = vi.mocked(edgeService.createEdge).mock.calls[0][0];
    // Non-evidence fields still arrive as before.
    expect(createEdgeArgument).toMatchObject({
      from_node_id: 2,
      to_node_id: 1,
      explanation: 'Reports a measured result that supports the claim node.',
    });
    // The evidence fields must survive the route intact.
    expect(createEdgeArgument.belief_evidence_direction).toBe('for');
    expect(createEdgeArgument.belief_evidence_strength).toBeCloseTo(0.8, 10);
    expect(createEdgeArgument.belief_evidence_origin_key).toBe('origin:route-evidence-test');
  });

  // GUARD (deliberately green today): an evidence-free body must keep
  // producing an evidence-free createEdge call — the route must not invent
  // evidence values for plain relationship edges.
  it('GUARD: an evidence-free body reaches createEdge without any evidence fields set', async () => {
    const response = await POST(buildEdgesPostRequest(confirmedMcpEdgeBody));

    expect(response.status).toBe(201);
    expect(vi.mocked(edgeService.createEdge)).toHaveBeenCalledTimes(1);

    const createEdgeArgument = vi.mocked(edgeService.createEdge).mock.calls[0][0];
    expect(createEdgeArgument.belief_evidence_direction ?? null).toBeNull();
    expect(createEdgeArgument.belief_evidence_strength ?? null).toBeNull();
    expect(createEdgeArgument.belief_evidence_origin_key ?? null).toBeNull();
  });
});
