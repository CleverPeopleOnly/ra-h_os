/**
 * Belief-evidence EDGE READS through GET /api/edges (app/api/edges/route.ts).
 *
 * The shipped handler is declared `export async function GET()` — it takes no
 * request object at all, so every query parameter a caller sends is silently
 * ignored and the route answers with the entire edges table. This file pins
 * the contract the route must honour instead:
 *
 *  - it reads nodeId, direction, limit and offset from the query string and
 *    hands them to edgeService.getEdges as one filter, with limit and offset as
 *    numbers rather than the raw strings,
 *  - an omitted direction means 'both' — either side of the node, the
 *    behaviour node-scoped callers have today,
 *  - invalid values are REJECTED with 400 rather than silently ignored: a
 *    non-numeric nodeId, a negative limit, a negative offset, an unknown
 *    direction. A silently ignored filter is the defect being fixed, so
 *    "ignored" is never an acceptable answer,
 *  - both belief columns reach the response verbatim, including NULL:
 *    belief_evidence_support NULL means the edge is not evidence at all, and a
 *    support with belief_evidence_contribution NULL means evidence nobody has
 *    graded yet — the state the recovery sweep looks for, which must never be
 *    coerced to 0.
 *
 * Seam (same as tests/unit/api/edgesRouteEvidence.test.ts): the route imports
 * { edgeService } from '@/services/database', so that module is vi.mocked
 * wholesale and the handler is invoked directly with a plain Request. No
 * database is ever opened; the tempBeliefDatabase helper is imported first
 * purely for its module-load sentinel (it pins SQLITE_DB_PATH to a throwaway
 * temp file so no accidental transitive import can touch the real database).
 */

// FIRST import: arms the temp-file SQLITE_DB_PATH sentinel at module load.
import '../belief/helpers/tempBeliefDatabase';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// Replace the whole database service barrel: the read route only needs
// edgeService.getEdges, the spy whose received filter these tests pin.
vi.mock('@/services/database', () => ({
  edgeService: {
    edgeExists: vi.fn(async () => false),
    createEdge: vi.fn(),
    getEdges: vi.fn(async () => []),
  },
}));

import { edgeService } from '@/services/database';
import { GET } from '../../../app/api/edges/route';

// Which side of a node an edge read is asking for. 'into' is the evidence
// side: those edges point AT the node and feed its credence.
type BeliefEdgeReadDirection = 'into' | 'out_of' | 'both';

// The filter GET /api/edges must build from its query string and pass to
// edgeService.getEdges. Declared here rather than imported because neither the
// route nor the service accepts it yet — that is the red this file drives.
interface BeliefEdgeReadFilter {
  nodeId?: number;
  direction?: BeliefEdgeReadDirection;
  limit?: number;
  offset?: number;
}

// The shipped GET is declared with zero parameters, so it cannot be called
// with a request in a typed way until it accepts one. This cast is the shape
// of the defect, not a convenience.
const readEdgesRoute = GET as unknown as (request: NextRequest) => Promise<Response>;

// Build a GET Request for the read route with the given query string.
function buildEdgesGetRequest(queryString: string): NextRequest {
  return new Request(`http://127.0.0.1/api/edges${queryString}`, {
    method: 'GET',
  }) as unknown as NextRequest;
}

// The filter the route handed to edgeService.getEdges on its first call.
function getForwardedEdgeReadFilter(): BeliefEdgeReadFilter | undefined {
  const firstCallArguments = vi.mocked(edgeService.getEdges).mock.calls[0] as
    | [BeliefEdgeReadFilter?]
    | undefined;
  return firstCallArguments?.[0];
}

// One edge row as the route must return it: identity columns plus BOTH belief
// columns, each nullable because NULL is a meaningful state on both.
interface BeliefEdgeReadRow {
  id: number;
  from_node_id: number;
  to_node_id: number;
  belief_evidence_support: number | null;
  belief_evidence_contribution: number | null;
}

// The three edge states the read path must keep distinct, as the mocked
// service would return them: a plain relationship edge (support NULL), an
// ungraded evidence edge (support set, contribution NULL), and a graded
// evidence edge (both numbers).
const threeStateEdgeReadRows: BeliefEdgeReadRow[] = [
  {
    id: 11,
    from_node_id: 2,
    to_node_id: 1,
    belief_evidence_support: null,
    belief_evidence_contribution: null,
  },
  {
    id: 12,
    from_node_id: 3,
    to_node_id: 1,
    belief_evidence_support: 0.5,
    belief_evidence_contribution: null,
  },
  {
    id: 13,
    from_node_id: 4,
    to_node_id: 1,
    belief_evidence_support: 0.75,
    belief_evidence_contribution: 0.6,
  },
];

beforeEach(() => {
  vi.mocked(edgeService.getEdges).mockClear();
  vi.mocked(edgeService.getEdges).mockResolvedValue([]);
});

describe('GET /api/edges belief-evidence edge reads', () => {
  // The whole point of the defect: the route must actually read its query
  // string and forward every part of the filter to the service.
  it('forwards nodeId, direction, limit and offset from the query string to edgeService.getEdges', async () => {
    const response = await readEdgesRoute(
      buildEdgesGetRequest('?nodeId=1&direction=into&limit=5&offset=10')
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(edgeService.getEdges)).toHaveBeenCalledTimes(1);

    const forwardedFilter = getForwardedEdgeReadFilter();
    expect(forwardedFilter).toMatchObject({
      nodeId: 1,
      direction: 'into',
      limit: 5,
      offset: 10,
    });
    // Numbers, not the raw query strings: the service builds SQL from these.
    expect(typeof forwardedFilter?.nodeId).toBe('number');
    expect(typeof forwardedFilter?.limit).toBe('number');
    expect(typeof forwardedFilter?.offset).toBe('number');
  });

  // The out_of side must be reachable too, not just the evidence side.
  it('forwards a direction of out_of to edgeService.getEdges', async () => {
    await readEdgesRoute(buildEdgesGetRequest('?nodeId=1&direction=out_of'));

    expect(getForwardedEdgeReadFilter()).toMatchObject({ nodeId: 1, direction: 'out_of' });
  });

  // An omitted direction means either side of the node, so a node-scoped
  // caller keeps the behaviour it has today without having to name it.
  it('forwards a direction of both when the query string omits it', async () => {
    await readEdgesRoute(buildEdgesGetRequest('?nodeId=1'));

    expect(getForwardedEdgeReadFilter()).toMatchObject({ nodeId: 1, direction: 'both' });
  });

  // Both belief columns must reach the caller untouched for all three edge
  // states. The NULL contribution on an ungraded evidence edge is the
  // load-bearing one: coercing it to 0 would make an ungraded edge look
  // graded-and-worthless and hide it from the recovery sweep.
  it('returns belief_evidence_support and belief_evidence_contribution verbatim, keeping NULL as NULL', async () => {
    vi.mocked(edgeService.getEdges).mockResolvedValue(
      threeStateEdgeReadRows as unknown as Awaited<ReturnType<typeof edgeService.getEdges>>
    );

    const response = await readEdgesRoute(buildEdgesGetRequest('?nodeId=1&direction=into'));
    const responseBody = (await response.json()) as {
      success: boolean;
      data: BeliefEdgeReadRow[];
    };

    expect(response.status).toBe(200);
    expect(responseBody.success).toBe(true);
    expect(responseBody.data).toHaveLength(3);

    const plainEdge = responseBody.data.find(edge => edge.id === 11);
    // NULL support is the one thing that makes an edge not evidence at all.
    expect(Object.keys(plainEdge ?? {})).toContain('belief_evidence_support');
    expect(plainEdge?.belief_evidence_support).toBeNull();
    expect(plainEdge?.belief_evidence_contribution).toBeNull();

    const ungradedEvidenceEdge = responseBody.data.find(edge => edge.id === 12);
    expect(ungradedEvidenceEdge?.belief_evidence_support).toBeCloseTo(0.5, 10);
    // NULL, never 0: this edge is evidence that has not been graded yet.
    expect(ungradedEvidenceEdge?.belief_evidence_contribution).toBeNull();

    const gradedEvidenceEdge = responseBody.data.find(edge => edge.id === 13);
    expect(gradedEvidenceEdge?.belief_evidence_support).toBeCloseTo(0.75, 10);
    expect(gradedEvidenceEdge?.belief_evidence_contribution).toBeCloseTo(0.6, 10);
  });

  // A nodeId that is not a number cannot be turned into a filter, so it must
  // come back as a rejection rather than quietly widening the read to the
  // whole table — the exact failure mode being fixed.
  it('rejects a non-numeric nodeId with 400 and never reads edges', async () => {
    const response = await readEdgesRoute(buildEdgesGetRequest('?nodeId=not-a-node'));

    expect(response.status).toBe(400);
    const responseBody = (await response.json()) as { success: boolean; error?: string };
    expect(responseBody.success).toBe(false);
    expect(vi.mocked(edgeService.getEdges)).not.toHaveBeenCalled();
  });

  // A negative page size is meaningless; rejecting it stops it reaching SQL.
  it('rejects a negative limit with 400 and never reads edges', async () => {
    const response = await readEdgesRoute(buildEdgesGetRequest('?nodeId=1&limit=-5'));

    expect(response.status).toBe(400);
    expect(vi.mocked(edgeService.getEdges)).not.toHaveBeenCalled();
  });

  // Same for a negative offset: there is no page before the first one.
  it('rejects a negative offset with 400 and never reads edges', async () => {
    const response = await readEdgesRoute(buildEdgesGetRequest('?nodeId=1&offset=-1'));

    expect(response.status).toBe(400);
    expect(vi.mocked(edgeService.getEdges)).not.toHaveBeenCalled();
  });

  // A direction the read path does not implement must be an error, not a
  // silent fall back to 'both': a caller asking for the evidence side and
  // getting both sides would read edges that do not feed the node's credence.
  it('rejects an unknown direction with 400 and never reads edges', async () => {
    const response = await readEdgesRoute(buildEdgesGetRequest('?nodeId=1&direction=sideways'));

    expect(response.status).toBe(400);
    const responseBody = (await response.json()) as { success: boolean; error?: string };
    expect(responseBody.success).toBe(false);
    expect(vi.mocked(edgeService.getEdges)).not.toHaveBeenCalled();
  });

  // A non-numeric limit is the same class of defect as a non-numeric nodeId:
  // NaN must never be handed to SQL as a page size.
  it('rejects a non-numeric limit with 400 and never reads edges', async () => {
    const response = await readEdgesRoute(buildEdgesGetRequest('?nodeId=1&limit=lots'));

    expect(response.status).toBe(400);
    expect(vi.mocked(edgeService.getEdges)).not.toHaveBeenCalled();
  });

  // GUARD: an empty query string is still a valid read of the whole graph —
  // the UI depends on it — so adding validation must not turn "no filter" into
  // an error.
  it('GUARD: an empty query string still answers 200 with the edges the service returned', async () => {
    vi.mocked(edgeService.getEdges).mockResolvedValue(
      threeStateEdgeReadRows as unknown as Awaited<ReturnType<typeof edgeService.getEdges>>
    );

    const response = await readEdgesRoute(buildEdgesGetRequest(''));
    const responseBody = (await response.json()) as {
      success: boolean;
      data: BeliefEdgeReadRow[];
      count: number;
    };

    expect(response.status).toBe(200);
    expect(responseBody.success).toBe(true);
    expect(responseBody.count).toBe(3);
    expect(responseBody.data.map(edge => edge.id)).toEqual([11, 12, 13]);
  });
});
