/**
 * FAILING-FIRST red set for slice 9 — THE ENGINE AND BELIEF SERVICES LEAVE
 * THE FORK: the STANDALONE MCP server sheds its fixed-credence tools and its
 * schema stops carrying the belief_movements table.
 *
 * samai owns the belief engine, so the standalone server's two hand-assert
 * tools die with it:
 *  - setBeliefFixedCredence,
 *  - clearBeliefFixedCredence,
 * and the standalone schema path (apps/mcp-server-standalone/cli.js, run via
 * `index.js init-db`) must neither create belief_movements on a fresh
 * database nor leave it behind on an existing one — mirroring the app-side
 * drop, house precedent being belief_source_trust's DROP TABLE IF EXISTS.
 *
 * Seam (same as tests/unit/mcp/standalone-belief-surface.test.ts): a spawned
 * server process over a seeded temp database for the tool surface, and a
 * spawned `init-db` over temp files for the schema. Every database in this
 * file is a fresh temp file under os.tmpdir() (HOME and RAH_DB_PATH pinned
 * into the temp root before any process spawns), and the spawned server is
 * always terminated in the finally block of withStandaloneClient.
 *
 * SAFETY, second rule: this file deliberately imports NOTHING from src/. It
 * drives spawned processes and has no temp-database seam of its own, so
 * importing any app module would pull in '@/services/database/sqlite-client'
 * and risk the user's real database.
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
// Fake HOME handed to every spawned process.
let tempHome: string;
// Path of the seeded database the spawned MCP server under test opens.
let dbPath: string;

// Absolute path of the standalone server entry point under test.
const standaloneServerEntryPath = path.join(
  process.cwd(),
  'apps',
  'mcp-server-standalone',
  'index.js'
);

// The two hand-assert tools deleted from the standalone server with the engine.
const deletedStandaloneToolNames = ['setBeliefFixedCredence', 'clearBeliefFixedCredence'];

// Seed a database that already carries the current full schema — nodes with
// the four display belief columns, plain edges, chunks — so the spawned
// server starts cleanly and the tool-surface tests exercise the registry,
// not schema migration. It deliberately also carries belief_movements: a
// leftover log is exactly the state an existing installation is in, and the
// registry assertions must hold regardless.
function createSeededStandaloneDb(targetPath: string): void {
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
      belief_uncertainty REAL,
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

    INSERT INTO nodes (id, title, description, source)
    VALUES (1, 'Surface Reduction Target Node',
            'The node the dead-tool calls below name, so a still-living handler would demonstrably answer.',
            'Fixture text for the standalone surface-reduction tests.');
  `);

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
    name: 'ra-h-standalone-fixed-credence-gone-test',
    version: '1.0.0',
  });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// Run `init-db` over the given database path in its own spawned process and
// fail the test loudly if it does not exit cleanly.
function runStandaloneInitDb(targetDbPath: string): void {
  const initResult = spawnSync(process.execPath, [standaloneServerEntryPath, 'init-db'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tempHome,
      RAH_DB_PATH: targetDbPath,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(initResult.status, `init-db stderr: ${initResult.stderr}`).toBe(0);
}

// Read the table names of a database file with an independent readonly
// connection (never through any server process).
function readTableNames(targetDbPath: string): string[] {
  const directDb = new Database(targetDbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      directDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  } finally {
    directDb.close();
  }
}

// Read the index names of a database file the same way — the dropped table's
// index must go with it, not survive as an orphan definition.
function readIndexNames(targetDbPath: string): string[] {
  const directDb = new Database(targetDbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      directDb.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  } finally {
    directDb.close();
  }
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-standalone-fixed-gone-test-'));
  tempHome = path.join(tempRoot, 'home');
  dbPath = path.join(tempHome, 'Library', 'Application Support', 'RA-H', 'db', 'rah.sqlite');
});

beforeEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  createSeededStandaloneDb(dbPath);
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('standalone MCP server after the engine leaves the fork', () => {
  // The registry statement: neither hand-assert tool is advertised any more,
  // while an ordinary graph tool still is — so the listing is demonstrably a
  // live one and the absences are real.
  it('advertises neither setBeliefFixedCredence nor clearBeliefFixedCredence', async () => {
    await withStandaloneClient(async (client) => {
      const advertisedToolNames = (await client.listTools()).tools.map((tool) => tool.name);

      for (const deletedStandaloneToolName of deletedStandaloneToolNames) {
        expect(
          advertisedToolNames,
          `${deletedStandaloneToolName} must leave the standalone server with the engine`
        ).not.toContain(deletedStandaloneToolName);
      }
      // Nor does the NEW remote-door fixed-credence pair arrive here: samai
      // asserts and clears a hand-decreed credence through the remote door
      // only, so the standalone server gains the tools under neither the
      // remote naming nor its own camelCase convention.
      expect(advertisedToolNames).not.toContain('rah_assert_fixed_credence');
      expect(advertisedToolNames).not.toContain('rah_clear_fixed_credence');
      expect(advertisedToolNames).not.toContain('assertFixedCredence');
      expect(advertisedToolNames).not.toContain('clearFixedCredence');
      // Sanity survivor: the node read is untouched by this slice.
      expect(advertisedToolNames).toContain('getNodesById');
    });
  });

  // Deletion is not merely unadvertising: calling each dead name must come
  // back as an unregistered tool — the MCP server's own "not found" answer —
  // not as a live handler succeeding or failing for some other reason.
  it('answers a call to either dead tool as an unregistered tool', async () => {
    await withStandaloneClient(async (client) => {
      for (const deletedStandaloneToolName of deletedStandaloneToolNames) {
        const result = await client.callTool({
          name: deletedStandaloneToolName,
          arguments: { node_id: 1, belief_credence: 0.5 },
        });

        expect(
          (result as { isError?: boolean }).isError,
          `${deletedStandaloneToolName} must be gone from the standalone server`
        ).toBe(true);
        const errorText = JSON.stringify((result as { content?: unknown }).content);
        expect(
          errorText,
          `${deletedStandaloneToolName} must be unregistered, not merely failing`
        ).toMatch(/not found/i);
      }
    });
  });

  // The schema side, fresh half: a database created by the standalone
  // init-db path must not carry the belief_movements table or its index any
  // more — nothing in the fork writes or reads movements once the engine is
  // gone.
  it('init-db creates a database with no belief_movements table and no idx_belief_movements_node_id', () => {
    const initDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-standalone-initdb-nomove-'));
    const initDbPath = path.join(initDbDir, 'rah-init.sqlite');
    try {
      runStandaloneInitDb(initDbPath);

      expect(
        readTableNames(initDbPath),
        'a fresh standalone database must not create belief_movements'
      ).not.toContain('belief_movements');
      expect(
        readIndexNames(initDbPath),
        'the movements index must not be created either'
      ).not.toContain('idx_belief_movements_node_id');
    } finally {
      fs.rmSync(initDbDir, { recursive: true, force: true });
    }
  });

  // The schema side, migration half: an existing database still carrying the
  // table (the state every current installation is in) must come out of
  // init-db WITHOUT it — dropped the way belief_source_trust is dropped —
  // while the rows in neighbouring tables survive untouched.
  it('init-db over a database carrying belief_movements drops the table and keeps the nodes beside it', () => {
    // The seeded database from beforeEach already carries belief_movements
    // and one node — exactly the migration input this test needs.
    expect(readTableNames(dbPath)).toContain('belief_movements');

    runStandaloneInitDb(dbPath);

    expect(
      readTableNames(dbPath),
      'belief_movements must be dropped from an existing database, not left behind'
    ).not.toContain('belief_movements');
    expect(
      readIndexNames(dbPath),
      'the movements index must be gone with its table'
    ).not.toContain('idx_belief_movements_node_id');

    // The drop ate nothing beside it: the seeded node survives intact.
    const directDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const survivingNode = directDb
        .prepare('SELECT id, title FROM nodes WHERE id = 1')
        .get() as { id: number; title: string } | undefined;
      expect(survivingNode?.title).toBe('Surface Reduction Target Node');
    } finally {
      directDb.close();
    }
  });
});
