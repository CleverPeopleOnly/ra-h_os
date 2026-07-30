/**
 * The queryEdge tool must narrow AND page a node-scoped edge read IN SQL
 * (src/tools/database/queryEdge.ts, backed by EdgeService.getEdges).
 *
 * The tool's directional branch calls edgeService.getEdges() with no argument —
 * the WHOLE edges table — JSON-parses every row of it, filters from_node_id /
 * to_node_id in memory, and only then slices a page off the front. PR#13 gave
 * getEdges a real SQL filter (BeliefEdgeReadFilter: nodeId + direction + limit
 * + offset), and both doors' schemas carry idx_edges_from and idx_edges_to, so
 * a filtered page and a matching COUNT are both index-backed. At the scale this
 * graph is expected to reach (100,000s of nodes) the uncapped read is a memory
 * failure mode, not merely wasted work.
 *
 * What this file pins:
 *   - a read about one node is narrowed in SQL: the filter handed to the edge
 *     service carries that node and the side of it being read,
 *   - EVERY read is capped: no filter handed to getEdges may omit limit. This
 *     deliberately rules out "get the total by reading the whole filtered set
 *     uncapped" — that read is exactly the failure mode being removed,
 *   - the reported numbers are three different facts and must not collapse into
 *     one: `edges` is the page, `returned_edge_count` is how many rows are in
 *     that page, and `matching_edge_count` is how many edges match the filter,
 *   - offset pages within the matching set, and a page past the end is empty
 *     while the matching count stays true,
 *   - offset is reachable by a real caller, i.e. it survives the advertised
 *     input schema (a direct execute() call bypasses schema parsing, so
 *     behaviour tests alone would pass for a filter no agent could ever send).
 *
 * HOW THE TOTAL IS OBTAINED IS THE IMPLEMENTER'S CHOICE. The stubbed edge
 * service below answers a filtered count under either of two method names
 * (getEdgeCount, countEdges), so the pins land on the reported VALUES rather
 * than on one query shape.
 *
 * The stub honours the filter the way SQLite does — WHERE narrows first, then
 * the order created_at DESC / id DESC, and LIMIT/OFFSET page the narrowed set
 * LAST. Capping last is what makes it faithful: a stub that capped before
 * filtering would flatter the in-memory implementation.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { BeliefEdgeReadFilter } from '@/types/database';

// One seeded edge row, in the shape queryEdge's directional branch passes
// straight back to its caller.
interface SeededEdgeRow {
  id: number;
  from_node_id: number;
  to_node_id: number;
  source: 'user' | 'ai_similarity' | 'helper_name';
  created_at: string;
}

// The node every read below is about, plus two others to hang edges off.
const CLAIM_NODE_ID = 1;
const BYSTANDER_NODE_ID = 2;
const OTHER_BYSTANDER_NODE_ID = 3;

// How many edges the main fixture hangs on each side of the claim node. Both
// counts exceed every page these tests ask for, so a page of one side can never
// be mistaken for the whole of that side.
const EDGES_PER_SIDE_OF_CLAIM_NODE = 60;

// How many of the claim node's outgoing edges came from similarity inference
// rather than from a person, so the source narrowing has something to remove.
const SIMILARITY_SOURCED_EDGES_OUT_OF_CLAIM_NODE = 5;

// The edges table the stubbed edge service reads, rebuilt per test.
let seededEdgeRows: SeededEdgeRow[] = [];
// Every filter the tool handed getEdges during one test, in order. An empty
// object here means a whole-table read; a filter with no limit means an
// uncapped read.
let edgeReadFiltersReceivedBySql: BeliefEdgeReadFilter[] = [];

// Apply a filter's WHERE and the read order, with no paging: the set a matching
// COUNT would count, in the order a page would be cut from.
function selectSeededEdgesForFilter(edgeReadFilter: BeliefEdgeReadFilter): SeededEdgeRow[] {
  const { nodeId, direction = 'both' } = edgeReadFilter;

  let narrowedRows = seededEdgeRows;
  if (nodeId !== undefined) {
    if (direction === 'into') {
      narrowedRows = narrowedRows.filter(row => row.to_node_id === nodeId);
    } else if (direction === 'out_of') {
      narrowedRows = narrowedRows.filter(row => row.from_node_id === nodeId);
    } else {
      // The OR branch: either side of the node. A row matching BOTH sides (a
      // self-edge) is still ONE row — SQL does not duplicate it.
      narrowedRows = narrowedRows.filter(
        row => row.from_node_id === nodeId || row.to_node_id === nodeId
      );
    }
  }

  // created_at DESC, then id DESC — the order the SQL read uses.
  return [...narrowedRows].sort((left, right) =>
    left.created_at === right.created_at
      ? right.id - left.id
      : left.created_at < right.created_at
        ? 1
        : -1
  );
}

// Cut one page out of an already-ordered set, exactly as LIMIT/OFFSET would.
function pageSeededEdges(
  orderedRows: SeededEdgeRow[],
  limit: number | undefined,
  offset: number | undefined
): SeededEdgeRow[] {
  const pageStart = offset ?? 0;
  return limit === undefined
    ? orderedRows.slice(pageStart)
    : orderedRows.slice(pageStart, pageStart + limit);
}

// Stand-in for EdgeService.getEdges: records the filter it was given, then
// answers the page that filter describes.
function readSeededEdgesThroughSqlFilter(
  edgeReadFilter: BeliefEdgeReadFilter = {}
): Promise<SeededEdgeRow[]> {
  edgeReadFiltersReceivedBySql.push(edgeReadFilter);
  return Promise.resolve(
    pageSeededEdges(
      selectSeededEdgesForFilter(edgeReadFilter),
      edgeReadFilter.limit,
      edgeReadFilter.offset
    )
  );
}

// Stand-in for a filtered COUNT: how many edges match the filter's WHERE,
// ignoring limit and offset — a total is not a page.
function countSeededEdgesForFilter(edgeReadFilter: BeliefEdgeReadFilter = {}): Promise<number> {
  return Promise.resolve(selectSeededEdgesForFilter(edgeReadFilter).length);
}

vi.mock('@/services/database/edges', () => ({
  edgeService: {
    getEdges: vi.fn((edgeReadFilter?: BeliefEdgeReadFilter) =>
      readSeededEdgesThroughSqlFilter(edgeReadFilter)
    ),
    // Either counting name is accepted, so the pins below constrain the
    // reported total rather than the call the implementer makes to get it.
    getEdgeCount: vi.fn((edgeReadFilter?: BeliefEdgeReadFilter) =>
      countSeededEdgesForFilter(edgeReadFilter)
    ),
    countEdges: vi.fn((edgeReadFilter?: BeliefEdgeReadFilter) =>
      countSeededEdgesForFilter(edgeReadFilter)
    ),
    getEdgeById: vi.fn(),
    getNodeConnections: vi.fn(),
  },
}));

import { queryEdgeTool } from '@/tools/database/queryEdge';

// The part of the tool's payload these tests read: the page itself, how many
// rows are in it, and how many edges match the query at all. Both counts say
// what they count in their own name, so neither can be mistaken for the other
// by a reader or by the agent consuming the payload.
interface QueryEdgeToolPayload {
  success: boolean;
  data?: {
    edges: SeededEdgeRow[];
    returned_edge_count: number;
    matching_edge_count: number;
  };
}

// Call the tool with the AI-SDK execute signature. The payload is re-typed
// through `unknown` because execute's inferred return type is a union of every
// branch's literal shape (plus an AsyncIterable), which never overlaps one
// branch's interface cleanly — so a direct cast turns a missing key into a
// COMPILE error and hides the runtime assertion that names the missing key.
async function callQueryEdgeTool(filters: Record<string, unknown>): Promise<QueryEdgeToolPayload> {
  const result = await queryEdgeTool.execute!({ filters } as never, {
    toolCallId: 'query-edge-node-filter-test',
    messages: [],
  });
  return result as unknown as QueryEdgeToolPayload;
}

// The tool's advertised input schema, as the minimal parsing surface these
// tests need. tool() from the AI SDK is the identity function, so this really is
// the zod schema an agent's arguments are parsed through before execute runs.
const queryEdgeToolInputSchema = queryEdgeTool.inputSchema as unknown as {
  safeParse(input: unknown): { success: boolean; data?: { filters?: Record<string, unknown> } };
};

// Assert the tool asked SQL for a capped page of ONE side of ONE node, on every
// read it made. Both halves matter: a read with no nodeId is a whole-table read,
// and a read with no limit is the uncapped read that cannot survive a graph with
// 100,000s of edges.
function expectEverySqlReadWasACappedPageOfOneNodeSide(
  expectedNodeId: number,
  expectedDirection: 'into' | 'out_of' | 'both'
): void {
  expect(edgeReadFiltersReceivedBySql.length).toBeGreaterThan(0);
  for (const edgeReadFilter of edgeReadFiltersReceivedBySql) {
    expect(
      edgeReadFilter.nodeId,
      'a read about one node must not read the whole edges table'
    ).toBe(expectedNodeId);
    expect(edgeReadFilter.direction).toBe(expectedDirection);
    expect(
      edgeReadFilter.limit,
      'every edge read must be a capped page — an uncapped read is the memory failure mode'
    ).not.toBeUndefined();
  }
}

// Build the main fixture: EDGES_PER_SIDE_OF_CLAIM_NODE edges out of the claim
// node and the same number into it, plus one edge touching the claim node on
// neither side and one that is the only edge running claim -> other bystander.
// Every row gets a distinct created_at so the read order is total.
function seedEdgesOnBothSidesOfClaimNode(): void {
  const rows: SeededEdgeRow[] = [];
  let nextEdgeId = 1;
  const nextCreatedAt = () => new Date(Date.UTC(2026, 6, 1) + nextEdgeId * 60_000).toISOString();

  for (let edgeIndex = 0; edgeIndex < EDGES_PER_SIDE_OF_CLAIM_NODE; edgeIndex += 1) {
    rows.push({
      id: nextEdgeId,
      from_node_id: CLAIM_NODE_ID,
      to_node_id: BYSTANDER_NODE_ID,
      source: edgeIndex < SIMILARITY_SOURCED_EDGES_OUT_OF_CLAIM_NODE ? 'ai_similarity' : 'user',
      created_at: nextCreatedAt(),
    });
    nextEdgeId += 1;

    rows.push({
      id: nextEdgeId,
      from_node_id: BYSTANDER_NODE_ID,
      to_node_id: CLAIM_NODE_ID,
      source: 'user',
      created_at: nextCreatedAt(),
    });
    nextEdgeId += 1;
  }

  // Touches the claim node on neither side: must never appear in a node read.
  rows.push({
    id: nextEdgeId,
    from_node_id: BYSTANDER_NODE_ID,
    to_node_id: OTHER_BYSTANDER_NODE_ID,
    source: 'user',
    created_at: nextCreatedAt(),
  });
  nextEdgeId += 1;

  // The only edge matching from_node_id = claim AND to_node_id = other.
  rows.push({
    id: nextEdgeId,
    from_node_id: CLAIM_NODE_ID,
    to_node_id: OTHER_BYSTANDER_NODE_ID,
    source: 'user',
    created_at: nextCreatedAt(),
  });

  seededEdgeRows = rows;
}

// Replace the fixture with three edges, one of which points from the claim node
// back at itself. The edges table has no CHECK forbidding that, so a self-edge
// is storable and must be returned and counted exactly ONCE per read.
function seedSelfEdgeAndOneEdgeOnEachSideOfClaimNode(): { selfEdgeId: number } {
  seededEdgeRows = [
    {
      id: 1,
      from_node_id: CLAIM_NODE_ID,
      to_node_id: CLAIM_NODE_ID,
      source: 'user',
      created_at: '2026-07-01T00:01:00.000Z',
    },
    {
      id: 2,
      from_node_id: CLAIM_NODE_ID,
      to_node_id: BYSTANDER_NODE_ID,
      source: 'user',
      created_at: '2026-07-01T00:02:00.000Z',
    },
    {
      id: 3,
      from_node_id: BYSTANDER_NODE_ID,
      to_node_id: CLAIM_NODE_ID,
      source: 'user',
      created_at: '2026-07-01T00:03:00.000Z',
    },
  ];
  return { selfEdgeId: 1 };
}

// How many seeded edges point AT the claim node — the true total of an 'into'
// read, computed from the fixture so it cannot drift.
function countSeededEdgesIntoClaimNode(): number {
  return seededEdgeRows.filter(row => row.to_node_id === CLAIM_NODE_ID).length;
}

// The ordered ids of every seeded edge pointing AT the claim node, so a test can
// name the exact page it expects without restating the sort.
function orderedEdgeIdsIntoClaimNode(): number[] {
  return selectSeededEdgesForFilter({ nodeId: CLAIM_NODE_ID, direction: 'into' }).map(
    row => row.id
  );
}

// The one edge id running claim -> other bystander, for the both-endpoints test.
function findOnlyEdgeIdFromClaimToOtherBystander(): number {
  const matchingRows = seededEdgeRows.filter(
    row => row.from_node_id === CLAIM_NODE_ID && row.to_node_id === OTHER_BYSTANDER_NODE_ID
  );
  expect(matchingRows).toHaveLength(1);
  return matchingRows[0].id;
}

beforeEach(() => {
  edgeReadFiltersReceivedBySql = [];
  seedEdgesOnBothSidesOfClaimNode();
});

describe('queryEdge tool node filtering', () => {
  // from_node_id asks for the edges LEAVING one node, which is exactly the
  // 'out_of' side of the SQL filter. Reading the whole table and filtering
  // afterwards shows up here as a filter with no nodeId on it; reading the whole
  // of one side shows up as a filter with no limit.
  it('asks SQL for a capped page of the out_of side of the node when from_node_id is given', async () => {
    await callQueryEdgeTool({ from_node_id: CLAIM_NODE_ID, limit: 50 });

    expectEverySqlReadWasACappedPageOfOneNodeSide(CLAIM_NODE_ID, 'out_of');
  });

  // to_node_id is the mirror side: the edges pointing AT the node, which the
  // belief engine reads as the evidence feeding that node's credence.
  it('asks SQL for a capped page of the into side of the node when to_node_id is given', async () => {
    await callQueryEdgeTool({ to_node_id: CLAIM_NODE_ID, limit: 50 });

    expectEverySqlReadWasACappedPageOfOneNodeSide(CLAIM_NODE_ID, 'into');
  });

  // The three reported quantities are three DIFFERENT facts, and the fixture
  // makes them numerically different so none can stand in for another: `edges`
  // is the page, `returned_edge_count` is how many rows are in that page, and
  // `matching_edge_count` is how many edges match the filter at all. An agent
  // deciding whether to ask for another page needs the matching count; an agent
  // summarising what it just read needs the returned count.
  it('reports the true matching count beside a smaller page when a node read is paged', async () => {
    const totalEdgesIntoClaimNode = countSeededEdgesIntoClaimNode();
    // Fixture sanity: the matching count must be well clear of the page below.
    expect(totalEdgesIntoClaimNode).toBe(EDGES_PER_SIDE_OF_CLAIM_NODE);

    const result = await callQueryEdgeTool({ to_node_id: CLAIM_NODE_ID, limit: 10 });

    expect(result.success).toBe(true);
    expect(result.data?.edges).toHaveLength(10);
    expect(
      result.data?.returned_edge_count,
      'returned_edge_count is the size of the page returned'
    ).toBe(10);
    expect(
      result.data?.matching_edge_count,
      'matching_edge_count is every edge matching the filter, not the page length'
    ).toBe(totalEdgesIntoClaimNode);
    // Stated separately so a regression reporting the page length as the
    // matching count fails on the relationship, not only on the arithmetic.
    expect(result.data?.matching_edge_count).not.toBe(result.data?.returned_edge_count);
    expectEverySqlReadWasACappedPageOfOneNodeSide(CLAIM_NODE_ID, 'into');
  });

  // A page position lands mid-set: the caller gets the remainder, and the
  // matching count is a property of the matching set, so paging through it
  // cannot change it.
  it('returns the remainder of the matching set for a page position inside it, with the matching count unchanged', async () => {
    const totalEdgesIntoClaimNode = countSeededEdgesIntoClaimNode();
    const lastPagePosition = totalEdgesIntoClaimNode - 5;

    const result = await callQueryEdgeTool({
      to_node_id: CLAIM_NODE_ID,
      limit: 10,
      offset: lastPagePosition,
    });

    expect(result.success).toBe(true);
    // Only five edges are left, so a page of ten returns five — and they are
    // the LAST five of the read order, not the first five.
    expect(result.data?.edges.map(edge => edge.id)).toEqual(
      orderedEdgeIdsIntoClaimNode().slice(lastPagePosition)
    );
    expect(result.data?.returned_edge_count).toBe(5);
    expect(result.data?.matching_edge_count).toBe(totalEdgesIntoClaimNode);

    expectEverySqlReadWasACappedPageOfOneNodeSide(CLAIM_NODE_ID, 'into');
    for (const edgeReadFilter of edgeReadFiltersReceivedBySql) {
      expect(
        edgeReadFilter.offset,
        'the page position must be applied in SQL, not by slicing a page off the front'
      ).toBe(lastPagePosition);
    }
  });

  // Past the end there is nothing to return, but "no rows on this page" and "no
  // matching edges at all" are different answers: an agent that paged one step
  // too far must still be told the set is 60 edges long, or it will conclude the
  // node has no evidence.
  it('returns an empty page past the end while still reporting the true matching count', async () => {
    const totalEdgesIntoClaimNode = countSeededEdgesIntoClaimNode();

    const result = await callQueryEdgeTool({
      to_node_id: CLAIM_NODE_ID,
      limit: 10,
      offset: totalEdgesIntoClaimNode,
    });

    expect(result.success).toBe(true);
    expect(result.data?.edges).toHaveLength(0);
    expect(result.data?.returned_edge_count).toBe(0);
    expect(
      result.data?.matching_edge_count,
      'a page past the end says nothing about how many edges match'
    ).toBe(totalEdgesIntoClaimNode);
  });

  // Offset has to survive the ADVERTISED schema, not just a direct execute()
  // call: zod strips keys the schema does not declare, so an offset the schema
  // never heard of is unreachable for every real caller (agent or MCP client)
  // even while the behaviour tests above pass. A negative offset is rejected
  // outright, matching the two doors PR#13 shipped — there is no page before the
  // first one, so clamping it silently would answer a different question.
  it('advertises offset on its input schema and rejects a negative page position', async () => {
    const parsedFilters = queryEdgeToolInputSchema.safeParse({
      filters: { to_node_id: CLAIM_NODE_ID, limit: 10, offset: 5 },
    });

    expect(parsedFilters.success).toBe(true);
    expect(
      parsedFilters.data?.filters?.offset,
      'an offset the input schema does not declare is stripped before the tool ever sees it'
    ).toBe(5);

    expect(
      queryEdgeToolInputSchema.safeParse({
        filters: { to_node_id: CLAIM_NODE_ID, offset: -1 },
      }).success,
      'there is no page before the first one'
    ).toBe(false);
  });

  // A self-edge matches a node on both sides at once. It is one row, so it is
  // one result and it counts once — on either side's read. (This door's inputs
  // reach the 'out_of' and 'into' sides only; the OR branch is not reachable
  // from queryEdge today, so the OR case is held by the stub's WHERE rather than
  // asserted through the tool.)
  it('returns and counts a self-edge exactly once on each side of the node', async () => {
    const { selfEdgeId } = seedSelfEdgeAndOneEdgeOnEachSideOfClaimNode();

    for (const nodeSideFilter of [
      { from_node_id: CLAIM_NODE_ID },
      { to_node_id: CLAIM_NODE_ID },
    ]) {
      const result = await callQueryEdgeTool({ ...nodeSideFilter, limit: 100 });

      const returnedEdgeIds = result.data?.edges.map(edge => edge.id) ?? [];
      expect(returnedEdgeIds.filter(edgeId => edgeId === selfEdgeId)).toHaveLength(1);
      // Two rows touch this side of the node: the self-edge and one other.
      expect(returnedEdgeIds).toHaveLength(2);
      expect(result.data?.returned_edge_count).toBe(2);
      expect(
        result.data?.matching_edge_count,
        'the self-edge must be counted once, not once per side it matches'
      ).toBe(2);
    }
  });

  // GUARD: the page a caller already gets must not change. 60 edges leave the
  // claim node (plus the one to the other bystander); a page of 50 outgoing
  // edges is 50 edges, every one of them leaving the claim node.
  it('GUARD: returns a full page of only the edges leaving the node', async () => {
    const result = await callQueryEdgeTool({ from_node_id: CLAIM_NODE_ID, limit: 50 });

    expect(result.success).toBe(true);
    expect(result.data?.edges).toHaveLength(50);
    for (const edge of result.data?.edges ?? []) {
      expect(edge.from_node_id).toBe(CLAIM_NODE_ID);
    }
  });

  // GUARD: the SQL filter narrows by ONE node and one side, so a query naming
  // both endpoints still needs its second endpoint narrowed somewhere. Whoever
  // does it, the answer is the edges matching both.
  it('GUARD: returns only edges matching both endpoints when from_node_id and to_node_id are given', async () => {
    const result = await callQueryEdgeTool({
      from_node_id: CLAIM_NODE_ID,
      to_node_id: OTHER_BYSTANDER_NODE_ID,
      limit: 100,
    });

    expect(result.success).toBe(true);
    expect(result.data?.edges.map(edge => edge.id)).toEqual([
      findOnlyEdgeIdFromClaimToOtherBystander(),
    ]);
  });

  // GUARD: source is not part of the SQL edge-read filter, so it stays a
  // narrowing the tool applies itself — and it must still narrow. The page asked
  // for here is larger than the whole matching side, so this holds whether
  // source ends up in the SQL WHERE or stays in memory.
  it('GUARD: still narrows a node read by edge source', async () => {
    const result = await callQueryEdgeTool({
      from_node_id: CLAIM_NODE_ID,
      source: 'ai_similarity',
      limit: 100,
    });

    expect(result.success).toBe(true);
    expect(result.data?.edges).toHaveLength(SIMILARITY_SOURCED_EDGES_OUT_OF_CLAIM_NODE);
    for (const edge of result.data?.edges ?? []) {
      expect(edge.source).toBe('ai_similarity');
      expect(edge.from_node_id).toBe(CLAIM_NODE_ID);
    }
  });

  // A query naming no node is still a legitimate whole-TABLE read — but it is
  // paged on the same terms as a node read. CHOICE MADE HERE: yes, paged. The
  // scale argument does not depend on a node being named — an unfiltered read of
  // a graph with 100,000s of edges is the larger failure, not the smaller one —
  // so the cap applies and the true whole-table matching count is reported
  // beside the page. The one thing that must NOT happen is inventing a node
  // scope the caller never asked for.
  it('pages the whole-table read and reports the true matching count when no node is named', async () => {
    const result = await callQueryEdgeTool({ limit: 100 });

    expect(result.success).toBe(true);
    expect(edgeReadFiltersReceivedBySql.length).toBeGreaterThan(0);
    for (const edgeReadFilter of edgeReadFiltersReceivedBySql) {
      expect(
        edgeReadFilter.nodeId,
        'a query naming no node must not be narrowed to one'
      ).toBeUndefined();
      expect(
        edgeReadFilter.limit,
        'an unfiltered read is the largest read there is, so it is capped too'
      ).not.toBeUndefined();
    }

    expect(result.data?.edges).toHaveLength(100);
    expect(result.data?.returned_edge_count).toBe(100);
    expect(result.data?.matching_edge_count).toBe(seededEdgeRows.length);
    // The distinctness pin again, on the unfiltered read: 122 edges match and
    // 100 came back, so one number can never stand in for the other.
    expect(result.data?.matching_edge_count).not.toBe(result.data?.returned_edge_count);
  });
});
