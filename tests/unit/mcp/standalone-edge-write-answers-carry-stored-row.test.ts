/**
 * FAILING-FIRST tests for the STANDALONE MCP server's edge-write ANSWERS
 * (apps/mcp-server-standalone/index.js): createEdge and updateEdge must answer
 * with the FULL STORED EDGE ROW, not just success + edgeId + prose.
 *
 * WHY. This door has its own handlers over its own SQLite, and its
 * edgeService.createEdge / updateEdge ALREADY read the stored row back
 * (getEdgeById) — the handlers then throw the row away and answer only
 * `{ success, edgeId, message }`. The remote door is gaining the row on its
 * answers in this same slice (see
 * tests/unit/mcp/remote-mcp-route-edge-write-answers-carry-stored-row.test.ts),
 * and the two doors must not drift: a desktop client and a remote agent must
 * both learn which row actually landed. The shape pinned here is the same:
 * the answer keeps success, edgeId (equal to the row's id) and message, and
 * gains `edge` — at minimum id, from_node_id, to_node_id, explanation, as
 * stored. The cross-door agreement itself is pinned in
 * tests/unit/mcp/mcp-doors-agree-on-edge-write-answer-row.test.ts.
 *
 * SAFETY (same rules as standalone-belief-surface.test.ts): every database in
 * this file is a fresh temp file under os.tmpdir() (HOME and RAH_DB_PATH both
 * pinned into the temp root before the server spawns); the spawned server is
 * always terminated in the finally block of withStandaloneClient; and the file
 * imports NOTHING from src/, because any app module import would open the
 * user's REAL database as a module-load side effect.
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

// The explanation every create in this file writes; asserted verbatim on the
// answered row, so it is named once.
const CREATED_EDGE_EXPLANATION = 'Reports a measured result that bears on the neighbouring node.';

// The corrected explanation the update test writes over the created edge.
const CORRECTED_EDGE_EXPLANATION = 'The corrected reasoning for why the connection exists.';

// Seed a database carrying the full post-merge belief schema (the shape a
// migrated desktop database has), with the two nodes the edge writes connect.
// Belief columns are present so the seeded file matches production databases,
// but nothing in this file pins belief behaviour.
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
  `);

  const now = new Date().toISOString();
  const insertNode = db.prepare(`
    INSERT INTO nodes (id, title, description, source, created_at, updated_at, metadata, chunk_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertNode.run(
    1,
    'Edge Answer Target Node',
    'The node every created edge in this file points at.',
    'Target node source text for standalone edge-answer testing.',
    now,
    now,
    JSON.stringify({ captured_by: 'human' }),
    'not_chunked'
  );

  insertNode.run(
    2,
    'Edge Answer Origin Node',
    'The node every created edge in this file runs from.',
    'Origin node source text for standalone edge-answer testing.',
    now,
    now,
    JSON.stringify({ captured_by: 'human' }),
    'not_chunked'
  );

  db.close();
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

  const client = new Client({ name: 'ra-h-standalone-edge-answer-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// The structured answer shape this slice pins on both write tools; `edge` is
// the field current code lacks.
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

// Extract a tool call's structured answer under the pinned shape.
function structuredAnswerOf(toolResult: unknown): EdgeWriteStructuredAnswer {
  return (toolResult as { structuredContent?: unknown })
    .structuredContent as EdgeWriteStructuredAnswer;
}

// Read one stored edge row straight from the temp database file with an
// independent read-only connection (never through the server), so the answer
// can be checked against what was ACTUALLY stored.
function readStoredEdgeRow(edgeId: number):
  | { id: number; from_node_id: number; to_node_id: number; explanation: string | null }
  | undefined {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return directDb
      .prepare('SELECT id, from_node_id, to_node_id, explanation FROM edges WHERE id = ?')
      .get(edgeId) as
      | { id: number; from_node_id: number; to_node_id: number; explanation: string | null }
      | undefined;
  } finally {
    directDb.close();
  }
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-standalone-edge-answer-test-'));
  tempHome = path.join(tempRoot, 'home');
  dbPath = path.join(tempHome, 'Library', 'Application Support', 'RA-H', 'db', 'rah.sqlite');
});

// Each test starts from a freshly seeded database, so ids and rows are its own.
beforeEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  createStandaloneDbWithTwoNodes(dbPath);
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('standalone MCP server edge-write answers carry the stored row', () => {
  // The headline for this door: a successful createEdge must answer the row
  // it stored — checked against the database file itself, because this door
  // writes SQLite directly and the row is the only truth.
  it('createEdge answers the stored edge row alongside success, edgeId and message', async () => {
    await withStandaloneClient(async (client) => {
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
      const structuredAnswer = structuredAnswerOf(toolResult);
      // The existing fields stay.
      expect(structuredAnswer.success).toBe(true);
      expect(typeof structuredAnswer.message).toBe('string');
      // The new field: the stored row.
      expect(
        structuredAnswer.edge,
        'the createEdge answer must carry the stored edge row under `edge`'
      ).toBeDefined();
      // The answered row must agree with itself (edgeId names the same row)…
      expect(structuredAnswer.edge?.id).toBe(structuredAnswer.edgeId);
      // …and with what the database file actually holds.
      const storedEdgeRow = readStoredEdgeRow(structuredAnswer.edgeId);
      expect(storedEdgeRow, 'the answered edgeId must name a stored row').toBeDefined();
      expect(structuredAnswer.edge).toMatchObject({
        id: storedEdgeRow?.id,
        from_node_id: 2,
        to_node_id: 1,
        explanation: CREATED_EDGE_EXPLANATION,
      });
    });
  }, 30000);

  // The update answer must carry the row AFTER the correction — the corrected
  // explanation over the unchanged stored ends — in the same shape as
  // createEdge's answer.
  it('updateEdge answers the updated stored row in the same shape as createEdge', async () => {
    await withStandaloneClient(async (client) => {
      // First write the edge this test corrects, through the same door.
      const createToolResult = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: CREATED_EDGE_EXPLANATION,
          confirmed_by_user: true,
        },
      });
      // The id of the edge under correction, taken from the create answer's
      // one honest field today.
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
      const structuredAnswer = structuredAnswerOf(updateToolResult);
      expect(structuredAnswer.success).toBe(true);
      expect(structuredAnswer.edgeId).toBe(createdEdgeId);
      // The updated row: corrected prose, unchanged stored ends.
      expect(
        structuredAnswer.edge,
        'the updateEdge answer must carry the updated stored row under `edge`'
      ).toBeDefined();
      expect(structuredAnswer.edge).toMatchObject({
        id: createdEdgeId,
        from_node_id: 2,
        to_node_id: 1,
        explanation: CORRECTED_EDGE_EXPLANATION,
      });
      // And the answered row is the stored one, not a restatement of inputs.
      expect(readStoredEdgeRow(createdEdgeId)?.explanation).toBe(CORRECTED_EDGE_EXPLANATION);
    });
  }, 30000);
});
