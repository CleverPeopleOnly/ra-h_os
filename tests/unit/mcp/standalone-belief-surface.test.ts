/**
 * MR-B contract tests for the standalone MCP server's belief surface:
 *  - schema parity: the standalone init-db path must create the belief
 *    columns and tables the app's belief engine expects,
 *  - createEdge accepts and stores the three writable evidence fields
 *    (evidence_effective_contribution stays NULL — grading is app-owned),
 *  - getNodesById exposes belief_value / belief_computed_at,
 *  - new setSourceTrust / getSourceTrust tools upsert and read source_trust,
 *  - createEdge rejects malformed evidence (relation without strength,
 *    strength outside [0,1]) with a tool error and writes no row.
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

// Seed a database that already carries the FULL MR-B belief schema, so the
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
      belief_value REAL,
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
      evidence_relation TEXT,
      evidence_strength REAL,
      evidence_independence_key TEXT,
      evidence_effective_contribution REAL
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

    CREATE TABLE source_trust (
      origin_key TEXT PRIMARY KEY,
      score REAL NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE belief_movements (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL,
      from_value REAL,
      to_value REAL NOT NULL,
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

// The four evidence columns of one edge row, as read back directly via SQL.
interface EdgeEvidenceRow {
  evidence_relation: string | null;
  evidence_strength: number | null;
  evidence_independence_key: string | null;
  evidence_effective_contribution: number | null;
}

// Read one edge row's evidence columns straight from the temp database file
// with an independent better-sqlite3 connection (never through the server).
function readEdgeEvidenceRow(edgeId: number): EdgeEvidenceRow | undefined {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return directDb
      .prepare(
        `SELECT evidence_relation, evidence_strength, evidence_independence_key,
                evidence_effective_contribution
         FROM edges WHERE id = ?`
      )
      .get(edgeId) as EdgeEvidenceRow | undefined;
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

// Read one source_trust row straight from the temp database file.
function readSourceTrustRow(originKey: string): { origin_key: string; score: number } | undefined {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return directDb
      .prepare('SELECT origin_key, score FROM source_trust WHERE origin_key = ?')
      .get(originKey) as { origin_key: string; score: number } | undefined;
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

        expect(nodeColumnNames).toContain('belief_value');
        expect(nodeColumnNames).toContain('belief_computed_at');
        expect(edgeColumnNames).toContain('evidence_relation');
        expect(edgeColumnNames).toContain('evidence_strength');
        expect(edgeColumnNames).toContain('evidence_independence_key');
        expect(edgeColumnNames).toContain('evidence_effective_contribution');
        expect(tableNames).toContain('source_trust');
        expect(tableNames).toContain('belief_movements');
      } finally {
        directDb.close();
      }
    } finally {
      fs.rmSync(initDbDir, { recursive: true, force: true });
    }
  });

  // Evidence write path: createEdge must accept the three writable evidence
  // fields and persist them in the dedicated evidence columns, while the
  // grading stamp (evidence_effective_contribution) stays NULL because the
  // standalone server never grades — grading is app-owned.
  it('createEdge stores evidence_relation, evidence_strength, and evidence_independence_key; contribution stays NULL', async () => {
    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result that supports the claim node.',
          confirmed_by_user: true,
          evidence_relation: 'supports',
          evidence_strength: 0.8,
          evidence_independence_key: 'origin:standalone-belief-test',
        },
      });

      const structured = getStructured<{ success: boolean; edgeId: number }>(result);
      expect(structured.success).toBe(true);

      const evidenceRow = readEdgeEvidenceRow(structured.edgeId);
      expect(evidenceRow).toBeDefined();
      expect(evidenceRow?.evidence_relation).toBe('supports');
      expect(evidenceRow?.evidence_strength).toBeCloseTo(0.8, 10);
      expect(evidenceRow?.evidence_independence_key).toBe('origin:standalone-belief-test');
      expect(evidenceRow?.evidence_effective_contribution).toBeNull();
    });
  });

  // GUARD (deliberately green today): a createEdge call WITHOUT evidence
  // arguments must keep all four evidence columns NULL — plain relationship
  // edges never masquerade as evidence.
  it('GUARD: createEdge without evidence arguments stores NULL in all four evidence columns', async () => {
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
      expect(evidenceRow?.evidence_relation).toBeNull();
      expect(evidenceRow?.evidence_strength).toBeNull();
      expect(evidenceRow?.evidence_independence_key).toBeNull();
      expect(evidenceRow?.evidence_effective_contribution).toBeNull();
    });
  });

  // Belief read path: getNodesById must surface a node's persisted belief
  // state so external agents can read what the app-owned engine graded.
  it('getNodesById returns belief_value and belief_computed_at for a graded node', async () => {
    // Seed a graded node directly via SQL (the app is what grades in real
    // life; here we only pin the standalone READ path).
    const gradedAt = '2026-07-01T12:00:00.000Z';
    const directDb = new Database(dbPath);
    directDb
      .prepare('UPDATE nodes SET belief_value = ?, belief_computed_at = ? WHERE id = ?')
      .run(0.42, gradedAt, 1);
    directDb.close();

    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'getNodesById',
        arguments: { nodeIds: [1] },
      });

      const structured = getStructured<{
        nodes: Array<{ id: number; belief_value: number | null; belief_computed_at: string | null }>;
      }>(result);
      const gradedNode = structured.nodes.find(node => node.id === 1);
      expect(gradedNode).toBeDefined();
      expect(gradedNode?.belief_value).toBeCloseTo(0.42, 10);
      expect(gradedNode?.belief_computed_at).toBe(gradedAt);
    });
  });

  // Trust write/read path: setSourceTrust upserts (second call updates the
  // single row in place) and getSourceTrust reads the row back.
  it('setSourceTrust upserts a source_trust row and getSourceTrust reads it back', async () => {
    await withStandaloneClient(async (client) => {
      await client.callTool({
        name: 'setSourceTrust',
        arguments: { origin_key: 'agent:alpha', score: 0.8 },
      });

      const firstWrite = readSourceTrustRow('agent:alpha');
      expect(firstWrite).toBeDefined();
      expect(firstWrite?.score).toBeCloseTo(0.8, 10);

      // Second call for the same key updates in place — still one row.
      await client.callTool({
        name: 'setSourceTrust',
        arguments: { origin_key: 'agent:alpha', score: 0.3 },
      });

      const secondWrite = readSourceTrustRow('agent:alpha');
      expect(secondWrite?.score).toBeCloseTo(0.3, 10);

      const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
      const rowCount = directDb
        .prepare('SELECT COUNT(*) AS count FROM source_trust WHERE origin_key = ?')
        .get('agent:alpha') as { count: number };
      directDb.close();
      expect(rowCount.count).toBe(1);

      const readResult = await client.callTool({
        name: 'getSourceTrust',
        arguments: { origin_key: 'agent:alpha' },
      });
      const readStructured = getStructured<{
        origin_key: string;
        trust: { score: number } | null;
      }>(readResult);
      expect(readStructured.trust).not.toBeNull();
      expect(readStructured.trust?.score).toBeCloseTo(0.3, 10);
    });
  });

  // Unknown origins are a real state: getSourceTrust must report null, not
  // invent a default (the DEFAULT_ORIGIN_TRUST fallback is app-engine-owned).
  it('getSourceTrust returns null trust for an origin key with no source_trust row', async () => {
    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'getSourceTrust',
        arguments: { origin_key: 'agent:never-seen' },
      });
      const structured = getStructured<{ origin_key: string; trust: { score: number } | null }>(
        result
      );
      expect(structured.trust).toBeNull();
    });
  });

  // Malformed evidence must be a tool error with NO row written: a relation
  // without a strength is ungradeable evidence and must never reach the DB.
  it('createEdge rejects evidence_relation without evidence_strength and writes no edge row', async () => {
    await withStandaloneClient(async (client) => {
      const edgesBefore = countEdgesBetween(2, 1);

      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result that supports the claim node.',
          confirmed_by_user: true,
          evidence_relation: 'supports',
          // evidence_strength deliberately missing
        },
      });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(countEdgesBetween(2, 1)).toBe(edgesBefore);
    });
  });

  // Strength outside [0,1] is equally invalid: tool error, no row.
  it('createEdge rejects evidence_strength outside [0,1] and writes no edge row', async () => {
    await withStandaloneClient(async (client) => {
      const edgesBefore = countEdgesBetween(2, 1);

      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result that supports the claim node.',
          confirmed_by_user: true,
          evidence_relation: 'supports',
          evidence_strength: 1.5,
          evidence_independence_key: 'origin:standalone-belief-test',
        },
      });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(countEdgesBetween(2, 1)).toBe(edgesBefore);
    });
  });
});
