/**
 * FAILING-FIRST tests for the evidence-leaves-the-edges-table slice on the
 * STANDALONE MCP server (apps/mcp-server-standalone/): THE EDGE TOOLS NO
 * LONGER SPEAK EVIDENCE, AND ITS SCHEMA NO LONGER CREATES THE COLUMNS.
 *
 * Belief evidence moved out of this fork into samai's own store, so this
 * door's own SQLite copy of the contract sheds it too:
 *
 *  - createEdge no longer advertises belief_evidence_support on its input
 *    schema,
 *  - a STALE caller still sending belief_evidence_support is NOT an error —
 *    the key is stripped by the schema and a plain relationship edge is
 *    written, against an edges table that HAS no evidence column to write
 *    (pre-slice this exact call is refused with the migrate-first error, so
 *    this test is red today),
 *  - queryEdge answers carry NEITHER evidence field,
 *  - init-db lays down an edges table WITHOUT either evidence column
 *    (cli.js ensureMinimumSchema loses its two evidence entries).
 *
 * SAFETY (as in standalone-belief-evidence-write-schema-guard.test.ts):
 * every database in this file is a fresh temp file under os.tmpdir() (HOME
 * and RAH_DB_PATH are pinned into the temp root before the server process
 * spawns); this file imports NOTHING from src/ and reads the temp files with
 * its own better-sqlite3 connections, so no module-load side effect can ever
 * open the user's REAL database. The spawned server is always terminated in
 * the finally block of withStandaloneClient.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';

// The evidence field the write tool must no longer advertise or store.
const removedEdgeWriteEvidenceFieldName = 'belief_evidence_support';

// The two evidence fields an edge read answer must no longer carry.
const removedEdgeReadEvidenceFieldNames = [
  'belief_evidence_support',
  'belief_evidence_contribution',
];

// Temp root holding this file's fake HOME and database files.
let tempRoot: string;
// Fake HOME handed to every spawned server process.
let tempHome: string;
// Path of the seeded database the MCP server under test opens.
let dbPath: string;

// Absolute path of the standalone server entry point under test; its
// "init-db" subcommand owns the standalone copy of the schema.
const standaloneServerEntryPath = path.join(
  process.cwd(),
  'apps',
  'mcp-server-standalone',
  'index.js'
);

// The two nodes every edge fixture below connects.
const FIRST_FIXTURE_NODE_ID = 1;
const SECOND_FIXTURE_NODE_ID = 2;

// Seed the two nodes every edge below needs, through an open connection.
function seedFixtureNodes(db: Database.Database): void {
  const now = new Date().toISOString();
  const insertNode = db.prepare(`
    INSERT INTO nodes (id, title, description, source, created_at, updated_at, metadata, chunk_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'not_chunked')
  `);
  insertNode.run(
    FIRST_FIXTURE_NODE_ID,
    'First fixture node',
    'The first node the fixture edges connect.',
    'First fixture node content.',
    now,
    now,
    JSON.stringify({ captured_by: 'human' })
  );
  insertNode.run(
    SECOND_FIXTURE_NODE_ID,
    'Second fixture node',
    'The second node the fixture edges connect.',
    'Second fixture node content.',
    now,
    now,
    JSON.stringify({ captured_by: 'human' })
  );
}

// Seed a database in the POST-SLICE shape: the belief node columns and the
// movement log survive, but the edges table carries NO evidence column —
// an edge is a plain relationship row. This is the database every standalone
// server ships against once the slice lands.
function createPostSliceStandaloneDb(targetPath: string): void {
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
      belief_credence_is_fixed INTEGER NOT NULL DEFAULT 0,
      belief_evidence_for_mass REAL,
      belief_evidence_against_mass REAL
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
      chunk_idx INTEGER,
      text TEXT,
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

  seedFixtureNodes(db);
  db.close();
}

// Spawn the standalone server against the seeded temp database, run the
// callback with a connected MCP client, then ALWAYS close the transport
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

  const client = new Client({ name: 'ra-h-standalone-shed-evidence-test', version: '1.0.0' });
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

// Column names of one table in a database file, read with an independent
// read-only connection rather than through the server under test.
function readColumnNamesDirectly(targetDbPath: string, tableName: string): string[] {
  const directDb = new Database(targetDbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      directDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
    ).map((column) => column.name);
  } finally {
    directDb.close();
  }
}

// Count every edge row in the temp database file with an independent
// connection — used to prove a write landed (or did not).
function countEdgeRows(): number {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (directDb.prepare('SELECT COUNT(*) AS count FROM edges').get() as { count: number })
      .count;
  } finally {
    directDb.close();
  }
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-standalone-shed-evidence-'));
  tempHome = path.join(tempRoot, 'home');
  fs.mkdirSync(tempHome, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // A fresh post-slice database file per test, so no write leaks across.
  dbPath = path.join(tempRoot, `standalone-shed-evidence-${Date.now()}-${Math.random()}.sqlite`);
  createPostSliceStandaloneDb(dbPath);
});

describe('standalone MCP server edge tools shed evidence', () => {
  // The advertised surface: createEdge takes no support any more.
  it('createEdge no longer advertises belief_evidence_support', async () => {
    const advertisedTools = await withStandaloneClient(
      async (client) => (await client.listTools()).tools
    );
    const createEdgeTool = advertisedTools.find((tool) => tool.name === 'createEdge');
    expect(createEdgeTool, 'createEdge must still exist').toBeDefined();
    const createEdgeInputPropertyNames = Object.keys(
      (createEdgeTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    );
    expect(
      createEdgeInputPropertyNames,
      `createEdge must not advertise ${removedEdgeWriteEvidenceFieldName}`
    ).not.toContain(removedEdgeWriteEvidenceFieldName);
  });

  // The stale-caller pin: pre-slice this exact call is REFUSED (the guard
  // asks the schema, finds no column, and demands a migration); post-slice
  // the key is simply not part of the contract, so the write succeeds as a
  // plain relationship edge and nothing evidence-shaped lands anywhere.
  it('createEdge tolerates a stale belief_evidence_support against the evidence-free edges table', async () => {
    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: FIRST_FIXTURE_NODE_ID,
          targetId: SECOND_FIXTURE_NODE_ID,
          explanation: 'Discusses the same topic as the second fixture node.',
          confirmed_by_user: true,
          // The stale caller's key: stripped, never stored, never an error.
          belief_evidence_support: 0.9,
        },
      });

      expect((result as { isError?: boolean }).isError ?? false).toBe(false);
      expect(getStructured<{ success: boolean }>(result).success).toBe(true);
    });

    // The plain relationship edge landed…
    expect(countEdgeRows()).toBe(1);
    // …in a table that still has no evidence column for the value to have
    // sneaked into.
    const edgeColumnNames = readColumnNamesDirectly(dbPath, 'edges');
    for (const removedFieldName of removedEdgeReadEvidenceFieldNames) {
      expect(edgeColumnNames).not.toContain(removedFieldName);
    }
  });

  // The read answer: queryEdge no longer reports either evidence field.
  it('queryEdge answers edges without either evidence field', async () => {
    await withStandaloneClient(async (client) => {
      // Write one plain relationship edge through the door itself.
      await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: FIRST_FIXTURE_NODE_ID,
          targetId: SECOND_FIXTURE_NODE_ID,
          explanation: 'Discusses the same topic as the second fixture node.',
          confirmed_by_user: true,
        },
      });

      const queryResult = await client.callTool({
        name: 'queryEdge',
        arguments: { nodeId: FIRST_FIXTURE_NODE_ID },
      });

      const answeredEdges = getStructured<{ edges: Array<Record<string, unknown>> }>(
        queryResult
      ).edges;
      expect(answeredEdges).toHaveLength(1);
      for (const removedFieldName of removedEdgeReadEvidenceFieldNames) {
        expect(
          Object.prototype.hasOwnProperty.call(answeredEdges[0], removedFieldName),
          `queryEdge answer must not carry ${removedFieldName}`
        ).toBe(false);
      }
    });
  });

  // The standalone schema copy: init-db (cli.js ensureMinimumSchema) no
  // longer creates either evidence column on a fresh database.
  it('init-db lays down an edges table without either evidence column', () => {
    // A separate fresh path: this test is about the file init-db creates,
    // not about the seeded fixture database.
    const initDbTargetPath = path.join(tempRoot, `standalone-init-db-${Date.now()}.sqlite`);
    const initDbResult = spawnSync(
      process.execPath,
      [standaloneServerEntryPath, 'init-db'],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: tempHome, RAH_DB_PATH: initDbTargetPath },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    expect(initDbResult.status, `standalone init-db stderr: ${initDbResult.stderr}`).toBe(0);

    const edgeColumnNames = readColumnNamesDirectly(initDbTargetPath, 'edges');
    for (const removedFieldName of removedEdgeReadEvidenceFieldNames) {
      expect(
        edgeColumnNames,
        `init-db must not create edges.${removedFieldName}`
      ).not.toContain(removedFieldName);
    }
  });
});
