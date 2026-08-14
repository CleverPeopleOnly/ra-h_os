/**
 * The STANDALONE MCP server after the display-belief slice
 * (apps/mcp-server-standalone):
 *
 *  - init-db lays down the four-column display-belief shape: nodes carries
 *    belief_uncertainty and NEITHER evidence mass column — app and standalone
 *    must agree on one schema or offline databases land in a shape the app
 *    cannot open cleanly,
 *  - getNodesById carries the STORED belief_uncertainty beside the three
 *    belief columns it already reports: the stored value verbatim for a
 *    graded non-fixed node, null for a never-assessed node, and 0 for a
 *    fixed node (a hand-asserted credence is dogmatic — the same rule the
 *    app doors' shared mapper applies, so every door tells one story).
 *
 * SAFETY: every database in this file is a fresh temp file under os.tmpdir()
 * (HOME and RAH_DB_PATH are pinned into the temp root before the server
 * process spawns). The spawned server is always terminated in the finally
 * block of withStandaloneClient. This file deliberately imports NOTHING from
 * src/ — importing any app module would open the user's real database as a
 * module-load side effect.
 */

import { spawnSync } from 'node:child_process';
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

// The stored uncertainty the graded fixture node carries.
const STORED_GRADED_UNCERTAINTY = 0.42;
// The stored uncertainty planted on the FIXED fixture node — a value the
// read surface must OVERRIDE with 0, because a hand-asserted credence is
// dogmatic by definition.
const STORED_UNCERTAINTY_ON_FIXED_NODE = 0.9;

// Seed a database that already carries the post-slice display-belief shape
// (belief_uncertainty stored, no mass columns) with one node per belief
// state, so the read tests exercise the tool, not schema migration.
function createStandaloneDbWithDisplayBeliefSchema(targetPath: string): void {
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
      belief_uncertainty REAL
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
  // One INSERT per belief state, ids fixed so each test can name its row.
  const insertNode = db.prepare(`
    INSERT INTO nodes (
      id, title, source, created_at, updated_at,
      belief_credence, belief_computed_at, belief_credence_is_fixed, belief_uncertainty
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Node 1: graded non-fixed with a stored uncertainty — the value must
  // reach the read verbatim.
  insertNode.run(
    1,
    'Graded node with stored uncertainty',
    'Graded node source text.',
    now,
    now,
    0.62,
    '2026-08-05T10:00:00.000Z',
    0,
    STORED_GRADED_UNCERTAINTY
  );
  // Node 2: never assessed — every display column NULL.
  insertNode.run(2, 'Never-assessed node', 'Never-assessed node source text.', now, now, null, null, 0, null);
  // Node 3: fixed by hand, with a stowaway stored uncertainty the read must
  // override with 0.
  insertNode.run(
    3,
    'Fixed-credence node',
    'Fixed node source text.',
    now,
    now,
    -0.4,
    '2026-08-04T10:00:00.000Z',
    1,
    STORED_UNCERTAINTY_ON_FIXED_NODE
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

  const client = new Client({ name: 'ra-h-standalone-display-belief-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// One node as getNodesById reports it, display-belief fields included.
interface ReportedStandaloneNode {
  id: number;
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_credence_is_fixed: number;
}

// Extract a tool call's structured content with a caller-chosen shape.
function getStructured<T>(result: unknown): T {
  return (result as { structuredContent?: unknown }).structuredContent as T;
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-standalone-display-belief-test-'));
  tempHome = path.join(tempRoot, 'home');
  dbPath = path.join(tempHome, 'Library', 'Application Support', 'RA-H', 'db', 'rah.sqlite');
});

beforeEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  createStandaloneDbWithDisplayBeliefSchema(dbPath);
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('standalone init-db lays down the display-belief schema', () => {
  // Schema parity with the app after the slice: belief_uncertainty in, both
  // mass columns out.
  it('creates nodes with belief_uncertainty and neither evidence mass column', () => {
    const initDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-standalone-display-initdb-'));
    const initDbPath = path.join(initDbDir, 'rah-init.sqlite');
    try {
      const initResult = spawnSync(process.execPath, [standaloneServerEntryPath, 'init-db'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          RAH_DB_PATH: initDbPath,
        },
        encoding: 'utf8',
        timeout: 30000,
      });
      expect(initResult.status, `init-db stderr: ${initResult.stderr}`).toBe(0);

      const directDb = new Database(initDbPath, { readonly: true, fileMustExist: true });
      try {
        // The full column row for belief_uncertainty, so type and
        // nullability are pinned alongside existence.
        const nodeColumns = directDb.prepare('PRAGMA table_info(nodes)').all() as Array<{
          name: string;
          type: string;
          notnull: number;
        }>;
        const nodeColumnNames = nodeColumns.map(column => column.name);

        const uncertaintyColumn = nodeColumns.find(column => column.name === 'belief_uncertainty');
        expect(uncertaintyColumn, 'init-db must create nodes.belief_uncertainty').toBeDefined();
        expect(uncertaintyColumn?.type.toUpperCase()).toBe('REAL');
        expect(uncertaintyColumn?.notnull).toBe(0);

        // The mass columns died with the slice — init-db must not create them.
        expect(nodeColumnNames).not.toContain('belief_evidence_for_mass');
        expect(nodeColumnNames).not.toContain('belief_evidence_against_mass');
      } finally {
        directDb.close();
      }
    } finally {
      fs.rmSync(initDbDir, { recursive: true, force: true });
    }
  });
});

describe('standalone getNodesById carries the stored belief_uncertainty', () => {
  // The read surface in one call, one node per belief state: stored value
  // verbatim, null for never-assessed, and the dogmatic 0 for a fixed node
  // regardless of what the stored column says.
  it('reports stored uncertainty, null when never assessed, and 0 for a fixed node', async () => {
    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'getNodesById',
        arguments: { nodeIds: [1, 2, 3] },
      });

      const structured = getStructured<{ nodes: ReportedStandaloneNode[] }>(result);
      const reportedGradedNode = structured.nodes.find(node => node.id === 1);
      const reportedNeverAssessedNode = structured.nodes.find(node => node.id === 2);
      const reportedFixedNode = structured.nodes.find(node => node.id === 3);

      // The stored value verbatim for a graded non-fixed node.
      expect(reportedGradedNode?.belief_uncertainty).toBeCloseTo(STORED_GRADED_UNCERTAINTY, 10);
      // Present and explicitly null for a never-assessed node — never 0.
      expect(reportedNeverAssessedNode?.belief_uncertainty).toBeNull();
      // 0 for a fixed node no matter what the column stores: a hand-asserted
      // credence is dogmatic, on this door exactly as on the app doors.
      expect(reportedFixedNode?.belief_uncertainty).toBe(0);
      expect(reportedFixedNode?.belief_credence_is_fixed).toBe(1);
    });
  });
});
