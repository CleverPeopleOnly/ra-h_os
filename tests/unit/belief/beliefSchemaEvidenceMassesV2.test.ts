/**
 * Schema tests for belief model v2 (docs/belief-model-subjective-logic.md §2,
 * §6 and §7): the two evidence-mass columns and the movement-log index, on
 * every path that owns a copy of the belief schema.
 *
 * Pinned here:
 *  - nodes.belief_evidence_for_mass / nodes.belief_evidence_against_mass —
 *    REAL and NULLABLE (both NULL means never assessed; both 0 means assessed
 *    and carrying nothing) — created by ensureBeliefSchemaLocked on a fresh
 *    database AND added to a legacy database that predates them,
 *  - an index on belief_movements(node_id) — every movement read filters on
 *    node_id (spec §5), on fresh and legacy databases alike,
 *  - the standalone CLI DDL (apps/mcp-server-standalone/cli.js, driven
 *    through index.js init-db exactly as the parity tests drive it) creates
 *    the SAME two mass columns and the same movement-log index, so a database
 *    either side creates is one the other can run over.
 *
 * The both-NULL-or-both-non-NULL rule is a SERVICE-layer invariant (SQLite
 * cannot cheaply express it across two nullable columns) and is pinned in
 * beliefServiceEvidenceMassPersistenceV2.test.ts.
 *
 * Every database in this file is a fresh temp file under the OS tmpdir — see
 * tempBeliefDatabase.ts for the safety seam.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openTempBeliefDatabase,
  type SqliteTableColumn,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// The two v2 evidence-mass columns, in the one spelling the spec fixes.
const beliefEvidenceMassColumnNames = [
  'belief_evidence_for_mass',
  'belief_evidence_against_mass',
] as const;

// Find one column by name in a PRAGMA table_info result set.
function findColumn(columns: SqliteTableColumn[], name: string): SqliteTableColumn | undefined {
  return columns.find(column => column.name === name);
}

// One row of "PRAGMA index_list(<table>)" as these tests read it.
interface SqliteIndexListRow {
  name: string;
}

// One row of "PRAGMA index_info(<index>)" as these tests read it.
interface SqliteIndexInfoRow {
  name: string;
}

// True when the belief_movements table carries at least one index whose
// leading column is node_id — the shape spec §5 demands, checked through any
// better-sqlite3 connection so the app and standalone sides share one probe.
function hasBeliefMovementsNodeIdIndex(
  runPragma: (pragmaSql: string) => unknown[]
): boolean {
  const movementIndexes = runPragma('PRAGMA index_list(belief_movements)') as SqliteIndexListRow[];
  return movementIndexes.some(movementIndex => {
    const indexedColumns = runPragma(
      `PRAGMA index_info(${JSON.stringify(movementIndex.name)})`
    ) as SqliteIndexInfoRow[];
    return indexedColumns.length > 0 && indexedColumns[0].name === 'node_id';
  });
}

// Lay down a legacy database file with the pre-belief nodes/edges shape, so
// client init must ADD every belief column including the v2 masses. Restated
// locally (not imported from beliefSchema.test.ts, whose module scope runs
// its own suite).
function createLegacyDatabaseWithoutBeliefColumns(dbPath: string): void {
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
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
      explanation TEXT,
      FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (to_node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
  `);
  legacyDb.close();
}

// Absolute path of the standalone server entry point, whose "init-db"
// subcommand drives the standalone copy of the schema in cli.js.
const standaloneServerEntryPath = path.join(
  process.cwd(),
  'apps',
  'mcp-server-standalone',
  'index.js'
);

// Run standalone init-db against one database file, failing the test with its
// stderr if it does not exit cleanly — same drive as the parity tests.
function runStandaloneInitDb(targetDbPath: string): void {
  const initDbResult = spawnSync(process.execPath, [standaloneServerEntryPath, 'init-db'], {
    cwd: process.cwd(),
    env: { ...process.env, RAH_DB_PATH: targetDbPath },
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(initDbResult.status, `standalone init-db stderr: ${initDbResult.stderr}`).toBe(0);
}

describe('belief evidence-mass schema (v2)', () => {
  // Spec §2: the two unsigned mass columns are the primary belief state; both
  // REAL and NULLABLE, because both-NULL is the "never assessed" state.
  it('fresh database: nodes has belief_evidence_for_mass and belief_evidence_against_mass, REAL and nullable', async () => {
    db = await openTempBeliefDatabase();
    const nodeColumns = db.readTableColumns('nodes');
    for (const massColumnName of beliefEvidenceMassColumnNames) {
      const massColumn = findColumn(nodeColumns, massColumnName);
      expect(massColumn, `nodes.${massColumnName} should exist`).toBeDefined();
      expect(massColumn?.type.toUpperCase(), `nodes.${massColumnName} type`).toBe('REAL');
      expect(massColumn?.notnull, `nodes.${massColumnName} must be nullable`).toBe(0);
    }
  });

  // A database created before v2 gains both mass columns on client init, with
  // every existing row landing on the never-assessed state (NULL/NULL).
  it('legacy database without belief columns gains both mass columns, NULL on existing rows', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: (dbPath: string) => {
        createLegacyDatabaseWithoutBeliefColumns(dbPath);
        // One pre-existing row, so the backfill state is observable.
        const seededLegacyDb = new Database(dbPath);
        seededLegacyDb.exec("INSERT INTO nodes (id, title) VALUES (1, 'pre-v2 node');");
        seededLegacyDb.close();
      },
    });

    const nodeColumnNames = db.readTableColumns('nodes').map(column => column.name);
    for (const massColumnName of beliefEvidenceMassColumnNames) {
      expect(nodeColumnNames, `nodes.${massColumnName} must be added`).toContain(massColumnName);
    }
    const backfilledMassRow = db.sqlite
      .prepare(
        'SELECT belief_evidence_for_mass, belief_evidence_against_mass FROM nodes WHERE id = 1'
      )
      .get() as {
      belief_evidence_for_mass: number | null;
      belief_evidence_against_mass: number | null;
    };
    expect(backfilledMassRow.belief_evidence_for_mass).toBeNull();
    expect(backfilledMassRow.belief_evidence_against_mass).toBeNull();
  });

  // Spec §5: belief_movements gains an index on node_id — every movement read
  // filters on it. Fresh database.
  it('fresh database: belief_movements has an index whose leading column is node_id', async () => {
    db = await openTempBeliefDatabase();
    const sqlite = db.sqlite;
    expect(
      hasBeliefMovementsNodeIdIndex(pragmaSql => sqlite.prepare(pragmaSql).all()),
      'belief_movements needs an index led by node_id'
    ).toBe(true);
  });

  // The same index appears when client init runs over a legacy database that
  // never had the belief tables at all.
  it('legacy database: client init creates the belief_movements(node_id) index', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createLegacyDatabaseWithoutBeliefColumns,
    });
    const sqlite = db.sqlite;
    expect(
      hasBeliefMovementsNodeIdIndex(pragmaSql => sqlite.prepare(pragmaSql).all())
    ).toBe(true);
  });

  // Spec §6/§7: the standalone CLI's parallel DDL must create the SAME two
  // mass columns — otherwise a standalone-created database is one the app's
  // v2 engine cannot grade in, which is exactly the drift the parity tests
  // exist to prevent.
  it('standalone init-db creates both mass columns on nodes, REAL and nullable', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: (targetDbPath: string) => {
        runStandaloneInitDb(targetDbPath);
        // Read the standalone output BEFORE the app client touches the file,
        // so a failure here blames the standalone DDL, not the app migration.
        const directDb = new Database(targetDbPath, { readonly: true, fileMustExist: true });
        try {
          const standaloneNodeColumns = directDb
            .prepare('PRAGMA table_info(nodes)')
            .all() as SqliteTableColumn[];
          for (const massColumnName of beliefEvidenceMassColumnNames) {
            const massColumn = findColumn(standaloneNodeColumns, massColumnName);
            expect(
              massColumn,
              `standalone init-db must create nodes.${massColumnName}`
            ).toBeDefined();
            expect(massColumn?.type.toUpperCase()).toBe('REAL');
            expect(massColumn?.notnull).toBe(0);
          }
        } finally {
          directDb.close();
        }
      },
    });

    // And the app client opening the same file afterwards leaves them intact.
    const nodeColumnNames = db.readTableColumns('nodes').map(column => column.name);
    for (const massColumnName of beliefEvidenceMassColumnNames) {
      expect(nodeColumnNames).toContain(massColumnName);
    }
  });

  // The standalone DDL also carries the movement-log index (spec §7 names
  // both schema owners for it).
  it('standalone init-db creates the belief_movements(node_id) index', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: (targetDbPath: string) => {
        runStandaloneInitDb(targetDbPath);
        const directDb = new Database(targetDbPath, { readonly: true, fileMustExist: true });
        try {
          expect(
            hasBeliefMovementsNodeIdIndex(pragmaSql => directDb.prepare(pragmaSql).all()),
            'standalone init-db must index belief_movements on node_id'
          ).toBe(true);
        } finally {
          directDb.close();
        }
      },
    });
  });
});
