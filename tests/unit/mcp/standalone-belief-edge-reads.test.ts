/**
 * Filtered EDGE READS through the standalone MCP server
 * (apps/mcp-server-standalone/index.js, tool queryEdge, backed by
 * apps/mcp-server-standalone/services/edgeService.js getEdges).
 *
 * The standalone server is the second door into the same SQLite database.
 * This file pins the same filter contract as the app-backed door, so the two
 * doors answer the same questions the same way:
 *
 *  - direction picks the side: 'into' means the node is the to_node_id,
 *    'out_of' means the node is the from_node_id, 'both' is either side and
 *    is the default,
 *  - the direction filter runs in SQL, not after the page cap,
 *  - limit + offset page deterministically over the order
 *    created_at DESC, id DESC, so paging to exhaustion returns every edge
 *    exactly once with no duplicates and no gaps even when rows share a
 *    timestamp,
 *  - a direction the read path does not implement is a tool error, and the
 *    advertised input schema names all four filter parts.
 *
 * deleted in the evidence-leaves-the-edges-table slice: the
 * surfaces-support-and-contribution test — the standalone edge tools shed
 * the evidence read fields, pinned in
 * standalone-edge-tools-shed-evidence.test.ts — and every fixture writes a
 * plain relationship edge, the only kind there is.
 *
 * SAFETY: every database in this file is a fresh temp file under os.tmpdir()
 * (HOME and RAH_DB_PATH are both pinned into the temp root before the server
 * process spawns). The spawned server is always terminated in the finally
 * block of withStandaloneClient, so no orphan processes survive a failure.
 *
 * SAFETY, second rule (same as tests/unit/mcp/standalone-belief-surface.test.ts):
 * this file deliberately imports NOTHING from src/. It drives a spawned server
 * process and has no temp-database seam of its own, so importing any app module
 * would pull in '@/services/database/sqlite-client' — which opens its database
 * file as a module-load side effect and would therefore open the user's REAL
 * database.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';

// Temp root holding this file's fake HOME and database files.
let tempRoot: string;
// Fake HOME handed to every spawned server process.
let tempHome: string;
// Path of the seeded database the MCP server under test opens.
let dbPath: string;

// Absolute path of the standalone server entry point under test.
const standaloneServerEntryPath = path.join(
  process.cwd(),
  'apps',
  'mcp-server-standalone',
  'index.js'
);

// Timestamps used by the ordering fixtures. The middle one is shared by
// several rows on purpose: it is the tie the id tiebreak has to resolve.
const OLDER_EDGE_CREATED_AT = '2026-07-01T00:00:00.000Z';
const TIED_EDGE_CREATED_AT = '2026-07-02T00:00:00.000Z';
const NEWER_EDGE_CREATED_AT = '2026-07-03T00:00:00.000Z';

// Node ids seeded by createStandaloneDbWithBeliefSchema: the node whose edges
// every read below is about, and four others to hang edges off.
const CLAIM_NODE_ID = 1;
const FIRST_NEIGHBOUR_NODE_ID = 2;
const SECOND_NEIGHBOUR_NODE_ID = 3;
const BYSTANDER_NODE_ID = 4;
const OTHER_BYSTANDER_NODE_ID = 5;

// Seed a database carrying the belief NODE schema, a plain edges table with
// no evidence columns, and five nodes. Edges are seeded per test, because
// each read test needs a different shape.
function createStandaloneDbWithBeliefSchema(targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const db = new Database(targetPath);

  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      title TEXT,
      description TEXT,
      source TEXT,
      link TEXT,
      event_date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT,
      embedding BLOB,
      embedding_updated_at TEXT,
      embedding_text TEXT,
      chunk_status TEXT DEFAULT 'not_chunked',
      belief_credence REAL,
      belief_computed_at TEXT,
      belief_credence_is_fixed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      from_node_id INTEGER NOT NULL,
      to_node_id INTEGER NOT NULL,
      source TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      context TEXT,
      explanation TEXT
    );

    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL,
      chunk_idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding_type TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE belief_movements (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL,
      from_credence REAL,
      to_credence REAL NOT NULL,
      "trigger" TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
  `);

  const now = new Date().toISOString();
  const insertNode = db.prepare(`
    INSERT INTO nodes (id, title, description, source, created_at, updated_at, metadata, chunk_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'not_chunked')
  `);

  const seededNodeTitles: Array<[number, string]> = [
    [CLAIM_NODE_ID, 'Claim node under read'],
    [FIRST_NEIGHBOUR_NODE_ID, 'First neighbour node'],
    [SECOND_NEIGHBOUR_NODE_ID, 'Second neighbour node'],
    [BYSTANDER_NODE_ID, 'Bystander node'],
    [OTHER_BYSTANDER_NODE_ID, 'Second bystander node'],
  ];

  for (const [nodeId, title] of seededNodeTitles) {
    insertNode.run(
      nodeId,
      title,
      `${title} description`,
      `${title} source text`,
      now,
      now,
      JSON.stringify({ captured_by: 'human' })
    );
  }

  db.close();
}

// Seed one plain relationship edge row straight into the temp database file,
// with full control over its created_at (the paging and ordering key under
// test).
function insertEdgeReadFixture(options: {
  fromNodeId: number;
  toNodeId: number;
  createdAt: string;
}): number {
  const directDb = new Database(dbPath, { fileMustExist: true });
  try {
    directDb.pragma('busy_timeout = 5000');
    const result = directDb
      .prepare(
        `INSERT INTO edges
           (from_node_id, to_node_id, source, created_at, context, explanation)
         VALUES (?, ?, 'mcp', ?, ?, 'edge read fixture')`
      )
      .run(
        options.fromNodeId,
        options.toNodeId,
        options.createdAt,
        JSON.stringify({ type: 'related_to', explanation: 'edge read fixture' })
      );
    return Number(result.lastInsertRowid);
  } finally {
    directDb.close();
  }
}

// The edge ids of the graph every direction test reads from.
interface DirectionFixtureGraph {
  newerEdgeIntoClaimId: number;
  tiedEdgeIntoClaimId: number;
  secondTiedEdgeIntoClaimId: number;
  edgeOutOfClaimId: number;
  unrelatedEdgeId: number;
}

// Seed one claim node with edges on both sides of it, plus an edge between two
// other nodes that must never appear in a node-scoped read.
function seedDirectionFixtureGraph(): DirectionFixtureGraph {
  return {
    newerEdgeIntoClaimId: insertEdgeReadFixture({
      fromNodeId: FIRST_NEIGHBOUR_NODE_ID,
      toNodeId: CLAIM_NODE_ID,
      createdAt: NEWER_EDGE_CREATED_AT,
    }),
    tiedEdgeIntoClaimId: insertEdgeReadFixture({
      fromNodeId: SECOND_NEIGHBOUR_NODE_ID,
      toNodeId: CLAIM_NODE_ID,
      createdAt: TIED_EDGE_CREATED_AT,
    }),
    secondTiedEdgeIntoClaimId: insertEdgeReadFixture({
      fromNodeId: BYSTANDER_NODE_ID,
      toNodeId: CLAIM_NODE_ID,
      createdAt: TIED_EDGE_CREATED_AT,
    }),
    edgeOutOfClaimId: insertEdgeReadFixture({
      fromNodeId: CLAIM_NODE_ID,
      toNodeId: BYSTANDER_NODE_ID,
      createdAt: OLDER_EDGE_CREATED_AT,
    }),
    unrelatedEdgeId: insertEdgeReadFixture({
      fromNodeId: BYSTANDER_NODE_ID,
      toNodeId: OTHER_BYSTANDER_NODE_ID,
      createdAt: OLDER_EDGE_CREATED_AT,
    }),
  };
}

// Spawn the standalone server against the seeded temp database, run the
// callback against a connected MCP client, then ALWAYS close the transport
// (which terminates the spawned server process).
async function withStandaloneClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [standaloneServerEntryPath],
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tempHome,
      RAH_DB_PATH: dbPath,
    } as Record<string, string>,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'ra-h-standalone-belief-edge-reads-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// Extract a tool call's structured content with a caller-chosen shape.
function getStructured<T>(result: unknown): T {
  return (result as { structuredContent?: unknown }).structuredContent as T;
}

// One edge as the standalone read must report it: the plain relationship
// columns — no edge carries belief evidence any more.
interface BeliefEdgeReadRow {
  id: number;
  from_node_id: number;
  to_node_id: number;
}

// The structured payload queryEdge answers with.
interface QueryEdgeStructuredContent {
  count: number;
  edges: BeliefEdgeReadRow[];
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-standalone-edge-reads-test-'));
  tempHome = path.join(tempRoot, 'home');
  dbPath = path.join(tempHome, 'Library', 'Application Support', 'RA-H', 'db', 'rah.sqlite');
});

beforeEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  createStandaloneDbWithBeliefSchema(dbPath);
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('standalone MCP server queryEdge filtered edge reads', () => {
  // Direction 'into': only edges whose to_node_id is the node.
  it('reads only edges whose to_node_id is the node when direction is into', async () => {
    const graph = seedDirectionFixtureGraph();

    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'queryEdge',
        arguments: { nodeId: CLAIM_NODE_ID, direction: 'into' },
      });

      const structured = getStructured<QueryEdgeStructuredContent>(result);
      expect(structured.edges.map(edge => edge.id).sort((a, b) => a - b)).toEqual(
        [
          graph.newerEdgeIntoClaimId,
          graph.tiedEdgeIntoClaimId,
          graph.secondTiedEdgeIntoClaimId,
        ].sort((a, b) => a - b)
      );
      for (const edge of structured.edges) {
        expect(edge.to_node_id).toBe(CLAIM_NODE_ID);
      }
    });
  });

  // The mirror side: 'out_of' is the edges the node itself supplies.
  it('reads only edges whose from_node_id is the node when direction is out_of', async () => {
    const graph = seedDirectionFixtureGraph();

    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'queryEdge',
        arguments: { nodeId: CLAIM_NODE_ID, direction: 'out_of' },
      });

      const structured = getStructured<QueryEdgeStructuredContent>(result);
      expect(structured.edges.map(edge => edge.id)).toEqual([graph.edgeOutOfClaimId]);
      expect(structured.edges[0].from_node_id).toBe(CLAIM_NODE_ID);
    });
  });

  // GUARD: 'both' is the default and the behaviour this door already has —
  // either side of the node, and only the node's own edges.
  it('GUARD: reads edges on either side of the node and no others when direction is omitted', async () => {
    const graph = seedDirectionFixtureGraph();

    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'queryEdge',
        arguments: { nodeId: CLAIM_NODE_ID },
      });

      const structured = getStructured<QueryEdgeStructuredContent>(result);
      const readEdgeIds = structured.edges.map(edge => edge.id);
      expect(readEdgeIds.sort((a, b) => a - b)).toEqual(
        [
          graph.newerEdgeIntoClaimId,
          graph.tiedEdgeIntoClaimId,
          graph.secondTiedEdgeIntoClaimId,
          graph.edgeOutOfClaimId,
        ].sort((a, b) => a - b)
      );
      expect(readEdgeIds).not.toContain(graph.unrelatedEdgeId);
    });
  });

  // The discriminating test for "filtered in SQL, not client-side": 60 edges
  // point at the node and 60 leave it, and a read of the 'into' side capped at
  // 50 must return 50 into-edges. A read that fetched a limited page first and
  // filtered afterwards would return roughly half that.
  it('applies the direction filter in SQL rather than trimming a limited page afterwards', async () => {
    for (let edgeIndex = 0; edgeIndex < 60; edgeIndex += 1) {
      insertEdgeReadFixture({
        fromNodeId: BYSTANDER_NODE_ID,
        toNodeId: CLAIM_NODE_ID,
        createdAt: TIED_EDGE_CREATED_AT,
      });
      insertEdgeReadFixture({
        fromNodeId: CLAIM_NODE_ID,
        toNodeId: BYSTANDER_NODE_ID,
        createdAt: TIED_EDGE_CREATED_AT,
      });
    }

    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'queryEdge',
        arguments: { nodeId: CLAIM_NODE_ID, direction: 'into', limit: 50 },
      });

      const structured = getStructured<QueryEdgeStructuredContent>(result);
      expect(structured.edges).toHaveLength(50);
      for (const edge of structured.edges) {
        expect(edge.to_node_id).toBe(CLAIM_NODE_ID);
      }
    });
  });

  // Paging to exhaustion must reconstruct the whole set exactly once: no
  // duplicates and no gaps. All ten edges share one created_at, so this only
  // holds if the order carries a tiebreak beyond the timestamp.
  it('pages through a seeded set with limit and offset, returning every edge exactly once', async () => {
    const seededEdgeIds = Array.from({ length: 10 }, () =>
      insertEdgeReadFixture({
        fromNodeId: BYSTANDER_NODE_ID,
        toNodeId: CLAIM_NODE_ID,
        createdAt: TIED_EDGE_CREATED_AT,
      })
    );

    await withStandaloneClient(async (client) => {
      const firstPage = getStructured<QueryEdgeStructuredContent>(
        await client.callTool({
          name: 'queryEdge',
          arguments: { nodeId: CLAIM_NODE_ID, direction: 'into', limit: 5, offset: 0 },
        })
      );
      const secondPage = getStructured<QueryEdgeStructuredContent>(
        await client.callTool({
          name: 'queryEdge',
          arguments: { nodeId: CLAIM_NODE_ID, direction: 'into', limit: 5, offset: 5 },
        })
      );

      expect(firstPage.edges).toHaveLength(5);
      expect(secondPage.edges).toHaveLength(5);

      const pagedEdgeIds = [...firstPage.edges, ...secondPage.edges].map(edge => edge.id);
      // No duplicates...
      expect(new Set(pagedEdgeIds).size).toBe(10);
      // ...and no gaps: the two pages are exactly the seeded set.
      expect(pagedEdgeIds.sort((a, b) => a - b)).toEqual(seededEdgeIds.sort((a, b) => a - b));

      // Paging past the end returns nothing rather than wrapping around.
      const thirdPage = getStructured<QueryEdgeStructuredContent>(
        await client.callTool({
          name: 'queryEdge',
          arguments: { nodeId: CLAIM_NODE_ID, direction: 'into', limit: 5, offset: 10 },
        })
      );
      expect(thirdPage.edges).toHaveLength(0);
    });
  });

  // The ordering key itself: created_at DESC, then id DESC — the same key as
  // the app-backed door, so the two doors page identically. created_at alone
  // cannot order the three tied rows and SQLite may return tied rows in any
  // order, so without the id tiebreak two pages could overlap or skip a row.
  it('orders edge reads by created_at DESC then id DESC so tied timestamps still page deterministically', async () => {
    // Inserted oldest-timestamp-first so insert order and expected read order
    // are not accidentally the same sequence.
    const oldestEdgeId = insertEdgeReadFixture({
      fromNodeId: BYSTANDER_NODE_ID,
      toNodeId: CLAIM_NODE_ID,
      createdAt: OLDER_EDGE_CREATED_AT,
    });
    const firstTiedEdgeId = insertEdgeReadFixture({
      fromNodeId: BYSTANDER_NODE_ID,
      toNodeId: CLAIM_NODE_ID,
      createdAt: TIED_EDGE_CREATED_AT,
    });
    const secondTiedEdgeId = insertEdgeReadFixture({
      fromNodeId: BYSTANDER_NODE_ID,
      toNodeId: CLAIM_NODE_ID,
      createdAt: TIED_EDGE_CREATED_AT,
    });
    const thirdTiedEdgeId = insertEdgeReadFixture({
      fromNodeId: BYSTANDER_NODE_ID,
      toNodeId: CLAIM_NODE_ID,
      createdAt: TIED_EDGE_CREATED_AT,
    });
    const newestEdgeId = insertEdgeReadFixture({
      fromNodeId: BYSTANDER_NODE_ID,
      toNodeId: CLAIM_NODE_ID,
      createdAt: NEWER_EDGE_CREATED_AT,
    });

    // Newest timestamp first; within the tie, the highest id first.
    const expectedReadOrder = [
      newestEdgeId,
      thirdTiedEdgeId,
      secondTiedEdgeId,
      firstTiedEdgeId,
      oldestEdgeId,
    ];

    await withStandaloneClient(async (client) => {
      const wholeSet = getStructured<QueryEdgeStructuredContent>(
        await client.callTool({
          name: 'queryEdge',
          arguments: { nodeId: CLAIM_NODE_ID, direction: 'into' },
        })
      );
      expect(wholeSet.edges.map(edge => edge.id)).toEqual(expectedReadOrder);

      // The same order has to hold page by page, which is the property paging
      // depends on.
      const pagedEdgeIds: number[] = [];
      for (const pageOffset of [0, 2, 4]) {
        const page = getStructured<QueryEdgeStructuredContent>(
          await client.callTool({
            name: 'queryEdge',
            arguments: { nodeId: CLAIM_NODE_ID, direction: 'into', limit: 2, offset: pageOffset },
          })
        );
        pagedEdgeIds.push(...page.edges.map(edge => edge.id));
      }
      expect(pagedEdgeIds).toEqual(expectedReadOrder);
    });
  });

  // A direction the read path does not implement must be a tool error, not a
  // silent fall back to both sides: an agent asking for one side of a node
  // and getting both would draw a conclusion from the wrong half of the
  // graph.
  it('rejects an unknown direction with a tool error', async () => {
    seedDirectionFixtureGraph();

    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'queryEdge',
        arguments: { nodeId: CLAIM_NODE_ID, direction: 'sideways' },
      });

      expect(
        (result as { isError?: boolean }).isError,
        'a direction outside into / out_of / both must be rejected'
      ).toBe(true);
    });
  });

  // There is no page before the first one, so a negative offset is an invalid
  // read rather than something to clamp silently.
  it('rejects a negative offset with a tool error', async () => {
    seedDirectionFixtureGraph();

    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'queryEdge',
        arguments: { nodeId: CLAIM_NODE_ID, offset: -1 },
      });

      expect((result as { isError?: boolean }).isError, 'offset cannot be negative').toBe(true);
    });
  });

  // Discoverability: an external agent learns what it can ask for from the
  // advertised schema, so all four filter parts and the three direction values
  // must appear on it.
  it('advertises nodeId, direction, limit and offset on the queryEdge input schema', async () => {
    await withStandaloneClient(async (client) => {
      const listedTools = await client.listTools();
      const queryEdgeTool = listedTools.tools.find((tool) => tool.name === 'queryEdge');
      expect(queryEdgeTool).toBeDefined();

      const inputSchemaJson = JSON.stringify(queryEdgeTool?.inputSchema);
      expect(inputSchemaJson).toContain('nodeId');
      expect(inputSchemaJson).toContain('direction');
      expect(inputSchemaJson).toContain('limit');
      expect(inputSchemaJson).toContain('offset');
      // The three direction values, named exactly as the read path accepts.
      expect(inputSchemaJson).toContain('into');
      expect(inputSchemaJson).toContain('out_of');
      expect(inputSchemaJson).toContain('both');
    });
  });
});
