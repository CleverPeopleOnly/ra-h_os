/**
 * DOOR PARITY: all THREE MCP doors must answer edge writes with the SAME
 * SHAPE — success, edgeId naming the real row, message, and `edge` carrying
 * the stored row (at minimum id, from_node_id, to_node_id, explanation):
 *  - the remote door (app/api/mcp/route.ts, rah_create_edge/rah_update_edge),
 *  - the local app-backed stdio door (apps/mcp-server/stdio-server.js, same
 *    tool names, spawned as a child process), and
 *  - the standalone stdio server (apps/mcp-server-standalone/index.js,
 *    createEdge/updateEdge over its own SQLite).
 *
 * WHY A PARITY FILE. Each door's own behaviour is pinned in its own file
 * (remote-mcp-route-edge-write-answers-carry-stored-row.test.ts,
 * stdio-server-edge-write-answers-carry-stored-row.test.ts and
 * standalone-edge-write-answers-carry-stored-row.test.ts), but per-door files
 * cannot see AGREEMENT — the tools are declared in three separate files over
 * two different backends (the remote and local doors forward to the app's
 * REST layer, the standalone writes SQLite directly), which is exactly the
 * setup that let the belief surface drift door by door before. This file
 * drives ALL the doors and holds their live answers to one shared shape
 * predicate, following tests/unit/mcp/mcp-doors-agree-on-belief.test.ts.
 *
 * The comparison is of SHAPE, not values: the doors answer rows from
 * different stores, so ids and timestamps legitimately differ — what must
 * agree is which fields an answer carries and that edgeId names the answered
 * row.
 *
 * Seam: the remote door through tests/unit/mcp/helpers/remoteMcpDoorHarness.ts
 * (its app stub answering the REST reply shapes pinned at the REST seam), the
 * local door spawned as a real child process pointed at that SAME app stub
 * (the mcp-doors-agree-on-belief idiom), and the standalone door spawned
 * against a fresh temp SQLite file. Every spawned process is always
 * terminated in a finally block. This file imports NOTHING from src/ (an app
 * module import would open the user's REAL database as a module-load side
 * effect).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';

import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live remote-door harness, which also owns the app stub.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;

// Temp root holding the standalone door's fake HOME and database file.
let tempRoot: string;
// Fake HOME handed to every spawned standalone server process.
let tempHome: string;
// Path of the seeded database the standalone server opens.
let dbPath: string;

// Absolute path of the standalone server entry point under test.
const standaloneServerEntryPath = path.join(
  process.cwd(),
  'apps',
  'mcp-server-standalone',
  'index.js'
);

// Absolute path of the local app-backed stdio door under test.
const localDoorEntryPath = path.join(process.cwd(), 'apps', 'mcp-server', 'stdio-server.js');

// The explanation every create through either door sends.
const CREATED_EDGE_EXPLANATION = 'Reports a measured result that bears on the neighbouring node.';

// The corrected explanation every update through either door sends.
const CORRECTED_EDGE_EXPLANATION = 'The corrected reasoning for why the connection exists.';

// The stored row the remote door's app stub answers on a create — the REST
// 201 shape that is live today (`data` carrying the full row).
const REMOTE_CREATED_EDGE_ROW = {
  id: 91,
  from_node_id: 2,
  to_node_id: 1,
  explanation: CREATED_EDGE_EXPLANATION,
  source: 'helper_name',
  created_at: '2026-08-13T00:00:00.000Z',
};

// The edge id the remote update corrects, and the row the app stub answers
// for it (the REST PUT already returns `data: edge` today).
const REMOTE_UPDATED_EDGE_ID = 42;
const REMOTE_UPDATED_EDGE_ROW = {
  id: REMOTE_UPDATED_EDGE_ID,
  from_node_id: 2,
  to_node_id: 1,
  explanation: CORRECTED_EDGE_EXPLANATION,
  source: 'helper_name',
  created_at: '2026-08-02T00:00:00.000Z',
};

// The shared answer shape both doors must satisfy. Kept structural on purpose:
// values differ between stores, the SHAPE must not.
type EdgeWriteStructuredAnswer = {
  success: boolean;
  edgeId: number;
  message: string;
  edge?: {
    id: number;
    from_node_id: number;
    to_node_id: number;
    explanation: string | null;
  };
};

// The one shape predicate both doors are held to: the answer carries success,
// a real edgeId, a message, and the stored row under `edge` with at least the
// four minimum fields — and edgeId names the answered row.
function expectEdgeWriteAnswerCarriesStoredRow(
  structuredAnswer: EdgeWriteStructuredAnswer,
  doorName: string
): void {
  expect(structuredAnswer.success, `the ${doorName} door must answer success`).toBe(true);
  expect(typeof structuredAnswer.message, `the ${doorName} door must answer a message`).toBe(
    'string'
  );
  // Asserted as a type first so an answer with NO edgeId at all (today's
  // rah_update_edge) fails readably rather than with a comparison TypeError.
  expect(
    typeof structuredAnswer.edgeId,
    `the ${doorName} door must answer an edgeId`
  ).toBe('number');
  expect(
    structuredAnswer.edgeId,
    `the ${doorName} door must answer a real edgeId, never 0`
  ).toBeGreaterThan(0);
  expect(
    structuredAnswer.edge,
    `the ${doorName} door must carry the stored row under \`edge\``
  ).toBeDefined();
  // The four minimum row fields every consumer of either door can rely on.
  for (const storedRowFieldName of ['id', 'from_node_id', 'to_node_id', 'explanation']) {
    expect(
      Object.keys(structuredAnswer.edge ?? {}),
      `the ${doorName} door's answered row must carry ${storedRowFieldName}`
    ).toContain(storedRowFieldName);
  }
  // The id agreement: edgeId and the row must name the same edge.
  expect(
    structuredAnswer.edge?.id,
    `the ${doorName} door's edgeId must name the answered row`
  ).toBe(structuredAnswer.edgeId);
}

// Seed the standalone door's database: full post-merge belief schema (the
// shape a migrated desktop database has) plus the two nodes its writes connect.
function createStandaloneDbWithTwoNodes(targetPath: string): void {
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
      explanation TEXT,
      belief_evidence_support REAL,
      belief_evidence_contribution REAL
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
  `);

  const now = new Date().toISOString();
  const insertNode = db.prepare(`
    INSERT INTO nodes (id, title, description, source, created_at, updated_at, metadata, chunk_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertNode.run(
    1,
    'Parity Target Node',
    'The node every parity-test edge points at.',
    'Target node source text for door-parity testing.',
    now,
    now,
    JSON.stringify({ captured_by: 'human' }),
    'not_chunked'
  );

  insertNode.run(
    2,
    'Parity Origin Node',
    'The node every parity-test edge runs from.',
    'Origin node source text for door-parity testing.',
    now,
    now,
    JSON.stringify({ captured_by: 'human' }),
    'not_chunked'
  );

  db.close();
}

// Spawn the LOCAL app-backed stdio door pointed at the remote harness's app
// stub (the mcp-doors-agree-on-belief idiom: both app-backed doors face the
// SAME stub), run the callback against a connected MCP client, then ALWAYS
// close the transport (which terminates the spawned process).
async function withLocalDoorClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [localDoorEntryPath],
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAH_MCP_TARGET_URL: remoteMcpDoorHarness.raHAppStubBaseUrl,
    } as Record<string, string>,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'ra-h-doors-agree-edge-answer-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
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

  const client = new Client({ name: 'ra-h-doors-agree-edge-answer-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// Extract a tool call's structured answer under the shared shape.
function structuredAnswerOf(toolResult: unknown): EdgeWriteStructuredAnswer {
  return (toolResult as { structuredContent?: unknown })
    .structuredContent as EdgeWriteStructuredAnswer;
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  // The app stub answers both remote write endpoints with the REST reply
  // shapes the door forwards to: a 201 create carrying the row, a PUT reply
  // carrying the updated row.
  remoteMcpDoorHarness.respondWith((request) => {
    if (request.method === 'POST' && request.pathname === '/api/edges') {
      return {
        status: 201,
        payload: {
          success: true,
          data: REMOTE_CREATED_EDGE_ROW,
          message: 'Edge created successfully between nodes 2 and 1',
        },
      };
    }
    if (request.method === 'PUT' && request.pathname === `/api/edges/${REMOTE_UPDATED_EDGE_ID}`) {
      return {
        payload: {
          success: true,
          data: REMOTE_UPDATED_EDGE_ROW,
          message: 'Edge updated successfully',
        },
      };
    }
    return undefined;
  });

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-doors-agree-edge-answer-test-'));
  tempHome = path.join(tempRoot, 'home');
  dbPath = path.join(tempHome, 'Library', 'Application Support', 'RA-H', 'db', 'rah.sqlite');
}, 60000);

// Each test starts from a freshly seeded standalone database.
beforeEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  createStandaloneDbWithTwoNodes(dbPath);
});

afterAll(async () => {
  await remoteMcpDoorHarness.stop();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('all MCP doors answer edge writes with the stored row', () => {
  // Create parity: every door's create answer must satisfy the one shared
  // shape predicate — same field names, edgeId naming the answered row.
  it('all doors answer a create with the stored row under the same field names', async () => {
    // The remote door, its stub answering the live REST 201 row shape.
    const remoteCreateAnswer = await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: CREATED_EDGE_EXPLANATION,
          confirmed_by_user: true,
        },
      });
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      return structuredAnswerOf(toolResult);
    });

    // The local app-backed door, forwarding to the SAME app stub.
    const localCreateAnswer = await withLocalDoorClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: CREATED_EDGE_EXPLANATION,
          confirmed_by_user: true,
        },
      });
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      return structuredAnswerOf(toolResult);
    });

    // The standalone door, writing a real row into its own SQLite.
    const standaloneCreateAnswer = await withStandaloneClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: CREATED_EDGE_EXPLANATION,
          confirmed_by_user: true,
        },
      });
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      return structuredAnswerOf(toolResult);
    });

    expectEdgeWriteAnswerCarriesStoredRow(remoteCreateAnswer, 'remote');
    expectEdgeWriteAnswerCarriesStoredRow(localCreateAnswer, 'local');
    expectEdgeWriteAnswerCarriesStoredRow(standaloneCreateAnswer, 'standalone');
  }, 60000);

  // Update parity: every door's update answer must carry the UPDATED row in
  // the same shape as its create answer.
  it('all doors answer an update with the updated row under the same field names', async () => {
    // The remote door corrects the stubbed edge and must relay the row the
    // app answered.
    const remoteUpdateAnswer = await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_update_edge',
        arguments: {
          id: REMOTE_UPDATED_EDGE_ID,
          explanation: CORRECTED_EDGE_EXPLANATION,
          confirmed_by_user: true,
        },
      });
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      return structuredAnswerOf(toolResult);
    });

    // The local app-backed door corrects the same stubbed edge and must relay
    // the same answered row.
    const localUpdateAnswer = await withLocalDoorClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_update_edge',
        arguments: {
          id: REMOTE_UPDATED_EDGE_ID,
          explanation: CORRECTED_EDGE_EXPLANATION,
          confirmed_by_user: true,
        },
      });
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      return structuredAnswerOf(toolResult);
    });

    // The standalone door first writes the edge it then corrects, both
    // through its own tools, so the update answers a genuinely stored row.
    const standaloneUpdateAnswer = await withStandaloneClient(async (client) => {
      const createToolResult = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: CREATED_EDGE_EXPLANATION,
          confirmed_by_user: true,
        },
      });
      // The id under correction, from the create answer's one honest field
      // today.
      const createdEdgeId = structuredAnswerOf(createToolResult).edgeId;
      expect(createdEdgeId).toBeGreaterThan(0);

      const updateToolResult = await client.callTool({
        name: 'updateEdge',
        arguments: {
          id: createdEdgeId,
          explanation: CORRECTED_EDGE_EXPLANATION,
          confirmed_by_user: true,
        },
      });
      expect((updateToolResult as { isError?: boolean }).isError ?? false).toBe(false);
      return structuredAnswerOf(updateToolResult);
    });

    expectEdgeWriteAnswerCarriesStoredRow(remoteUpdateAnswer, 'remote');
    expectEdgeWriteAnswerCarriesStoredRow(localUpdateAnswer, 'local');
    expectEdgeWriteAnswerCarriesStoredRow(standaloneUpdateAnswer, 'standalone');
    // The updated prose is what every answered row must carry — the row AFTER
    // the correction, not the one before it.
    expect(remoteUpdateAnswer.edge?.explanation).toBe(CORRECTED_EDGE_EXPLANATION);
    expect(localUpdateAnswer.edge?.explanation).toBe(CORRECTED_EDGE_EXPLANATION);
    expect(standaloneUpdateAnswer.edge?.explanation).toBe(CORRECTED_EDGE_EXPLANATION);
  }, 60000);
});
