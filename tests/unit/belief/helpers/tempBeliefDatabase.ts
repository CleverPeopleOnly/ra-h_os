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
 *
 * SOURCES ARE NODES: a source's influence is its OWN nodes.belief_credence —
 * the same number and the same word as the belief of any other node. There
 * is no separate trust table and no trustOriginKey in node metadata any
 * more, so the fixtures below give a source node a credence directly. And
 * since the evidence-leaves-the-edges-table slice no edge carries belief
 * evidence at all, so the one edge fixture writes a plain relationship row.
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

// Column row shape returned by "PRAGMA table_info(<table>)". dflt_value is
// included so a test can pin a column's DEFAULT clause (belief_credence_is_fixed
// is INTEGER NOT NULL DEFAULT 0, and the default is what makes an ordinary node
// ordinary without any write).
export interface SqliteTableColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

// Row shape of the belief_movements audit table as read by the tests. The
// two numeric columns record the SAME quantity as nodes.belief_credence —
// the node's credence before and after a recompute — so they carry the
// vocabulary's one word for it.
export interface BeliefMovementRow {
  // Credence before the recompute; NULL when the node was previously ungraded.
  from_credence: number | null;
  // Credence after the recompute.
  to_credence: number;
  // What caused the recompute.
  trigger: string;
  // When the recompute happened.
  occurred_at: string;
}

// Timestamp stamped on a fixture node that is seeded with a credence, so a
// seeded source looks like a node the engine (or a human) has already graded.
const SEEDED_BELIEF_COMPUTED_AT = '2026-07-01T00:00:00.000Z';

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
  // The live SQLiteClient instance bound to tempDbPath. It is a getter, not a
  // fixed reference, because reopenBeliefDatabase() replaces the client.
  readonly sqlite: import('@/services/database/sqlite-client').SQLiteClient;
  // Insert a node fixture. beliefCredence (if given) is written straight into
  // nodes.belief_credence — for a source node that IS the credence its evidence
  // carries; omit it for a node nobody has graded (credence NULL).
  insertNodeFixture(options: { title: string; beliefCredence?: number }): number;
  // Insert a node whose credence is ASSERTED by a human rather than derived
  // from the graph: belief_credence is set and belief_credence_is_fixed is 1.
  // This is the bootstrap node — without at least one, a derived-only graph
  // can never grade anything.
  insertFixedBeliefCredenceNodeFixture(options: { title: string; beliefCredence: number }): number;
  // Overwrite one node's own credence (NULL puts it back to ungraded), so a
  // test can move a source's credence between two recomputes.
  setNodeBeliefCredence(nodeId: number, beliefCredence: number | null): void;
  // Read the raw belief_credence_is_fixed flag of one node (0/1).
  readNodeBeliefCredenceIsFixed(nodeId: number): number | null;
  // Insert a plain relationship edge fixture directly (bypasses EdgeService
  // and its LLM inference paths). Since the evidence-leaves-the-edges-table
  // slice this is the only kind of edge there is: no edge carries belief
  // evidence, so an edge fixture never touches belief state.
  insertNonEvidenceEdgeFixture(options: { fromNodeId: number; toNodeId: number }): number;
  // Read a node's persisted belief state: its graded credence (NULL when
  // ungraded) and when that credence was computed.
  readNodeBelief(nodeId: number): {
    belief_credence: number | null;
    belief_computed_at: string | null;
  };
  // Read a node's belief movement rows, oldest first.
  readBeliefMovements(nodeId: number): BeliefMovementRow[];
  // Read the column list of a table via PRAGMA table_info.
  readTableColumns(tableName: string): SqliteTableColumn[];
  // True when the named table exists in this database.
  hasTable(tableName: string): boolean;
  // Close the client and open the SAME file again through a fresh module
  // generation, so the schema migration runs a second time over its own
  // output. This is how the idempotence tests prove a rerun is safe.
  reopenBeliefDatabase(): Promise<void>;
  // Import the belief service bound to this database generation.
  importBeliefService(): Promise<typeof import('@/services/belief/beliefService')>;
  // Import the grading-policy module from the SAME module-registry generation
  // the belief service binds to, so a test can spy on
  // beliefGradingPolicyV1.gradeBelief and inspect the contribution objects
  // recomputeNodeBelief actually hands the policy.
  importBeliefGradingPolicyModule(): Promise<typeof import('@/services/belief/beliefGradingPolicy')>;
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

  // Open the temp file through a fresh module registry and verify the client
  // really landed on it. Shared by the first open and by every reopen.
  async function openSqliteClientOnTempFile(): Promise<
    import('@/services/database/sqlite-client').SQLiteClient
  > {
    process.env.SQLITE_DB_PATH = tempDbPath;
    vi.resetModules();
    const sqliteClientModule = await import('@/services/database/sqlite-client');
    const openedClient = sqliteClientModule.getSQLiteClient();

    // Post-open guard: verify the file the client ACTUALLY opened is our temp
    // file, and bail out immediately if it is anything else.
    const attachedDatabases = openedClient.prepare('PRAGMA database_list').all() as Array<{
      name: string;
      file: string;
    }>;
    const mainDatabaseFile = attachedDatabases.find(row => row.name === 'main')?.file ?? '';
    if (fs.realpathSync(mainDatabaseFile) !== fs.realpathSync(tempDbPath)) {
      openedClient.close();
      throw new Error(
        `SAFETY: SQLite client opened "${mainDatabaseFile}" instead of the temp file "${tempDbPath}"`
      );
    }
    return openedClient;
  }

  // The client generation the context currently reads and writes through;
  // replaced wholesale by reopenBeliefDatabase().
  let activeSqliteClient = await openSqliteClientOnTempFile();

  return {
    tempDbPath,

    get sqlite() {
      return activeSqliteClient;
    },

    insertNodeFixture({ title, beliefCredence }) {
      const result = activeSqliteClient
        .prepare(
          'INSERT INTO nodes (title, source, belief_credence, belief_computed_at) VALUES (?, ?, ?, ?)'
        )
        .run(
          title,
          `${title} fixture content`,
          beliefCredence ?? null,
          beliefCredence === undefined ? null : SEEDED_BELIEF_COMPUTED_AT
        );
      return Number(result.lastInsertRowid);
    },

    insertFixedBeliefCredenceNodeFixture({ title, beliefCredence }) {
      const result = activeSqliteClient
        .prepare(
          `INSERT INTO nodes (title, source, belief_credence, belief_computed_at, belief_credence_is_fixed)
           VALUES (?, ?, ?, ?, 1)`
        )
        .run(title, `${title} fixture content`, beliefCredence, SEEDED_BELIEF_COMPUTED_AT);
      return Number(result.lastInsertRowid);
    },

    setNodeBeliefCredence(nodeId, beliefCredence) {
      activeSqliteClient
        .prepare('UPDATE nodes SET belief_credence = ? WHERE id = ?')
        .run(beliefCredence, nodeId);
    },

    readNodeBeliefCredenceIsFixed(nodeId) {
      const row = activeSqliteClient
        .prepare('SELECT belief_credence_is_fixed FROM nodes WHERE id = ?')
        .get(nodeId) as { belief_credence_is_fixed: number | null } | undefined;
      return row?.belief_credence_is_fixed ?? null;
    },

    insertNonEvidenceEdgeFixture({ fromNodeId, toNodeId }) {
      const result = activeSqliteClient
        .prepare(
          `INSERT INTO edges (from_node_id, to_node_id, source, explanation)
           VALUES (?, ?, 'user', 'plain non-evidence edge fixture')`
        )
        .run(fromNodeId, toNodeId);
      return Number(result.lastInsertRowid);
    },

    readNodeBelief(nodeId) {
      return activeSqliteClient
        .prepare('SELECT belief_credence, belief_computed_at FROM nodes WHERE id = ?')
        .get(nodeId) as { belief_credence: number | null; belief_computed_at: string | null };
    },

    readBeliefMovements(nodeId) {
      return activeSqliteClient
        .prepare(
          `SELECT from_credence, to_credence, "trigger", occurred_at
           FROM belief_movements WHERE node_id = ? ORDER BY id ASC`
        )
        .all(nodeId) as BeliefMovementRow[];
    },

    readTableColumns(tableName) {
      return activeSqliteClient
        .prepare(`PRAGMA table_info(${tableName})`)
        .all() as SqliteTableColumn[];
    },

    hasTable(tableName) {
      const tableRow = activeSqliteClient
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(tableName) as { name: string } | undefined;
      return tableRow !== undefined;
    },

    async reopenBeliefDatabase() {
      activeSqliteClient.close();
      activeSqliteClient = await openSqliteClientOnTempFile();
    },

    importBeliefService: () => import('@/services/belief/beliefService'),
    importBeliefGradingPolicyModule: () => import('@/services/belief/beliefGradingPolicy'),
    importEdgeService: () => import('@/services/database/edges'),
    importAutoEmbedQueueModule: () => import('@/services/embedding/autoEmbedQueue'),
    importIngestionModule: () => import('@/services/embedding/ingestion'),

    close() {
      try {
        activeSqliteClient.close();
      } finally {
        // Delete only this test's own mkdtemp directory.
        fs.rmSync(tempDbDir, { recursive: true, force: true });
        // Re-arm the sentinel so any import after close still hits temp.
        process.env.SQLITE_DB_PATH = path.join(sentinelTempDir, 'rah-sentinel.sqlite');
      }
    },
  };
}
