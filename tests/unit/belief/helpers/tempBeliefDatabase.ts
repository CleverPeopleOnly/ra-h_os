/**
 * Temp-database harness for the belief-engine tests.
 *
 * SAFETY: the real RA-H database lives under the user's home directory
 * (macOS: ~/Library/Application Support/RA-H/db/rah.sqlite). The SQLite
 * client resolves its file from process.env.SQLITE_DB_PATH before falling
 * back to that real path, and it opens the file as a MODULE-LOAD side effect
 * (getSQLiteClient() runs at import time). This module therefore:
 *   (a) pins SQLITE_DB_PATH to a throwaway temp sentinel file the moment it
 *       is loaded, so no accidental product-module import in a belief test
 *       file can ever open the live database, and
 *   (b) hands each test a fresh temp-file-backed client by pointing
 *       SQLITE_DB_PATH at a new mkdtemp path, calling vi.resetModules(), and
 *       dynamically re-importing the client module.
 *
 * RULE for belief test files: never statically import a product module that
 * (transitively) imports '@/services/database/sqlite-client'. Import this
 * helper first, then load product modules through the context's import*
 * methods (or a dynamic import made AFTER openTempBeliefDatabase resolves),
 * so they bind to the same fresh client generation.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';

// Module-load sentinel: from the instant a belief test file loads this
// helper, any accidental sqlite-client import opens a harmless temp file
// instead of the user's real database.
const sentinelTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-belief-sentinel-'));
process.env.SQLITE_DB_PATH = path.join(sentinelTempDir, 'rah-sentinel.sqlite');

// Column row shape returned by "PRAGMA table_info(<table>)".
export interface SqliteTableColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

// Row shape of the belief_movements audit table as read by the tests.
export interface BeliefMovementRow {
  from_value: number | null;
  to_value: number;
  trigger: string;
  occurred_at: string;
}

// Throws unless the given path resolves (symlinks included — macOS tmpdir is
// a /var -> /private/var symlink) to somewhere inside the OS temp directory.
function assertPathIsUnderOsTmpDir(candidatePath: string): void {
  const realTmpRoot = fs.realpathSync(os.tmpdir());
  const realCandidateDir = fs.realpathSync(path.dirname(candidatePath));
  const isUnderTmp =
    realCandidateDir === realTmpRoot || realCandidateDir.startsWith(realTmpRoot + path.sep);
  if (!isUnderTmp) {
    throw new Error(
      `SAFETY: refusing to use database path outside the OS temp directory: ${candidatePath}`
    );
  }
}

// Everything a belief test needs to drive one fresh temp-file database.
export interface TempBeliefDatabase {
  // Absolute path of the temp SQLite file the client under test has open.
  tempDbPath: string;
  // The live SQLiteClient instance bound to tempDbPath.
  sqlite: import('@/services/database/sqlite-client').SQLiteClient;
  // Insert a node fixture; trustOriginKey (if given) is written into the
  // node's metadata JSON, which is where the belief engine reads it from.
  insertNodeFixture(options: { title: string; trustOriginKey?: string }): number;
  // Insert an evidence edge fixture directly (bypasses EdgeService and its
  // LLM inference paths); fails while the evidence columns do not exist yet.
  insertEvidenceEdgeFixture(options: {
    fromNodeId: number;
    toNodeId: number;
    relation: 'supports' | 'contradicts';
    strength: number;
    independenceKey: string | null;
  }): number;
  // Seed or overwrite a source_trust row directly via SQL.
  seedSourceTrustRow(originKey: string, score: number): void;
  // Read a node's persisted belief state.
  readNodeBelief(nodeId: number): { belief_value: number | null; belief_computed_at: string | null };
  // Read a node's belief movement rows, oldest first.
  readBeliefMovements(nodeId: number): BeliefMovementRow[];
  // Read the stamped effective contribution of one evidence edge.
  readEvidenceStamp(edgeId: number): number | null;
  // Read the column list of a table via PRAGMA table_info.
  readTableColumns(tableName: string): SqliteTableColumn[];
  // Import the belief service bound to this database generation.
  importBeliefService(): Promise<typeof import('@/services/belief/beliefService')>;
  // Import the source trust service bound to this database generation.
  importSourceTrustService(): Promise<typeof import('@/services/belief/sourceTrustService')>;
  // Import the edge service bound to this database generation.
  importEdgeService(): Promise<typeof import('@/services/database/edges')>;
  // Import the auto-embed queue module bound to this database generation.
  importAutoEmbedQueueModule(): Promise<typeof import('@/services/embedding/autoEmbedQueue')>;
  // Import the embedding ingestion module bound to this database generation
  // (returns the vi.mock replacement when the test file mocks it).
  importIngestionModule(): Promise<typeof import('@/services/embedding/ingestion')>;
  // Close the client and delete this test's temp directory.
  close(): void;
}

// Options for opening a fresh temp database.
export interface OpenTempBeliefDatabaseOptions {
  // When set, runs BEFORE the SQLite client opens the file — used by the
  // migration tests to lay down a legacy database that lacks the belief
  // columns, so client init must add them.
  prepareExistingDbFile?: (dbPath: string) => void;
}

// Open a brand-new temp-file database and return a context bound to it.
export async function openTempBeliefDatabase(
  options: OpenTempBeliefDatabaseOptions = {}
): Promise<TempBeliefDatabase> {
  // Fresh per-test directory under the OS tmpdir; never a shared/real path.
  const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-belief-test-'));
  const tempDbPath = path.join(tempDbDir, 'rah-belief-test.sqlite');
  assertPathIsUnderOsTmpDir(tempDbPath);

  // Let migration tests pre-create a legacy database file at this path.
  options.prepareExistingDbFile?.(tempDbPath);

  // Point the client's config seam at the temp file, then force a fresh
  // module registry so the singleton client re-initializes against it.
  process.env.SQLITE_DB_PATH = tempDbPath;
  vi.resetModules();
  const sqliteClientModule = await import('@/services/database/sqlite-client');
  const sqlite = sqliteClientModule.getSQLiteClient();

  // Post-open guard: verify the file the client ACTUALLY opened is our temp
  // file, and bail out immediately if it is anything else.
  const attachedDatabases = sqlite.prepare('PRAGMA database_list').all() as Array<{
    name: string;
    file: string;
  }>;
  const mainDatabaseFile = attachedDatabases.find(row => row.name === 'main')?.file ?? '';
  if (fs.realpathSync(mainDatabaseFile) !== fs.realpathSync(tempDbPath)) {
    sqlite.close();
    throw new Error(
      `SAFETY: SQLite client opened "${mainDatabaseFile}" instead of the temp file "${tempDbPath}"`
    );
  }

  return {
    tempDbPath,
    sqlite,

    insertNodeFixture({ title, trustOriginKey }) {
      const metadataJson = trustOriginKey ? JSON.stringify({ trustOriginKey }) : null;
      const result = sqlite
        .prepare('INSERT INTO nodes (title, source, metadata) VALUES (?, ?, ?)')
        .run(title, `${title} fixture content`, metadataJson);
      return Number(result.lastInsertRowid);
    },

    insertEvidenceEdgeFixture({ fromNodeId, toNodeId, relation, strength, independenceKey }) {
      const result = sqlite
        .prepare(
          `INSERT INTO edges
             (from_node_id, to_node_id, source, explanation,
              evidence_relation, evidence_strength, evidence_independence_key)
           VALUES (?, ?, 'user', 'evidence edge fixture', ?, ?, ?)`
        )
        .run(fromNodeId, toNodeId, relation, strength, independenceKey);
      return Number(result.lastInsertRowid);
    },

    seedSourceTrustRow(originKey, score) {
      sqlite
        .prepare(
          `INSERT INTO source_trust (origin_key, score, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(origin_key) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`
        )
        .run(originKey, score);
    },

    readNodeBelief(nodeId) {
      return sqlite
        .prepare('SELECT belief_value, belief_computed_at FROM nodes WHERE id = ?')
        .get(nodeId) as { belief_value: number | null; belief_computed_at: string | null };
    },

    readBeliefMovements(nodeId) {
      return sqlite
        .prepare(
          `SELECT from_value, to_value, "trigger", occurred_at
           FROM belief_movements WHERE node_id = ? ORDER BY id ASC`
        )
        .all(nodeId) as BeliefMovementRow[];
    },

    readEvidenceStamp(edgeId) {
      const row = sqlite
        .prepare('SELECT evidence_effective_contribution FROM edges WHERE id = ?')
        .get(edgeId) as { evidence_effective_contribution: number | null } | undefined;
      return row?.evidence_effective_contribution ?? null;
    },

    readTableColumns(tableName) {
      return sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as SqliteTableColumn[];
    },

    importBeliefService: () => import('@/services/belief/beliefService'),
    importSourceTrustService: () => import('@/services/belief/sourceTrustService'),
    importEdgeService: () => import('@/services/database/edges'),
    importAutoEmbedQueueModule: () => import('@/services/embedding/autoEmbedQueue'),
    importIngestionModule: () => import('@/services/embedding/ingestion'),

    close() {
      try {
        sqlite.close();
      } finally {
        // Delete only this test's own mkdtemp directory.
        fs.rmSync(tempDbDir, { recursive: true, force: true });
        // Re-arm the sentinel so any import after close still hits temp.
        process.env.SQLITE_DB_PATH = path.join(sentinelTempDir, 'rah-sentinel.sqlite');
      }
    },
  };
}
