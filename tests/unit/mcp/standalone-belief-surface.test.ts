/**
 * Contract tests for the standalone MCP server's belief surface:
 *  - schema parity: the standalone init-db path must create the belief NODE
 *    columns the app reads, and NO evidence column on edges — belief
 *    evidence left this fork in the evidence-leaves-the-edges-table slice,
 *  - schema parity part two: the standalone init-db path must create
 *    nodes.belief_credence_is_fixed and must NOT create belief_source_trust —
 *    a source is just a node and its influence IS its own belief_credence,
 *  - getNodesById exposes belief_credence / belief_computed_at /
 *    belief_credence_is_fixed,
 *  - the deleted setBeliefSourceTrust / getBeliefSourceTrust tools are gone.
 *
 * deleted in the evidence-leaves-the-edges-table slice: every createEdge
 * evidence test (the stores-support test, both range tests, the boundary 0
 * and 1 store tests, the stale direction/strength test, the
 * advertises-support test and the stores-NULL-in-both guard) — the
 * standalone edge tools shed the support parameter entirely, pinned in
 * standalone-edge-tools-shed-evidence.test.ts.
 *
 * deleted in the engine-leaves-the-fork slice: every setBeliefFixedCredence
 * behaviour test and every belief_movements pin — the hand-assert tools and
 * the movement log left the fork with the engine (their absence is pinned in
 * standalone-fixed-credence-tools-gone.test.ts).
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

// Seed a database that already carries the full belief NODE schema and a
// plain edges table with no evidence columns, so the tool-behavior tests
// below exercise the tools, not schema migration. (Schema creation by the
// standalone path itself is pinned separately in the init-db parity test.)
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
    'Belief Surface Source Node',
    'The node the fixed-credence read test seeds a hand-asserted credence on.',
    'Source node text for standalone belief-surface testing.',
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
  // already contain the belief NODE columns — and no evidence column on
  // edges — so app and standalone agree on one schema.
  it('init-db creates a database with belief node columns and no edge evidence columns', () => {
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
        // EDITED in the evidence-leaves-the-edges-table slice: the
        // standalone init-db column list must create NO evidence column on
        // edges, under any name any past schema shipped one under.
        expect(edgeColumnNames).not.toContain('belief_evidence_support');
        expect(edgeColumnNames).not.toContain('belief_evidence_contribution');
        expect(edgeColumnNames).not.toContain('belief_evidence_direction');
        expect(edgeColumnNames).not.toContain('belief_evidence_strength');
        expect(edgeColumnNames).not.toContain('belief_evidence_origin_key');
        // Sources are nodes: the standalone init-db path must create the
        // fixed-credence flag the app reads, and must NOT create the deleted
        // trust table beside it. App and standalone have to agree on one
        // schema or offline writes land in a shape the app cannot read.
        expect(nodeColumnNames).toContain('belief_credence_is_fixed');
        expect(tableNames).not.toContain('belief_source_trust');

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

  // Belief read path part two: a credence alone does not say where it came
  // from, so the read path must expose belief_credence_is_fixed beside it —
  // an external agent has to be able to tell a human-asserted credence from
  // one samai's engine graded before it decides what to do next.
  it('getNodesById returns belief_credence_is_fixed beside belief_credence', async () => {
    // Node 1 stays ordinary; node 2 carries a hand-asserted credence, seeded
    // by direct SQL — the hand-assert tools left the fork with the engine,
    // but the stored flag is a surviving display column the read must serve.
    const directDb = new Database(dbPath);
    directDb
      .prepare('UPDATE nodes SET belief_credence = 0.9, belief_credence_is_fixed = 1 WHERE id = 2')
      .run();
    directDb.close();

    await withStandaloneClient(async (client) => {
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

      // Guard against the filter silently matching nothing: createEdge's
      // description states that an edge carries no belief data, so it must be
      // in the swept set — otherwise this test proves nothing.
      expect(beliefSurfaceTools.map((tool) => tool.name)).toContain('createEdge');

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
