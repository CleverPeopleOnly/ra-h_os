/**
 * Contract tests for the standalone MCP server's belief surface:
 *  - schema parity: the standalone init-db path must create the belief
 *    columns and tables the app's belief engine expects, including the signed
 *    belief_evidence_support column and NEITHER of the two columns it
 *    replaces (belief_evidence_direction / belief_evidence_strength), nor the
 *    removed belief_evidence_origin_key,
 *  - schema parity part two: the standalone init-db path must create
 *    nodes.belief_credence_is_fixed and must NOT create belief_source_trust —
 *    a source is just a node and its influence IS its own belief_credence,
 *  - createEdge accepts and stores the one writable evidence field
 *    (belief_evidence_contribution stays NULL — grading is app-owned), and
 *    ignores stale merged-away arguments instead of failing,
 *  - getNodesById exposes belief_credence / belief_computed_at /
 *    belief_credence_is_fixed,
 *  - the new setBeliefFixedCredence tool asserts one node's credence by hand
 *    (the bootstrap a derived-only graph needs), and the deleted
 *    setBeliefSourceTrust / getBeliefSourceTrust tools are gone,
 *  - createEdge rejects an out-of-range support (outside the UNSIGNED [0, 1]
 *    range — anything negative or above 1) with a tool error and writes no
 *    row, but ACCEPTS 0, 1 and values between and stores them: NULL means
 *    the edge was never assessed as evidence, 0 means it was assessed and
 *    carries nothing, and those are different claims. Support is unsigned —
 *    the sign of a contribution comes from the source node's credence only.
 *
 * SAFETY: every database in this file is a fresh temp file under os.tmpdir()
 * (HOME and RAH_DB_PATH are both pinned into the temp root before the server
 * process spawns). The spawned server is always terminated in the finally
 * block of withStandaloneClient, so no orphan processes survive a failure.
 *
 * SAFETY, second rule: this file deliberately imports NOTHING from src/. It
 * drives a spawned server process and has no temp-database seam of its own,
 * so importing any app module would pull in '@/services/database/sqlite-client'
 * — which opens its database file as a module-load side effect and would
 * therefore open the user's REAL database. Anything needed from the app side
 * is restated here or asserted through the server.
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

// Seed a database that already carries the FULL post-merge belief schema
// (signed belief_evidence_support + belief_evidence_contribution, and none of
// the direction / strength / origin-key columns they replace), so the
// tool-behavior tests below exercise the tools, not schema migration.
// (Schema creation by the standalone path itself is pinned separately in the
// init-db parity test.)
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertNode.run(
    1,
    'Belief Surface Claim Node',
    'The claim node whose belief the evidence tests point at.',
    'Claim node source text for standalone belief-surface testing.',
    now,
    now,
    JSON.stringify({ captured_by: 'human' }),
    'not_chunked'
  );

  insertNode.run(
    2,
    'Belief Surface Evidence Node',
    'The evidence node the createEdge tests write edges from.',
    'Evidence node source text for standalone belief-surface testing.',
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

  const client = new Client({ name: 'ra-h-standalone-belief-surface-test', version: '1.0.0' });
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

// The two evidence columns of one edge row after the merge, as read back
// directly via SQL: the signed support and the app-owned grading stamp.
interface EdgeEvidenceRow {
  belief_evidence_support: number | null;
  belief_evidence_contribution: number | null;
}

// Read one edge row's evidence columns straight from the temp database file
// with an independent better-sqlite3 connection (never through the server).
function readEdgeEvidenceRow(edgeId: number): EdgeEvidenceRow | undefined {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return directDb
      .prepare(
        `SELECT belief_evidence_support, belief_evidence_contribution
         FROM edges WHERE id = ?`
      )
      .get(edgeId) as EdgeEvidenceRow | undefined;
  } finally {
    directDb.close();
  }
}

// Column names of the edges table in the temp database file — used to prove
// the merged-away pair and the removed origin key have no storage behind them
// on the standalone side.
function readStandaloneEdgeColumnNames(): string[] {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (directDb.prepare('PRAGMA table_info(edges)').all() as Array<{ name: string }>).map(
      column => column.name
    );
  } finally {
    directDb.close();
  }
}

// Count edges between a node pair straight from the temp database file.
function countEdgesBetween(fromNodeId: number, toNodeId: number): number {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = directDb
      .prepare('SELECT COUNT(*) AS count FROM edges WHERE from_node_id = ? AND to_node_id = ?')
      .get(fromNodeId, toNodeId) as { count: number };
    return row.count;
  } finally {
    directDb.close();
  }
}

// One node's belief state as read back straight from the temp database file:
// the credence itself, when it was last written, and whether a human asserted
// it rather than the app's belief engine deriving it.
interface NodeBeliefStateRow {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
}

// Read one node's belief state straight from the temp database file with an
// independent better-sqlite3 connection (never through the server).
function readNodeBeliefStateRow(nodeId: number): NodeBeliefStateRow | undefined {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return directDb
      .prepare(
        'SELECT belief_credence, belief_computed_at, belief_credence_is_fixed FROM nodes WHERE id = ?'
      )
      .get(nodeId) as NodeBeliefStateRow | undefined;
  } finally {
    directDb.close();
  }
}

// One belief_movements row as read back by these tests: the node's credence
// before and after the write, what caused it, and when.
interface BeliefMovementRow {
  from_credence: number | null;
  to_credence: number;
  trigger: string;
  occurred_at: string;
}

// Read one node's belief movement rows straight from the temp database file,
// oldest first.
function readBeliefMovementRows(nodeId: number): BeliefMovementRow[] {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return directDb
      .prepare(
        `SELECT from_credence, to_credence, "trigger", occurred_at
         FROM belief_movements WHERE node_id = ? ORDER BY id ASC`
      )
      .all(nodeId) as BeliefMovementRow[];
  } finally {
    directDb.close();
  }
}

// Count all node rows in the temp database file — used to prove a rejected
// write created nothing.
function countNodes(): number {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (directDb.prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number })
      .count;
  } finally {
    directDb.close();
  }
}

// Count all belief_movements rows in the temp database file — used to prove a
// rejected write logged nothing.
function countBeliefMovements(): number {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      directDb.prepare('SELECT COUNT(*) AS count FROM belief_movements').get() as {
        count: number;
      }
    ).count;
  } finally {
    directDb.close();
  }
}

// Overwrite one node's belief_computed_at directly in the temp database file,
// so a test can plant an obviously stale stamp and then prove the next write
// replaced it. Uses its own writable connection with a busy timeout, because
// the spawned server holds the same file open.
function overwriteNodeBeliefComputedAt(nodeId: number, beliefComputedAt: string): void {
  const directDb = new Database(dbPath, { fileMustExist: true });
  try {
    directDb.pragma('busy_timeout = 5000');
    directDb
      .prepare('UPDATE nodes SET belief_computed_at = ? WHERE id = ?')
      .run(beliefComputedAt, nodeId);
  } finally {
    directDb.close();
  }
}

// The one trigger string every human-asserted credence write is logged under,
// so the movement log distinguishes an asserted credence from a derived one.
const FIXED_CREDENCE_MOVEMENT_TRIGGER = 'belief-fixed-credence-set';

// A credence that round-trips through SQLite REAL byte-for-byte (an exact
// binary fraction), so the same-value tests below are about the change rule
// and never about floating-point noise.
const EXACTLY_REPRESENTABLE_BELIEF_CREDENCE = 0.5;

// The very next double above EXACTLY_REPRESENTABLE_BELIEF_CREDENCE — one
// step in the last representable bit. Number.EPSILON is the gap at 1.0, so
// half of it is the gap at 0.5. It survives JSON and SQLite REAL unchanged,
// which is what lets the boundary test below observe an EXACT comparison.
const NEXT_REPRESENTABLE_BELIEF_CREDENCE_ABOVE =
  EXACTLY_REPRESENTABLE_BELIEF_CREDENCE + Number.EPSILON / 2;

// An obviously stale stamp planted before a re-assertion, so "the timestamp
// was rewritten" can be proved without depending on two writes landing in
// different milliseconds.
const STALE_BELIEF_COMPUTED_AT = '2000-01-01T00:00:00.000Z';

// The exact wording the MCP server answers a call to an UNREGISTERED tool
// with. Tests that expect a real error from the tool assert against this, so
// they cannot pass merely because the tool does not exist yet.
const UNREGISTERED_TOOL_ERROR_PATTERN = /Tool\s+setBeliefFixedCredence\s+not found/i;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-standalone-belief-test-'));
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

describe('standalone MCP server belief surface (MR-B)', () => {
  // Schema parity: a database created by the standalone init-db path must
  // already contain the belief columns and tables, so app and standalone
  // agree on one schema and offline evidence writes have somewhere to land.
  it('init-db creates a database with belief columns, evidence columns, and belief tables', () => {
    const initDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-standalone-initdb-test-'));
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
        const nodeColumnNames = (
          directDb.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>
        ).map(column => column.name);
        const edgeColumnNames = (
          directDb.prepare('PRAGMA table_info(edges)').all() as Array<{ name: string }>
        ).map(column => column.name);
        const tableNames = (
          directDb
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all() as Array<{ name: string }>
        ).map(row => row.name);

        // EDITED from belief_value: the standalone init-db path must create
        // the graded quantity under its one name, credence, and must not
        // create the old name beside it.
        expect(nodeColumnNames).toContain('belief_credence');
        expect(nodeColumnNames).not.toContain('belief_value');
        expect(nodeColumnNames).toContain('belief_computed_at');
        // EDITED from the direction/strength parity expectation: the
        // standalone init-db column list must create the one signed support
        // column and neither of the two it replaces, so an offline evidence
        // write can never land in a shape the app cannot grade.
        expect(edgeColumnNames).toContain('belief_evidence_support');
        expect(edgeColumnNames).toContain('belief_evidence_contribution');
        expect(edgeColumnNames).not.toContain('belief_evidence_direction');
        expect(edgeColumnNames).not.toContain('belief_evidence_strength');
        // The standalone init-db column list must not create the removed
        // origin key either.
        expect(edgeColumnNames).not.toContain('belief_evidence_origin_key');
        // Sources are nodes: the standalone init-db path must create the
        // fixed-credence flag the app's belief engine reads, and must NOT
        // create the deleted trust table beside it. App and standalone have
        // to agree on one schema or offline writes land in a shape the app
        // cannot grade.
        expect(nodeColumnNames).toContain('belief_credence_is_fixed');
        expect(tableNames).not.toContain('belief_source_trust');
        expect(tableNames).toContain('belief_movements');
        // The movement log records the same quantity, so it uses the same
        // word on both of its numeric columns.
        const movementColumnNames = (
          directDb.prepare('PRAGMA table_info(belief_movements)').all() as Array<{ name: string }>
        ).map(column => column.name);
        expect(movementColumnNames).toContain('from_credence');
        expect(movementColumnNames).toContain('to_credence');
        expect(movementColumnNames).not.toContain('from_value');
        expect(movementColumnNames).not.toContain('to_value');

        // The flag's declaration has to match the app's, not merely exist:
        // NOT NULL DEFAULT 0 is what makes "derived" the state a node is in
        // without any write, on both sides of the app/standalone boundary.
        const standaloneFixedCredenceColumn = (
          directDb.prepare('PRAGMA table_info(nodes)').all() as Array<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
          }>
        ).find(column => column.name === 'belief_credence_is_fixed');
        expect(standaloneFixedCredenceColumn?.type.toUpperCase()).toBe('INTEGER');
        expect(standaloneFixedCredenceColumn?.notnull).toBe(1);
        expect(String(standaloneFixedCredenceColumn?.dflt_value)).toBe('0');
      } finally {
        directDb.close();
      }
    } finally {
      fs.rmSync(initDbDir, { recursive: true, force: true });
    }
  });

  // EDITED from the two-field storage case: createEdge must accept the one
  // signed writable evidence field and persist it, while the grading stamp
  // (belief_evidence_contribution) stays NULL because the standalone server
  // never grades — grading is app-owned.
  it('createEdge stores belief_evidence_support; contribution stays NULL', async () => {
    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result that supports the claim node.',
          confirmed_by_user: true,
          belief_evidence_support: 0.8,
        },
      });

      const structured = getStructured<{ success: boolean; edgeId: number }>(result);
      expect(structured.success).toBe(true);

      const evidenceRow = readEdgeEvidenceRow(structured.edgeId);
      expect(evidenceRow).toBeDefined();
      expect(Number(evidenceRow?.belief_evidence_support)).toBeCloseTo(0.8, 10);
      expect(evidenceRow?.belief_evidence_contribution).toBeNull();
      // No merged-away or origin-key column is left for the standalone write
      // path to fill.
      const standaloneEdgeColumnNames = readStandaloneEdgeColumnNames();
      expect(standaloneEdgeColumnNames).not.toContain('belief_evidence_direction');
      expect(standaloneEdgeColumnNames).not.toContain('belief_evidence_strength');
      expect(standaloneEdgeColumnNames).not.toContain('belief_evidence_origin_key');
    });
  });

  // REWRITTEN from "stores a negative support with its sign intact". Support
  // is now UNSIGNED (0..1): a negative value is not a contradiction, it is
  // an invalid write, and this door must refuse it with a tool error and
  // write no row. Contradiction is expressed by the source NODE's negative
  // credence, never by the support.
  it('createEdge rejects a negative belief_evidence_support with a tool error and writes no edge row', async () => {
    await withStandaloneClient(async (client) => {
      // A plainly negative value AND the old signed range's -1 boundary:
      // nothing below 0 is a support any more.
      for (const rejectedNegativeSupport of [-0.4, -1]) {
        const edgesBefore = countEdgesBetween(2, 1);

        const result = await client.callTool({
          name: 'createEdge',
          arguments: {
            sourceId: 2,
            targetId: 1,
            explanation: 'Reports a measured result about the claim node.',
            confirmed_by_user: true,
            belief_evidence_support: rejectedNegativeSupport,
          },
        });

        expect(
          (result as { isError?: boolean }).isError,
          `a support of ${rejectedNegativeSupport} must be rejected — support is unsigned`
        ).toBe(true);
        expect(countEdgesBetween(2, 1)).toBe(edgesBefore);
      }
    });
  });

  // The upper boundary of the unsigned range is in range: full-strength
  // evidence (support exactly 1) must be accepted and stored verbatim, with
  // the grading stamp still app-owned (NULL).
  it('createEdge accepts a belief_evidence_support of exactly 1 and stores it', async () => {
    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result bearing on the claim node at full strength.',
          confirmed_by_user: true,
          belief_evidence_support: 1,
        },
      });

      expect((result as { isError?: boolean }).isError ?? false).toBe(false);
      const structured = getStructured<{ success: boolean; edgeId: number }>(result);
      expect(structured.success).toBe(true);
      const evidenceRow = readEdgeEvidenceRow(structured.edgeId);
      expect(evidenceRow?.belief_evidence_support).toBe(1);
      expect(evidenceRow?.belief_evidence_contribution).toBeNull();
    });
  });

  // EDITED from the stale-origin-key case: a client that still passes the
  // merged-away pair must get a normal successful edge creation. Zod strips
  // the unknown keys, so no support is written and the result is a plain
  // non-evidence edge — legitimate, not an error.
  it('createEdge ignores stale belief_evidence_direction / belief_evidence_strength arguments and creates a plain edge', async () => {
    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result that supports the claim node.',
          confirmed_by_user: true,
          belief_evidence_direction: 'for',
          belief_evidence_strength: 0.8,
        },
      });

      expect((result as { isError?: boolean }).isError ?? false).toBe(false);
      const structured = getStructured<{ success: boolean; edgeId: number }>(result);
      expect(structured.success).toBe(true);

      const evidenceRow = readEdgeEvidenceRow(structured.edgeId);
      expect(evidenceRow?.belief_evidence_support).toBeNull();
      expect(evidenceRow?.belief_evidence_contribution).toBeNull();
    });
  });

  // Discoverability: the standalone createEdge tool must advertise the one
  // signed field and neither of the two it replaces, so no external agent
  // can learn the shape that allowed direction and magnitude to disagree.
  it('advertises belief_evidence_support and neither belief_evidence_direction nor belief_evidence_strength in the createEdge input schema', async () => {
    await withStandaloneClient(async (client) => {
      const listedTools = await client.listTools();
      const createEdgeTool = listedTools.tools.find((tool) => tool.name === 'createEdge');
      expect(createEdgeTool).toBeDefined();

      const inputSchemaJson = JSON.stringify(createEdgeTool?.inputSchema);
      expect(inputSchemaJson).toContain('belief_evidence_support');
      expect(inputSchemaJson).not.toContain('belief_evidence_direction');
      expect(inputSchemaJson).not.toContain('belief_evidence_strength');
      expect(inputSchemaJson).not.toContain('belief_evidence_origin_key');
    });
  });

  // GUARD: a createEdge call WITHOUT evidence arguments must keep both
  // evidence columns NULL — plain relationship edges never masquerade as
  // evidence.
  it('GUARD: createEdge without evidence arguments stores NULL in both evidence columns', async () => {
    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Provides useful background context for the claim node.',
          confirmed_by_user: true,
        },
      });

      const structured = getStructured<{ success: boolean; edgeId: number }>(result);
      expect(structured.success).toBe(true);

      const evidenceRow = readEdgeEvidenceRow(structured.edgeId);
      expect(evidenceRow).toBeDefined();
      expect(evidenceRow?.belief_evidence_support).toBeNull();
      expect(evidenceRow?.belief_evidence_contribution).toBeNull();
    });
  });

  // Belief read path part two: a credence alone does not say where it came
  // from, so the read path must expose belief_credence_is_fixed beside it —
  // an external agent has to be able to tell a human-asserted credence from
  // one the app's belief engine derived before it decides what to do next.
  it('getNodesById returns belief_credence_is_fixed beside belief_credence', async () => {
    await withStandaloneClient(async (client) => {
      // Node 1 stays ordinary; node 2 has its credence asserted by hand.
      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 2, belief_credence: 0.9 },
      });

      const result = await client.callTool({
        name: 'getNodesById',
        arguments: { nodeIds: [1, 2] },
      });

      const structured = getStructured<{
        nodes: Array<{
          id: number;
          belief_credence: number | null;
          belief_credence_is_fixed: number;
        }>;
      }>(result);
      const ordinaryNode = structured.nodes.find(node => node.id === 1);
      const fixedCredenceNode = structured.nodes.find(node => node.id === 2);
      expect(ordinaryNode?.belief_credence_is_fixed).toBe(0);
      expect(fixedCredenceNode?.belief_credence_is_fixed).toBe(1);
      expect(Number(fixedCredenceNode?.belief_credence)).toBeCloseTo(0.9, 10);
    });
  });

  // Belief read path: getNodesById must surface a node's persisted belief
  // state so external agents can read what the app-owned engine graded.
  it('getNodesById returns belief_credence and belief_computed_at for a graded node', async () => {
    // Seed a graded node directly via SQL (the app is what grades in real
    // life; here we only pin the standalone READ path).
    const gradedAt = '2026-07-01T12:00:00.000Z';
    const directDb = new Database(dbPath);
    directDb
      .prepare('UPDATE nodes SET belief_credence = ?, belief_computed_at = ? WHERE id = ?')
      .run(0.42, gradedAt, 1);
    directDb.close();

    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'getNodesById',
        arguments: { nodeIds: [1] },
      });

      const structured = getStructured<{
        nodes: Array<{ id: number; belief_credence: number | null; belief_computed_at: string | null }>;
      }>(result);
      const gradedNode = structured.nodes.find(node => node.id === 1);
      expect(gradedNode).toBeDefined();
      expect(gradedNode?.belief_credence).toBeCloseTo(0.42, 10);
      expect(gradedNode?.belief_computed_at).toBe(gradedAt);
    });
  });

  // REPLACES setBeliefSourceTrust/getBeliefSourceTrust. A source is just a
  // node, so the only thing left to write by hand is one node's own
  // credence — asserted by a human rather than derived from the graph. The
  // tool sets belief_credence AND raises belief_credence_is_fixed, which is
  // what stops the belief engine regrading the node away again.
  it('setBeliefFixedCredence writes belief_credence and sets belief_credence_is_fixed to 1', async () => {
    await withStandaloneClient(async (client) => {
      // Precondition: the node starts out ordinary and ungraded.
      expect(readNodeBeliefStateRow(2)?.belief_credence).toBeNull();
      expect(readNodeBeliefStateRow(2)?.belief_credence_is_fixed).toBe(0);

      const result = await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 2, belief_credence: 0.9 },
      });

      expect((result as { isError?: boolean }).isError ?? false).toBe(false);
      const assertedBeliefState = readNodeBeliefStateRow(2);
      expect(Number(assertedBeliefState?.belief_credence)).toBeCloseTo(0.9, 10);
      expect(assertedBeliefState?.belief_credence_is_fixed).toBe(1);
    });
  });

  // Setting it again replaces the asserted credence in place and leaves the
  // node fixed — a human changing their mind is an ordinary edit, not a
  // second node.
  it('setBeliefFixedCredence called twice leaves the latest credence and keeps the node fixed', async () => {
    await withStandaloneClient(async (client) => {
      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 2, belief_credence: 0.9 },
      });
      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 2, belief_credence: -0.25 },
      });

      const assertedBeliefState = readNodeBeliefStateRow(2);
      expect(Number(assertedBeliefState?.belief_credence)).toBeCloseTo(-0.25, 10);
      expect(assertedBeliefState?.belief_credence_is_fixed).toBe(1);
    });
  });

  // A credence of 0 is inside the open interval and is a real assertion —
  // "I have looked and I am torn" — so it must be stored as 0, never
  // rejected and never collapsed to NULL (NULL means nobody has graded this
  // node at all, which is a different claim).
  it('setBeliefFixedCredence accepts a credence of exactly 0 and stores 0 rather than NULL', async () => {
    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 2, belief_credence: 0 },
      });

      expect((result as { isError?: boolean }).isError ?? false).toBe(false);
      const assertedBeliefState = readNodeBeliefStateRow(2);
      // toBe(0) rather than a coercing comparison: Number(null) is also 0.
      expect(assertedBeliefState?.belief_credence).toBe(0);
      expect(assertedBeliefState?.belief_credence).not.toBeNull();
      expect(assertedBeliefState?.belief_credence_is_fixed).toBe(1);
    });
  });

  // Credence lives in the OPEN interval (-1, +1): total certainty either way
  // is not expressible, so both endpoints and anything beyond them must be a
  // tool error that writes nothing.
  it('setBeliefFixedCredence rejects -1, +1 and out-of-range credences and writes nothing', async () => {
    await withStandaloneClient(async (client) => {
      for (const rejectedBeliefCredence of [1, -1, 1.5, -1.5]) {
        const result = await client.callTool({
          name: 'setBeliefFixedCredence',
          arguments: { node_id: 2, belief_credence: rejectedBeliefCredence },
        });

        expect(
          (result as { isError?: boolean }).isError,
          `a credence of ${rejectedBeliefCredence} is outside the open interval and must be rejected`
        ).toBe(true);
        // ...and rejected BY THE TOOL, not by there being no such tool: an
        // unregistered name also comes back as an error, which would let this
        // case pass for entirely the wrong reason.
        expect(
          JSON.stringify((result as { content?: unknown }).content),
          'the rejection must come from the tool validating its input, not from a missing tool'
        ).not.toMatch(UNREGISTERED_TOOL_ERROR_PATTERN);
        // Nothing was written: the node is still ordinary and ungraded.
        const untouchedBeliefState = readNodeBeliefStateRow(2);
        expect(untouchedBeliefState?.belief_credence).toBeNull();
        expect(untouchedBeliefState?.belief_credence_is_fixed).toBe(0);
      }
    });
  });

  // Asserting a credence by hand is the ONLY way a fixed node's credence ever
  // changes, so without a movement row the human-asserted numbers would be the
  // only credences in the system with no audit trail behind them. The first
  // assertion on a never-graded node logs from_credence NULL — there was no
  // previous credence — under the trigger that names this write path.
  it('setBeliefFixedCredence appends a belief_movements row with NULL from_credence on a fresh node', async () => {
    await withStandaloneClient(async (client) => {
      // Precondition: the node has never been graded, so there is nothing to
      // move from and nothing logged yet.
      expect(readNodeBeliefStateRow(2)?.belief_credence).toBeNull();
      expect(readBeliefMovementRows(2)).toHaveLength(0);

      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 2, belief_credence: 0.9 },
      });

      const movements = readBeliefMovementRows(2);
      expect(movements).toHaveLength(1);
      expect(movements[0].from_credence, 'a first assertion has no previous credence').toBeNull();
      expect(Number(movements[0].to_credence)).toBeCloseTo(0.9, 10);
      expect(movements[0].trigger).toBe(FIXED_CREDENCE_MOVEMENT_TRIGGER);
      expect(movements[0].occurred_at).toBeTruthy();
    });
  });

  // Re-asserting over an existing credence logs the change the same way: the
  // previous asserted value is the movement's from_credence, so the log reads
  // as a continuous history of what the human believed.
  it('setBeliefFixedCredence appends a second movement row carrying the previous credence', async () => {
    await withStandaloneClient(async (client) => {
      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 2, belief_credence: 0.9 },
      });
      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 2, belief_credence: -0.25 },
      });

      const movements = readBeliefMovementRows(2);
      expect(movements).toHaveLength(2);
      expect(Number(movements[1].from_credence), 'the previous asserted credence').toBeCloseTo(
        0.9,
        10
      );
      expect(Number(movements[1].to_credence)).toBeCloseTo(-0.25, 10);
      expect(movements[1].trigger).toBe(FIXED_CREDENCE_MOVEMENT_TRIGGER);
    });
  });

  // The discriminating case for the movement rule: a movement records the
  // credence CHANGING, and re-asserting the SAME number is not a change, so
  // it appends nothing — otherwise the log fills with rows recording nothing.
  // The comparison is EXACT: the same number means the identical double, not
  // one within some tolerance (see the last-representable-bit test below for
  // why an asserted credence needs no tolerance).
  it('setBeliefFixedCredence asserting the same credence twice appends only one movement row', async () => {
    await withStandaloneClient(async (client) => {
      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: {
          node_id: 2,
          belief_credence: EXACTLY_REPRESENTABLE_BELIEF_CREDENCE,
        },
      });
      // Precondition: the first assertion logged the ungraded -> asserted move.
      expect(readBeliefMovementRows(2)).toHaveLength(1);

      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: {
          node_id: 2,
          belief_credence: EXACTLY_REPRESENTABLE_BELIEF_CREDENCE,
        },
      });

      const movements = readBeliefMovementRows(2);
      expect(movements, 're-asserting the same credence is not a movement').toHaveLength(1);
      // The stored credence is still the asserted one, and the node is still
      // fixed — nothing about the second write was skipped except the log.
      expect(readNodeBeliefStateRow(2)?.belief_credence).toBe(
        EXACTLY_REPRESENTABLE_BELIEF_CREDENCE
      );
      expect(readNodeBeliefStateRow(2)?.belief_credence_is_fixed).toBe(1);
    });
  });

  // The other half of that split, copied from recomputeNodeBelief exactly:
  // the credence and its timestamp are written UNCONDITIONALLY and only the
  // movement row is conditional. So an unchanged re-assertion still refreshes
  // belief_computed_at — the human did look again, and the column records
  // when the credence was last written.
  it('setBeliefFixedCredence rewrites belief_computed_at on an unchanged re-assertion', async () => {
    await withStandaloneClient(async (client) => {
      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: {
          node_id: 2,
          belief_credence: EXACTLY_REPRESENTABLE_BELIEF_CREDENCE,
        },
      });
      // Plant an obviously stale stamp, so "rewritten" is provable without
      // relying on two writes landing in different milliseconds.
      overwriteNodeBeliefComputedAt(2, STALE_BELIEF_COMPUTED_AT);
      const earliestAcceptableRewriteTime = Date.now();

      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: {
          node_id: 2,
          belief_credence: EXACTLY_REPRESENTABLE_BELIEF_CREDENCE,
        },
      });

      const rewrittenBeliefComputedAt = readNodeBeliefStateRow(2)?.belief_computed_at;
      expect(
        rewrittenBeliefComputedAt,
        'the unconditional timestamp write happens even when the credence did not move'
      ).not.toBe(STALE_BELIEF_COMPUTED_AT);
      expect(Date.parse(String(rewrittenBeliefComputedAt))).toBeGreaterThanOrEqual(
        earliestAcceptableRewriteTime - 1000
      );
      // ...while the conditional write, the movement row, did not happen.
      expect(readBeliefMovementRows(2)).toHaveLength(1);
    });
  });

  // The other side of that rule: any DIFFERENT credence is a second
  // assertion and earns its own movement row, carrying the previous value as
  // from_credence.
  it('setBeliefFixedCredence appends a second movement row for any different credence', async () => {
    await withStandaloneClient(async (client) => {
      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 2, belief_credence: 0.5 },
      });

      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 2, belief_credence: 0.75 },
      });

      const movements = readBeliefMovementRows(2);
      expect(movements, 'a different credence is a movement').toHaveLength(2);
      expect(Number(movements[1].from_credence)).toBe(0.5);
      expect(Number(movements[1].to_credence)).toBe(0.75);
      expect(movements[1].trigger).toBe(FIXED_CREDENCE_MOVEMENT_TRIGGER);
    });
  });

  // The boundary, and the test that makes EXACT comparison observable: two
  // credences one step apart in the last representable bit are DIFFERENT, so
  // the second assertion appends its own movement row. Any tolerance at all
  // would swallow this difference and leave a single row.
  //
  // Why exact rather than tolerant, so nobody "restores consistency" later by
  // copying recomputeNodeBelief's epsilon here: recompute compares two results
  // of exponential arithmetic, where a difference in the fifteenth decimal is
  // drift rather than a real movement, so it needs a tolerance. A fixed
  // credence contains no arithmetic — a literal number arrives through the MCP
  // tool and is compared against a literal number that was itself asserted,
  // and doubles round-trip through JSON exactly. There is no drift to absorb,
  // so two different values are two different assertions. Exact comparison
  // also means no numeric constant has to be kept in step across the
  // app/standalone boundary, which is the two-copies-must-agree pattern behind
  // three defects in this project.
  it('setBeliefFixedCredence treats a last-representable-bit difference as a real change', async () => {
    await withStandaloneClient(async (client) => {
      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: {
          node_id: 2,
          belief_credence: EXACTLY_REPRESENTABLE_BELIEF_CREDENCE,
        },
      });
      expect(readBeliefMovementRows(2)).toHaveLength(1);

      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: {
          node_id: 2,
          belief_credence: NEXT_REPRESENTABLE_BELIEF_CREDENCE_ABOVE,
        },
      });

      const movements = readBeliefMovementRows(2);
      expect(
        movements,
        'one step in the last bit is still a different assertion, so it is a movement'
      ).toHaveLength(2);
      // toBe, never toBeCloseTo: any tolerance here would defeat the point of
      // the test by treating these two doubles as the same number.
      expect(movements[1].from_credence).toBe(EXACTLY_REPRESENTABLE_BELIEF_CREDENCE);
      expect(movements[1].to_credence).toBe(NEXT_REPRESENTABLE_BELIEF_CREDENCE_ABOVE);
      expect(readNodeBeliefStateRow(2)?.belief_credence).toBe(
        NEXT_REPRESENTABLE_BELIEF_CREDENCE_ABOVE
      );
    });
  });

  // belief_computed_at records when the credence was last written, whatever
  // wrote it. For a fixed node that is the moment a human asserted it, so the
  // tool must stamp it rather than leaving the node looking never-computed.
  it('setBeliefFixedCredence stamps belief_computed_at with an ISO timestamp of the write', async () => {
    await withStandaloneClient(async (client) => {
      // Precondition: nothing has written a credence to this node yet.
      expect(readNodeBeliefStateRow(2)?.belief_computed_at).toBeNull();
      // Lower bound for the stamp, taken just before the write.
      const earliestAcceptableWriteTime = Date.now();

      await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 2, belief_credence: 0.9 },
      });

      const assertedAt = readNodeBeliefStateRow(2)?.belief_computed_at;
      expect(assertedAt, 'the asserted credence carries a computed-at stamp').toBeTruthy();
      // Parses as a real instant, and is the time of THIS write rather than
      // some fixed placeholder string.
      const assertedAtMilliseconds = Date.parse(String(assertedAt));
      expect(Number.isNaN(assertedAtMilliseconds), 'the stamp parses as a timestamp').toBe(false);
      expect(assertedAtMilliseconds).toBeGreaterThanOrEqual(earliestAcceptableWriteTime - 1000);
      expect(assertedAtMilliseconds).toBeLessThanOrEqual(Date.now() + 1000);
      // ISO 8601 with a UTC zone, matching every other timestamp the belief
      // system writes.
      expect(String(assertedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  // A credence can only be asserted about a node that exists. Asserting one
  // about an unknown id must come back as an error rather than silently
  // succeeding, and must create nothing — a credence with no node behind it
  // would be a belief about nothing.
  it('setBeliefFixedCredence returns an error for a node_id that does not exist and creates nothing', async () => {
    await withStandaloneClient(async (client) => {
      const nodeCountBefore = countNodes();
      const movementCountBefore = countBeliefMovements();

      const result = await client.callTool({
        name: 'setBeliefFixedCredence',
        arguments: { node_id: 9999, belief_credence: 0.9 },
      });

      expect(
        (result as { isError?: boolean }).isError,
        'asserting a credence about an unknown node must fail'
      ).toBe(true);
      // The failure must come from the tool rejecting the unknown node, not
      // from the tool itself being unregistered.
      expect(
        JSON.stringify((result as { content?: unknown }).content),
        'the error must be about the node, not about a missing tool'
      ).not.toMatch(UNREGISTERED_TOOL_ERROR_PATTERN);
      // Nothing was created and nothing was logged.
      expect(countNodes()).toBe(nodeCountBefore);
      expect(countBeliefMovements()).toBe(movementCountBefore);
    });
  });

  // Discoverability and vocabulary: the tool's parameters follow the column
  // names exactly (node_id, belief_credence), and the deleted trust tools
  // must be gone from the advertised surface — an external agent must not be
  // able to learn a mechanism that no longer exists.
  it('advertises setBeliefFixedCredence with node_id and belief_credence, and no source-trust tools', async () => {
    await withStandaloneClient(async (client) => {
      const listedTools = await client.listTools();
      const listedToolNames = listedTools.tools.map((tool) => tool.name);

      expect(listedToolNames).toContain('setBeliefFixedCredence');
      expect(listedToolNames).not.toContain('setBeliefSourceTrust');
      expect(listedToolNames).not.toContain('getBeliefSourceTrust');

      const setBeliefFixedCredenceTool = listedTools.tools.find(
        (tool) => tool.name === 'setBeliefFixedCredence'
      );
      const inputSchemaJson = JSON.stringify(setBeliefFixedCredenceTool?.inputSchema);
      expect(inputSchemaJson).toContain('node_id');
      expect(inputSchemaJson).toContain('belief_credence');
      // The banned synonyms for credence must not appear on the surface.
      expect(inputSchemaJson).not.toContain('trust_origin_key');
      expect(inputSchemaJson).not.toContain('score');
    });
  });

  // The deleted tools are not merely unadvertised: calling one by name must
  // come back as an unregistered tool. The MCP server answers a call to a
  // name it does not know with an isError result whose text says the tool was
  // not found, so that exact wording is what separates "the tool is gone"
  // from "the tool is still there and threw for some other reason".
  it('the removed setBeliefSourceTrust and getBeliefSourceTrust tools are unregistered', async () => {
    await withStandaloneClient(async (client) => {
      for (const removedToolName of ['setBeliefSourceTrust', 'getBeliefSourceTrust']) {
        const result = await client.callTool({
          name: removedToolName,
          arguments: { trust_origin_key: 'agent:alpha', score: 0.8 },
        });

        expect(
          (result as { isError?: boolean }).isError,
          `${removedToolName} must be gone from the standalone server`
        ).toBe(true);
        const errorText = JSON.stringify((result as { content?: unknown }).content);
        expect(errorText, `${removedToolName} must be unregistered, not merely failing`).toMatch(
          /not found/i
        );
      }
    });
  });

  // CORRECTED from "a support of exactly 0 is rejected". A support of 0 is a
  // legitimate, recordable judgement and must be STORED: support carries the
  // same two states credence does on a node — NULL means the edge was never
  // assessed as evidence at all, 0 means it WAS assessed and leans neither
  // way. Rejecting 0 would force a classifier that genuinely finds no lean to
  // invent one, manufacturing signal that isn't there. So the tool must
  // accept it, write the row, and store 0 — never NULL, because collapsing
  // the two would erase exactly the distinction this field carries.
  it('createEdge accepts a belief_evidence_support of exactly 0, writes the edge, and stores 0 rather than NULL', async () => {
    await withStandaloneClient(async (client) => {
      const edgesBefore = countEdgesBetween(2, 1);

      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result that bears neither way on the claim node.',
          confirmed_by_user: true,
          belief_evidence_support: 0,
        },
      });

      expect((result as { isError?: boolean }).isError ?? false).toBe(false);
      const structured = getStructured<{ success: boolean; edgeId: number }>(result);
      expect(structured.success).toBe(true);
      // The row really was written.
      expect(countEdgesBetween(2, 1)).toBe(edgesBefore + 1);

      const evidenceRow = readEdgeEvidenceRow(structured.edgeId);
      expect(evidenceRow).toBeDefined();
      // toBe(0) distinguishes a stored zero from NULL — the whole point of
      // the correction. Number(null) would be 0, so never coerce here.
      expect(evidenceRow?.belief_evidence_support).toBe(0);
      expect(evidenceRow?.belief_evidence_support).not.toBeNull();
      // Grading is still app-owned, so the stamp stays NULL as for any other
      // standalone write.
      expect(evidenceRow?.belief_evidence_contribution).toBeNull();
    });
  });

  // REWRITTEN from the [-1, 1] range case: support is unsigned, so the range
  // runs 0..1 and anything above 1 is out of bounds (negatives have their own
  // rejection test above) — a tool error with no row written.
  it('createEdge rejects a belief_evidence_support above 1 and writes no edge row', async () => {
    await withStandaloneClient(async (client) => {
      // Above the unsigned range, checked in one server session.
      for (const outOfRangeSupport of [1.5, 2]) {
        const edgesBefore = countEdgesBetween(2, 1);

        const result = await client.callTool({
          name: 'createEdge',
          arguments: {
            sourceId: 2,
            targetId: 1,
            explanation: 'Reports a measured result that supports the claim node.',
            confirmed_by_user: true,
            belief_evidence_support: outOfRangeSupport,
          },
        });

        expect(
          (result as { isError?: boolean }).isError,
          `support ${outOfRangeSupport} must be rejected`
        ).toBe(true);
        expect(countEdgesBetween(2, 1)).toBe(edgesBefore);
      }
    });
  });

  // CLAUDE.md's belief-vocabulary rule bans trust / standing / score / weight
  // / value as synonyms for credence anywhere in belief code, comments or TOOL
  // DESCRIPTIONS. A tool description is the one place the rule is enforced by
  // an external reader rather than by us: it is the prose an agent reads
  // before it writes belief data, so a second word for credence there teaches
  // the caller the wrong model of the quantity it is about to set.
  //
  // The check reads the LIVE registered descriptions from tools/list rather
  // than grepping the source, so it pins what callers actually receive, and it
  // matches WHOLE WORDS only: "understanding" legitimately contains
  // "standing", and banning the substring would fail on prose that is fine.
  // Scope: every tool whose own description or input schema already talks
  // about belief — the fork-owned belief surface, not upstream's tools.
  it('registers no banned credence synonym in the description of any belief tool', async () => {
    // The five words CLAUDE.md bans as synonyms for credence, plus the plurals
    // the same words appear in, as whole-word patterns.
    const bannedCredenceSynonymPattern = /\b(trust|trusts|trusted|standing|standings|score|scores|weight|weights|value|values)\b/i;

    await withStandaloneClient(async (client) => {
      const listedTools = await client.listTools();

      // A tool is part of the belief surface when its own advertised prose
      // already names the belief system — description or input schema.
      const beliefSurfaceTools = listedTools.tools.filter((tool) => {
        const advertisedProse = `${tool.description ?? ''} ${JSON.stringify(tool.inputSchema ?? {})}`;
        return /belief|credence/i.test(advertisedProse);
      });

      // Guard against the filter silently matching nothing: the credence
      // bootstrap tool must be in the swept set, or this test proves nothing.
      expect(beliefSurfaceTools.map((tool) => tool.name)).toContain('setBeliefFixedCredence');

      for (const beliefSurfaceTool of beliefSurfaceTools) {
        const bannedSynonymMatch = bannedCredenceSynonymPattern.exec(beliefSurfaceTool.description ?? '');
        expect(
          bannedSynonymMatch?.[0],
          `${beliefSurfaceTool.name} description uses the banned credence synonym ` +
            `"${bannedSynonymMatch?.[0]}" — one word per concept: it is credence`
        ).toBeUndefined();
      }
    });
  });
});
