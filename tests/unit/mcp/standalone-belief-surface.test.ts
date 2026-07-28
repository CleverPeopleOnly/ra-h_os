/**
 * Contract tests for the standalone MCP server's belief surface:
 *  - schema parity: the standalone init-db path must create the belief
 *    columns and tables the app's belief engine expects, including the signed
 *    belief_evidence_support column and NEITHER of the two columns it
 *    replaces (belief_evidence_direction / belief_evidence_strength), nor the
 *    removed belief_evidence_origin_key,
 *  - createEdge accepts and stores the one writable evidence field
 *    (belief_evidence_contribution stays NULL — grading is app-owned), and
 *    ignores stale merged-away arguments instead of failing,
 *  - getNodesById exposes belief_credence / belief_computed_at,
 *  - new setBeliefSourceTrust / getBeliefSourceTrust tools upsert and read belief_source_trust,
 *  - createEdge rejects an out-of-range support (outside [-1, +1]) with a
 *    tool error and writes no row, but ACCEPTS a support of exactly 0 and
 *    stores it: NULL means the edge was never assessed as evidence, 0 means
 *    it was assessed and leans neither way, and those are different claims.
 *
 * SAFETY: every database in this file is a fresh temp file under os.tmpdir()
 * (HOME and RAH_DB_PATH are both pinned into the temp root before the server
 * process spawns). The spawned server is always terminated in the finally
 * block of withStandaloneClient, so no orphan processes survive a failure.
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
      belief_computed_at TEXT
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

    CREATE TABLE belief_source_trust (
      trust_origin_key TEXT PRIMARY KEY,
      score REAL NOT NULL,
      updated_at TEXT NOT NULL
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
    JSON.stringify({ captured_by: 'human', trustOriginKey: 'agent:standalone-test' }),
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

// Read one belief_source_trust row straight from the temp database file.
function readBeliefSourceTrustRow(trustOriginKey: string): { trust_origin_key: string; score: number } | undefined {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return directDb
      .prepare('SELECT trust_origin_key, score FROM belief_source_trust WHERE trust_origin_key = ?')
      .get(trustOriginKey) as { trust_origin_key: string; score: number } | undefined;
  } finally {
    directDb.close();
  }
}

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
        expect(tableNames).toContain('belief_source_trust');
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

  // Sign pass-through: a negative support is a contradiction, and only 0 is
  // meaningless — so an in-range negative value must be stored verbatim.
  it('createEdge stores a negative belief_evidence_support with its sign intact', async () => {
    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result that contradicts the claim node.',
          confirmed_by_user: true,
          belief_evidence_support: -0.4,
        },
      });

      const structured = getStructured<{ success: boolean; edgeId: number }>(result);
      expect(structured.success).toBe(true);
      expect(Number(readEdgeEvidenceRow(structured.edgeId)?.belief_evidence_support)).toBeCloseTo(
        -0.4,
        10
      );
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

  // Trust write/read path: setBeliefSourceTrust upserts (second call updates the
  // single row in place) and getBeliefSourceTrust reads the row back.
  it('setBeliefSourceTrust upserts a belief_source_trust row and getBeliefSourceTrust reads it back', async () => {
    await withStandaloneClient(async (client) => {
      await client.callTool({
        name: 'setBeliefSourceTrust',
        arguments: { trust_origin_key: 'agent:alpha', score: 0.8 },
      });

      const firstWrite = readBeliefSourceTrustRow('agent:alpha');
      expect(firstWrite).toBeDefined();
      expect(firstWrite?.score).toBeCloseTo(0.8, 10);

      // Second call for the same key updates in place — still one row.
      await client.callTool({
        name: 'setBeliefSourceTrust',
        arguments: { trust_origin_key: 'agent:alpha', score: 0.3 },
      });

      const secondWrite = readBeliefSourceTrustRow('agent:alpha');
      expect(secondWrite?.score).toBeCloseTo(0.3, 10);

      const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
      const rowCount = directDb
        .prepare('SELECT COUNT(*) AS count FROM belief_source_trust WHERE trust_origin_key = ?')
        .get('agent:alpha') as { count: number };
      directDb.close();
      expect(rowCount.count).toBe(1);

      const readResult = await client.callTool({
        name: 'getBeliefSourceTrust',
        arguments: { trust_origin_key: 'agent:alpha' },
      });
      const readStructured = getStructured<{
        trust_origin_key: string;
        trust: { score: number } | null;
      }>(readResult);
      expect(readStructured.trust).not.toBeNull();
      expect(readStructured.trust?.score).toBeCloseTo(0.3, 10);
    });
  });

  // Unknown origins are a real state: getBeliefSourceTrust must report null, not
  // invent a default — the belief engine treats such an origin as unassessed
  // and excludes its evidence entirely rather than falling back to a default.
  it('getBeliefSourceTrust returns null trust for an origin key with no belief_source_trust row', async () => {
    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'getBeliefSourceTrust',
        arguments: { trust_origin_key: 'agent:never-seen' },
      });
      const structured = getStructured<{ trust_origin_key: string; trust: { score: number } | null }>(
        result
      );
      expect(structured.trust).toBeNull();
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

  // REPLACES the strength-outside-[0,1] case: the signed field's range runs
  // -1..+1, so both ends are out of bounds and both must be a tool error
  // with no row written.
  it('createEdge rejects a belief_evidence_support outside [-1, 1] at either end and writes no edge row', async () => {
    await withStandaloneClient(async (client) => {
      // Both ends of the signed range, checked in one server session.
      for (const outOfRangeSupport of [1.5, -1.5]) {
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
});
