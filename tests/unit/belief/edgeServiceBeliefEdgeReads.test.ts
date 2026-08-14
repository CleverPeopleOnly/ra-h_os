/**
 * Filtered EDGE READS through the app's EdgeService
 * (src/services/database/edges.ts, method getEdges).
 *
 * This file pins the read surface of the app-backed door:
 *
 *  - getEdges takes a filter — node, direction, limit, offset — and applies it
 *    IN SQL rather than returning the entire edges table and trimming
 *    afterwards,
 *  - direction names which side of the node an edge sits on: 'into' means the
 *    node is the to_node_id, 'out_of' means the node is the from_node_id,
 *    'both' is either side and is the default,
 *  - paging with limit + offset is deterministic: the order is
 *    created_at DESC, id DESC, so paging to exhaustion returns every edge
 *    exactly once with no duplicates and no gaps even when several rows were
 *    written in the same millisecond (created_at alone is NOT a stable key —
 *    ties are possible; the id tiebreak makes the order total).
 *
 * deleted in the evidence-leaves-the-edges-table slice: the
 * returns-belief-columns-verbatim guard — edges carry no belief evidence any
 * more, so there are no belief columns for a read to return.
 *
 * Runs against a fresh temp-file database per test (see tempBeliefDatabase.ts).
 * Every edge is seeded with direct SQL, so no LLM inference path and no write
 * door is exercised — this file is about reads only.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// Which side of a node an edge read is asking for: 'into' matches
// to_node_id, 'out_of' matches from_node_id, 'both' is either side.
type BeliefEdgeReadDirection = 'into' | 'out_of' | 'both';

// The filter an edge read accepts. Param names match the ones the API route
// and both MCP doors use.
interface BeliefEdgeReadFilter {
  nodeId?: number;
  direction?: BeliefEdgeReadDirection;
  limit?: number;
  offset?: number;
}

// One edge row as an edge read must return it: the plain relationship
// columns — no edge carries belief evidence any more.
interface BeliefEdgeReadRow {
  id: number;
  from_node_id: number;
  to_node_id: number;
  created_at: string;
}

// Call EdgeService.getEdges as a filtered read.
function readEdgesWithFilter(
  edgeServiceModule: typeof import('@/services/database/edges'),
  filter?: BeliefEdgeReadFilter
): Promise<BeliefEdgeReadRow[]> {
  const filteredEdgeReader = edgeServiceModule.edgeService.getEdges.bind(
    edgeServiceModule.edgeService
  ) as unknown as (edgeReadFilter?: BeliefEdgeReadFilter) => Promise<BeliefEdgeReadRow[]>;
  return filteredEdgeReader(filter);
}

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// Timestamps used by the ordering fixtures. The middle one is shared by
// several rows on purpose: it is the tie the id tiebreak has to resolve.
const OLDER_EDGE_CREATED_AT = '2026-07-01T00:00:00.000Z';
const TIED_EDGE_CREATED_AT = '2026-07-02T00:00:00.000Z';
const NEWER_EDGE_CREATED_AT = '2026-07-03T00:00:00.000Z';

// Seed one plain relationship edge row directly, with full control over its
// created_at (the paging and ordering key under test).
function insertEdgeReadFixture(
  context: TempBeliefDatabase,
  options: {
    fromNodeId: number;
    toNodeId: number;
    createdAt: string;
  }
): number {
  const result = context.sqlite
    .prepare(
      `INSERT INTO edges
         (from_node_id, to_node_id, source, explanation, created_at)
       VALUES (?, ?, 'user', 'edge read fixture', ?)`
    )
    .run(options.fromNodeId, options.toNodeId, options.createdAt);
  return Number(result.lastInsertRowid);
}

// The graph every direction test reads from: one claim node with edges on both
// sides of it, plus an edge between two other nodes that must never appear in
// a node-scoped read.
interface DirectionFixtureGraph {
  claimNodeId: number;
  newerEdgeIntoClaimId: number;
  tiedEdgeIntoClaimId: number;
  secondTiedEdgeIntoClaimId: number;
  edgeOutOfClaimId: number;
  unrelatedEdgeId: number;
}

// Seed the direction fixture graph described above.
function seedDirectionFixtureGraph(context: TempBeliefDatabase): DirectionFixtureGraph {
  const claimNodeId = context.insertNodeFixture({ title: 'Claim node under read' });
  const firstNeighbourNodeId = context.insertNodeFixture({
    title: 'First neighbour pointing at the claim',
  });
  const secondNeighbourNodeId = context.insertNodeFixture({
    title: 'Second neighbour pointing at the claim',
  });
  const bystanderNodeId = context.insertNodeFixture({ title: 'Bystander node' });
  const otherBystanderNodeId = context.insertNodeFixture({ title: 'Second bystander node' });

  return {
    claimNodeId,
    newerEdgeIntoClaimId: insertEdgeReadFixture(context, {
      fromNodeId: firstNeighbourNodeId,
      toNodeId: claimNodeId,
      createdAt: NEWER_EDGE_CREATED_AT,
    }),
    tiedEdgeIntoClaimId: insertEdgeReadFixture(context, {
      fromNodeId: secondNeighbourNodeId,
      toNodeId: claimNodeId,
      createdAt: TIED_EDGE_CREATED_AT,
    }),
    secondTiedEdgeIntoClaimId: insertEdgeReadFixture(context, {
      fromNodeId: bystanderNodeId,
      toNodeId: claimNodeId,
      createdAt: TIED_EDGE_CREATED_AT,
    }),
    // An edge leaving the claim node.
    edgeOutOfClaimId: insertEdgeReadFixture(context, {
      fromNodeId: claimNodeId,
      toNodeId: bystanderNodeId,
      createdAt: OLDER_EDGE_CREATED_AT,
    }),
    // An edge that touches the claim node on neither side.
    unrelatedEdgeId: insertEdgeReadFixture(context, {
      fromNodeId: bystanderNodeId,
      toNodeId: otherBystanderNodeId,
      createdAt: OLDER_EDGE_CREATED_AT,
    }),
  };
}

describe('EdgeService.getEdges filtered edge reads', () => {
  // Direction 'into': only edges whose to_node_id is the node.
  it('reads only edges whose to_node_id is the node when direction is into', async () => {
    db = await openTempBeliefDatabase();
    const graph = seedDirectionFixtureGraph(db);
    const edgeServiceModule = await db.importEdgeService();

    const edgesIntoClaim = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: graph.claimNodeId,
      direction: 'into',
    });

    expect(edgesIntoClaim.map(edge => edge.id).sort((a, b) => a - b)).toEqual(
      [
        graph.newerEdgeIntoClaimId,
        graph.tiedEdgeIntoClaimId,
        graph.secondTiedEdgeIntoClaimId,
      ].sort((a, b) => a - b)
    );
    // Every returned edge really does point AT the node.
    for (const edge of edgesIntoClaim) {
      expect(edge.to_node_id).toBe(graph.claimNodeId);
    }
  });

  // The mirror side: 'out_of' is the edges the node itself supplies.
  it('reads only edges whose from_node_id is the node when direction is out_of', async () => {
    db = await openTempBeliefDatabase();
    const graph = seedDirectionFixtureGraph(db);
    const edgeServiceModule = await db.importEdgeService();

    const edgesOutOfClaim = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: graph.claimNodeId,
      direction: 'out_of',
    });

    expect(edgesOutOfClaim.map(edge => edge.id)).toEqual([graph.edgeOutOfClaimId]);
    expect(edgesOutOfClaim[0].from_node_id).toBe(graph.claimNodeId);
  });

  // 'both' is the default and the pre-existing behaviour: either side of the
  // node — and, critically, ONLY the node's own edges. An edge between two
  // other nodes must not come back, which is what the unfiltered
  // whole-table read does today.
  it('reads edges on either side of the node and no others when direction is both', async () => {
    db = await openTempBeliefDatabase();
    const graph = seedDirectionFixtureGraph(db);
    const edgeServiceModule = await db.importEdgeService();

    const edgesOnBothSides = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: graph.claimNodeId,
      direction: 'both',
    });
    const edgeIdsOnBothSides = edgesOnBothSides.map(edge => edge.id);

    expect(edgeIdsOnBothSides.sort((a, b) => a - b)).toEqual(
      [
        graph.newerEdgeIntoClaimId,
        graph.tiedEdgeIntoClaimId,
        graph.secondTiedEdgeIntoClaimId,
        graph.edgeOutOfClaimId,
      ].sort((a, b) => a - b)
    );
    expect(edgeIdsOnBothSides).not.toContain(graph.unrelatedEdgeId);
  });

  // Omitting the direction must mean 'both', so an existing node-scoped caller
  // keeps the behaviour it has today.
  it('treats an omitted direction as both', async () => {
    db = await openTempBeliefDatabase();
    const graph = seedDirectionFixtureGraph(db);
    const edgeServiceModule = await db.importEdgeService();

    const withoutDirection = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: graph.claimNodeId,
    });
    const withExplicitBoth = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: graph.claimNodeId,
      direction: 'both',
    });

    expect(withoutDirection.map(edge => edge.id)).toEqual(withExplicitBoth.map(edge => edge.id));
  });

  // The discriminating test for "filtered in SQL, not client-side": 60 edges
  // point at the node and 60 leave it, and a read of the 'into' side capped at
  // 50 must return 50 into-edges. A read that fetched a limited page first and
  // filtered afterwards would return roughly half that.
  it('applies the direction filter in SQL rather than trimming a limited page afterwards', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'Busy claim node' });
    // One neighbour node per iteration: the direction-slot UNIQUE index
    // outlaws same-slot parallels, so the filler fans out — each neighbour
    // contributes one into-edge and one out-of-edge (a legal bidirectional
    // pair). Interleaved so any client-side trim of a 50-row page would keep
    // only about half of the into-edges.
    for (let edgeIndex = 0; edgeIndex < 60; edgeIndex += 1) {
      const neighbourNodeId = db.insertNodeFixture({
        title: `Busy neighbour node ${edgeIndex}`,
      });
      insertEdgeReadFixture(db, {
        fromNodeId: neighbourNodeId,
        toNodeId: claimNodeId,
        createdAt: TIED_EDGE_CREATED_AT,
      });
      insertEdgeReadFixture(db, {
        fromNodeId: claimNodeId,
        toNodeId: neighbourNodeId,
        createdAt: TIED_EDGE_CREATED_AT,
      });
    }
    const edgeServiceModule = await db.importEdgeService();

    const firstFiftyEdgesIntoClaim = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: claimNodeId,
      direction: 'into',
      limit: 50,
    });

    expect(firstFiftyEdgesIntoClaim).toHaveLength(50);
    for (const edge of firstFiftyEdgesIntoClaim) {
      expect(edge.to_node_id).toBe(claimNodeId);
    }
  });

  // Paging to exhaustion must reconstruct the whole set exactly once: no
  // duplicates and no gaps. All ten edges share one created_at, so this only
  // holds if the order carries a tiebreak beyond the timestamp.
  it('pages through a seeded set with limit and offset, returning every edge exactly once', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'Paged claim node' });
    // One neighbour node per seeded edge — the direction-slot UNIQUE index
    // outlaws stacking ten rows into one slot, so the ten into-edges fan out
    // from ten distinct neighbours.
    const seededEdgeIds = Array.from({ length: 10 }, (_, neighbourIndex) =>
      insertEdgeReadFixture(db as TempBeliefDatabase, {
        fromNodeId: (db as TempBeliefDatabase).insertNodeFixture({
          title: `Paged neighbour node ${neighbourIndex}`,
        }),
        toNodeId: claimNodeId,
        createdAt: TIED_EDGE_CREATED_AT,
      })
    );
    const edgeServiceModule = await db.importEdgeService();

    const firstPage = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: claimNodeId,
      direction: 'into',
      limit: 5,
      offset: 0,
    });
    const secondPage = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: claimNodeId,
      direction: 'into',
      limit: 5,
      offset: 5,
    });

    expect(firstPage).toHaveLength(5);
    expect(secondPage).toHaveLength(5);

    const pagedEdgeIds = [...firstPage, ...secondPage].map(edge => edge.id);
    // No duplicates...
    expect(new Set(pagedEdgeIds).size).toBe(10);
    // ...and no gaps: the two pages are exactly the seeded set.
    expect(pagedEdgeIds.sort((a, b) => a - b)).toEqual(seededEdgeIds.sort((a, b) => a - b));

    // Paging past the end returns nothing rather than wrapping around.
    const thirdPage = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: claimNodeId,
      direction: 'into',
      limit: 5,
      offset: 10,
    });
    expect(thirdPage).toHaveLength(0);
  });

  // The ordering key itself: created_at DESC, then id DESC. created_at alone
  // cannot order the three tied rows, and SQLite is free to return tied rows
  // in any order, so without the id tiebreak two pages could overlap or skip
  // a row. Pinning the exact sequence is what makes the paging test above
  // mean something.
  it('orders edge reads by created_at DESC then id DESC so tied timestamps still page deterministically', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'Ordered claim node' });
    // One neighbour node per edge (the direction-slot UNIQUE index outlaws
    // same-slot parallels); the tie the ordering must break is on created_at,
    // which the distinct slots leave untouched.
    const insertIntoEdgeFromOwnNeighbour = (neighbourTitle: string, createdAt: string): number =>
      insertEdgeReadFixture(db as TempBeliefDatabase, {
        fromNodeId: (db as TempBeliefDatabase).insertNodeFixture({ title: neighbourTitle }),
        toNodeId: claimNodeId,
        createdAt,
      });

    // Inserted oldest-timestamp-first so insert order and expected read order
    // are not accidentally the same sequence.
    const oldestEdgeId = insertIntoEdgeFromOwnNeighbour(
      'Ordered neighbour node (oldest edge)',
      OLDER_EDGE_CREATED_AT
    );
    const firstTiedEdgeId = insertIntoEdgeFromOwnNeighbour(
      'Ordered neighbour node (first tied edge)',
      TIED_EDGE_CREATED_AT
    );
    const secondTiedEdgeId = insertIntoEdgeFromOwnNeighbour(
      'Ordered neighbour node (second tied edge)',
      TIED_EDGE_CREATED_AT
    );
    const thirdTiedEdgeId = insertIntoEdgeFromOwnNeighbour(
      'Ordered neighbour node (third tied edge)',
      TIED_EDGE_CREATED_AT
    );
    const newestEdgeId = insertIntoEdgeFromOwnNeighbour(
      'Ordered neighbour node (newest edge)',
      NEWER_EDGE_CREATED_AT
    );
    const edgeServiceModule = await db.importEdgeService();

    // Newest timestamp first; within the tie, the highest id first.
    const expectedReadOrder = [
      newestEdgeId,
      thirdTiedEdgeId,
      secondTiedEdgeId,
      firstTiedEdgeId,
      oldestEdgeId,
    ];

    const wholeSet = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: claimNodeId,
      direction: 'into',
    });
    expect(wholeSet.map(edge => edge.id)).toEqual(expectedReadOrder);

    // The same order has to hold page by page, which is the property paging
    // depends on.
    const firstPage = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: claimNodeId,
      direction: 'into',
      limit: 2,
      offset: 0,
    });
    const secondPage = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: claimNodeId,
      direction: 'into',
      limit: 2,
      offset: 2,
    });
    const thirdPage = await readEdgesWithFilter(edgeServiceModule, {
      nodeId: claimNodeId,
      direction: 'into',
      limit: 2,
      offset: 4,
    });
    expect([...firstPage, ...secondPage, ...thirdPage].map(edge => edge.id)).toEqual(
      expectedReadOrder
    );
  });

  // GUARD: the existing unfiltered caller (src/tools/database/queryEdge.ts
  // reads the whole table and filters in memory) must keep getting every edge,
  // so adding the filter must not introduce a silent default limit.
  it('GUARD: an unfiltered read still returns every edge in the table', async () => {
    db = await openTempBeliefDatabase();
    const graph = seedDirectionFixtureGraph(db);
    const edgeServiceModule = await db.importEdgeService();

    const allEdges = await readEdgesWithFilter(edgeServiceModule);

    expect(allEdges.map(edge => edge.id).sort((a, b) => a - b)).toEqual(
      [
        graph.newerEdgeIntoClaimId,
        graph.tiedEdgeIntoClaimId,
        graph.secondTiedEdgeIntoClaimId,
        graph.edgeOutOfClaimId,
        graph.unrelatedEdgeId,
      ].sort((a, b) => a - b)
    );
  });
});
