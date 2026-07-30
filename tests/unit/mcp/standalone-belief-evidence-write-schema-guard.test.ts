/**
 * The standalone MCP server's evidence WRITE guard must ask the SCHEMA, not
 * the caller (apps/mcp-server-standalone/services/edgeService.js createEdge).
 *
 * createEdge chooses between two INSERT statements — one that names
 * belief_evidence_support and one that does not — so that plain relationship
 * edges keep working against a database that predates the belief schema. That
 * is a question about the DATABASE, but today it is answered by asking whether
 * the CALLER supplied belief_evidence_support. The two are not the same
 * question, and the gap is reachable: initDatabase() (services/sqlite-client.js)
 * opens an existing file and sets pragmas only — it never migrates — and
 * ensureMinimumSchema lives in cli.js, which runs only on init-db / setup /
 * doctor. So a server pointed at a pre-belief database starts happily, and:
 *   - a plain edge takes the non-belief INSERT and succeeds,
 *   - an evidence edge takes the belief INSERT and dies on a raw SQLite
 *     "no such column: belief_evidence_support", which tells the agent nothing
 *     about what to do.
 *
 * This file pins the corrected contract:
 *   - the guard is the schema: a plain edge still succeeds against a pre-belief
 *     database (nothing regresses for a caller who is not writing evidence),
 *   - an evidence-carrying call against a pre-belief database is rejected with
 *     an error that NAMES the missing column and points at the migration
 *     (init-db), rather than surfacing SQLite's own column error,
 *   - the rejected call writes no row at all,
 *   - and the normal path is untouched: against a full belief schema, plain and
 *     evidence edges both succeed and the support is stored verbatim,
 *     including 0 (assessed, carries nothing — never NULL).
 *
 * SAFETY: every database in this file is a fresh temp file under os.tmpdir()
 * (HOME and RAH_DB_PATH are both pinned into the temp root before the server
 * process spawns). The spawned server is always terminated in the finally block
 * of withStandaloneClient, so no orphan processes survive a failure.
 *
 * SAFETY, second rule (as in tests/unit/mcp/standalone-belief-surface.test.ts):
 * this file imports NOTHING from src/ and does not require the standalone
 * sqlite-client either. It drives a spawned server process and reads the temp
 * file with its own better-sqlite3 connections, so no module-load side effect
 * can ever open the user's REAL database.
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

// The claim node every edge below points at, and the node the evidence comes
// from. Two nodes is all a createEdge call needs.
const CLAIM_NODE_ID = 1;
const EVIDENCE_SOURCE_NODE_ID = 2;

// Seed the two nodes both fixtures need, through an already-open connection.
function seedClaimAndEvidenceSourceNodes(db: Database.Database): void {
  const now = new Date().toISOString();
  const insertNode = db.prepare(`
    INSERT INTO nodes (id, title, description, source, created_at, updated_at, metadata, chunk_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'not_chunked')
  `);

  insertNode.run(
    CLAIM_NODE_ID,
    'Claim node under evidence write',
    'The claim node the evidence edges below point at.',
    'Claim node source text.',
    now,
    now,
    JSON.stringify({ captured_by: 'human' })
  );
  insertNode.run(
    EVIDENCE_SOURCE_NODE_ID,
    'Evidence source node',
    'The node the evidence edges below are written from.',
    'Evidence source node text.',
    now,
    now,
    JSON.stringify({ captured_by: 'human' })
  );
}

// Seed a database that PREDATES the belief schema: exactly the tables and
// columns cli.js ensureMinimumSchema laid down before the fork added belief,
// and NONE of the belief columns or belief tables. Every column
// validateExistingRahSchema demands is present, so the standalone server opens
// this file without complaint — which is precisely why the gap is reachable.
function createStandaloneDbBeforeBeliefColumnsExisted(targetPath: string): void {
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
      chunk_status TEXT DEFAULT 'not_chunked'
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
  `);

  seedClaimAndEvidenceSourceNodes(db);
  db.close();
}

// Seed a database carrying the full post-merge belief schema, for the
// untouched-normal-path guard at the bottom of this file.
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

  seedClaimAndEvidenceSourceNodes(db);
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

  const client = new Client({
    name: 'ra-h-standalone-belief-evidence-write-schema-guard-test',
    version: '1.0.0',
  });
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

// Join the text parts of a tool result, which is where the MCP server puts the
// message of an error a tool handler threw.
function readToolResultText(result: unknown): string {
  const contentParts =
    (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return contentParts.map((part) => part.text ?? '').join('\n');
}

// Count every edge row in the temp database file with an independent
// connection — used to prove a rejected write left nothing behind.
function countEdgeRows(): number {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (directDb.prepare('SELECT COUNT(*) AS count FROM edges').get() as { count: number })
      .count;
  } finally {
    directDb.close();
  }
}

// Read one edge row's stored support from a database that HAS the belief
// columns. Only used by the full-belief-schema guard.
function readEdgeBeliefEvidenceSupport(edgeId: number): number | null | undefined {
  const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = directDb
      .prepare('SELECT belief_evidence_support FROM edges WHERE id = ?')
      .get(edgeId) as { belief_evidence_support: number | null } | undefined;
    return row?.belief_evidence_support;
  } finally {
    directDb.close();
  }
}

// The structured payload createEdge answers with on success.
interface CreateEdgeStructuredContent {
  success: boolean;
  edgeId: number;
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-standalone-evidence-write-guard-test-'));
  tempHome = path.join(tempRoot, 'home');
  dbPath = path.join(tempHome, 'Library', 'Application Support', 'RA-H', 'db', 'rah.sqlite');
});

beforeEach(() => {
  // Each test seeds its own schema generation into a clean fake HOME.
  fs.rmSync(tempHome, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('standalone MCP server createEdge decides its INSERT by the schema, not by the caller', () => {
  // GUARD: the whole reason the two-branch INSERT exists. A caller who is not
  // writing evidence must keep working against a database that predates the
  // belief columns, and must keep working once the guard asks the schema
  // instead of the caller.
  it('GUARD: writes a plain relationship edge against a database that predates the belief columns', async () => {
    createStandaloneDbBeforeBeliefColumnsExisted(dbPath);

    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: EVIDENCE_SOURCE_NODE_ID,
          targetId: CLAIM_NODE_ID,
          explanation: 'Discusses the same topic as the claim node.',
          confirmed_by_user: true,
        },
      });

      expect((result as { isError?: boolean }).isError ?? false).toBe(false);
      expect(getStructured<CreateEdgeStructuredContent>(result).success).toBe(true);
      expect(countEdgeRows()).toBe(1);
    });
  });

  // The behaviour this MR changes. Against a pre-belief database there is
  // nowhere to put a support, so the write must be refused — but refused with
  // an error an agent can ACT on: it names the column that is missing and the
  // command that adds it (init-db). SQLite's own "no such column" text names
  // the column by accident and says nothing about the fix, so a message that
  // still reads like a raw driver error has not met the contract.
  it('rejects an evidence-carrying edge against a pre-belief database with an error naming belief_evidence_support and the init-db migration', async () => {
    createStandaloneDbBeforeBeliefColumnsExisted(dbPath);

    await withStandaloneClient(async (client) => {
      const result = await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: EVIDENCE_SOURCE_NODE_ID,
          targetId: CLAIM_NODE_ID,
          explanation: 'Reports a measured result that supports the claim node.',
          confirmed_by_user: true,
          belief_evidence_support: 0.6,
        },
      });

      expect(
        (result as { isError?: boolean }).isError,
        'a support has nowhere to go on a pre-belief database, so the write must be refused'
      ).toBe(true);

      const errorText = readToolResultText(result);
      // Names the field the caller sent that cannot be stored.
      expect(errorText).toContain('belief_evidence_support');
      // Points at the fix, by the name of the command that performs it.
      expect(
        errorText,
        'the error must tell the caller how to fix it: run the init-db migration'
      ).toMatch(/init-db/);
      expect(
        errorText,
        'the error must say the database needs migrating, not just that a column is absent'
      ).toMatch(/migrat/i);
      // Not SQLite's own column error leaking through: that text explains the
      // symptom and not the cause, and an agent cannot act on it.
      expect(
        errorText,
        'the cause is a database that predates the belief schema, not a raw SQLite column error'
      ).not.toMatch(/no such column|has no column named/i);
    });
  });

  // A refused evidence write must leave the graph exactly as it was: no plain
  // edge quietly substituted for the evidence edge the caller asked for, and
  // no half-written row. An agent that asked to record evidence and got an
  // error must not discover an unlabelled edge in the graph afterwards.
  it('writes no edge row at all when an evidence-carrying edge is refused against a pre-belief database', async () => {
    createStandaloneDbBeforeBeliefColumnsExisted(dbPath);

    await withStandaloneClient(async (client) => {
      const edgeRowsBefore = countEdgeRows();

      await client.callTool({
        name: 'createEdge',
        arguments: {
          sourceId: EVIDENCE_SOURCE_NODE_ID,
          targetId: CLAIM_NODE_ID,
          explanation: 'Reports a measured result that supports the claim node.',
          confirmed_by_user: true,
          belief_evidence_support: 0.6,
        },
      });

      expect(countEdgeRows()).toBe(edgeRowsBefore);
    });
  });

  // GUARD: asking the schema must not change anything for the database the
  // fork actually ships. On a full belief schema all three call shapes behave
  // as before — a plain edge stores NULL (never assessed), a graded-strength
  // support stores verbatim, and a support of 0 stores 0 (assessed, carries
  // nothing) rather than collapsing to NULL.
  it('GUARD: stores support verbatim including 0 against a database with the belief columns', async () => {
    createStandaloneDbWithBeliefSchema(dbPath);

    await withStandaloneClient(async (client) => {
      // Each entry is one call shape and the support it must leave in the row.
      const evidenceWriteCases: Array<{
        callArguments: Record<string, unknown>;
        expectedStoredSupport: number | null;
      }> = [
        {
          callArguments: { explanation: 'Discusses the same topic as the claim node.' },
          expectedStoredSupport: null,
        },
        {
          callArguments: {
            explanation: 'Reports a measured result that supports the claim node.',
            belief_evidence_support: 0.6,
          },
          expectedStoredSupport: 0.6,
        },
        {
          callArguments: {
            explanation: 'Reports a measured result that bears neither way on the claim node.',
            belief_evidence_support: 0,
          },
          expectedStoredSupport: 0,
        },
      ];

      for (const evidenceWriteCase of evidenceWriteCases) {
        const result = await client.callTool({
          name: 'createEdge',
          arguments: {
            sourceId: EVIDENCE_SOURCE_NODE_ID,
            targetId: CLAIM_NODE_ID,
            confirmed_by_user: true,
            ...evidenceWriteCase.callArguments,
          },
        });

        expect((result as { isError?: boolean }).isError ?? false).toBe(false);
        const structured = getStructured<CreateEdgeStructuredContent>(result);
        expect(structured.success).toBe(true);
        // toBe, never toBeCloseTo: 0 and NULL are different claims and
        // Number(null) is 0, so the two must never be compared loosely.
        expect(readEdgeBeliefEvidenceSupport(structured.edgeId)).toBe(
          evidenceWriteCase.expectedStoredSupport
        );
      }
    });
  });
});
