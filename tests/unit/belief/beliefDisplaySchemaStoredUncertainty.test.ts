/**
 * Schema tests for the display-belief slice: the fork's node belief becomes a
 * pure DISPLAY surface that samai writes through the remote MCP door, so the
 * nodes table stores exactly four belief columns — belief_credence,
 * belief_uncertainty (NEW, stored), belief_computed_at,
 * belief_credence_is_fixed — and the two v2 evidence mass columns DIE.
 *
 * belief_uncertainty stored is a deliberate recorded REVERSAL of the v2
 * derive-on-read rule (ruling e of the samai repo's
 * docs/belief-storage-split-engine-to-samai.md): the engine and its masses
 * live in samai now, so samai writes uncertainty beside credence and the
 * map's dashed-vs-solid rings survive the masses' loss.
 *
 * Pins, on the SQLite client's startup migration
 * (src/services/database/sqlite-client.ts):
 *  - FRESH database: nodes has belief_uncertainty REAL nullable and NEITHER
 *    mass column,
 *  - LEGACY (pre-slice) database file: both mass columns are DROPPED and
 *    belief_uncertainty is ADDED — with a one-time BACKFILL: a node whose
 *    masses were non-NULL gets belief_uncertainty = W/(r+s+W) with W=2, so
 *    existing graded rows keep honest rings; a node whose masses were NULL
 *    gets NULL,
 *  - the migration is IDEMPOTENT: reopening its own output changes nothing,
 *  - the graph-events triggers and the direction-slot edges index survive.
 *
 * Every database in this file is a fresh temp file under the OS tmpdir —
 * see tempBeliefDatabase.ts for the safety seam.
 */

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

// Find one column by name in a PRAGMA table_info result set.
function findColumn(columns: SqliteTableColumn[], name: string): SqliteTableColumn | undefined {
  return columns.find(column => column.name === name);
}

// The two mass columns this slice deletes from nodes: samai's engine owns the
// evidence ledger now, so the fork stores no mass under any circumstances.
const removedNodeMassColumnNames = [
  'belief_evidence_for_mass',
  'belief_evidence_against_mass',
] as const;

// W of belief model v2 — the non-informative prior mass the one-time backfill
// derivation uses. Restated here so the expected figures below are computed by
// hand in this file, not read from the code under test.
const BELIEF_PRIOR_MASS = 2;

// The graded legacy node's masses: r=0.72 for, s=0 against. Its backfilled
// belief_uncertainty must be W/(r+s+W) = 2/(0.72+0+2) = 2/2.72
// = 0.7352941176470588... (hand-computed).
const GRADED_LEGACY_FOR_MASS = 0.72;
const GRADED_LEGACY_AGAINST_MASS = 0;
const GRADED_LEGACY_EXPECTED_UNCERTAINTY =
  BELIEF_PRIOR_MASS / (GRADED_LEGACY_FOR_MASS + GRADED_LEGACY_AGAINST_MASS + BELIEF_PRIOR_MASS);

// The conflicted legacy node's masses: r=3 for AND s=1 against. Its
// backfilled belief_uncertainty must be 2/(3+1+2) = 2/6
// = 0.3333333333333333... (hand-computed).
const CONFLICTED_LEGACY_FOR_MASS = 3;
const CONFLICTED_LEGACY_AGAINST_MASS = 1;
const CONFLICTED_LEGACY_EXPECTED_UNCERTAINTY =
  BELIEF_PRIOR_MASS /
  (CONFLICTED_LEGACY_FOR_MASS + CONFLICTED_LEGACY_AGAINST_MASS + BELIEF_PRIOR_MASS);

// The credences the two mass-graded legacy rows carry — seeded values the
// migration must leave untouched (it backfills uncertainty; it never touches
// credence).
const GRADED_LEGACY_CREDENCE = 0.2647;
const CONFLICTED_LEGACY_CREDENCE = 0.3333;
// The hand-asserted credence of the fixed legacy node — also untouched.
const FIXED_LEGACY_CREDENCE = -0.4;

// Lay down a PRE-SLICE database file raw: the nodes table still carries both
// mass columns and no belief_uncertainty, with four seeded rows —
//  id 1: mass-graded (r=0.72, s=0),
//  id 2: conflicted (r=3, s=1),
//  id 3: never assessed (every belief column NULL),
//  id 4: fixed by hand (credence set, flag 1, masses NULL).
// Client init over this file must run the drop-and-backfill migration.
function createPreSliceDatabaseWithMassColumns(dbPath: string): void {
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
      chunk_status TEXT DEFAULT 'not_chunked',
      belief_credence REAL,
      belief_computed_at TEXT,
      belief_credence_is_fixed INTEGER NOT NULL DEFAULT 0,
      belief_evidence_for_mass REAL,
      belief_evidence_against_mass REAL
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
    CREATE TABLE belief_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      from_credence REAL,
      to_credence REAL NOT NULL,
      "trigger" TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
  `);

  // One INSERT per legacy belief state, ids fixed so the assertions below can
  // name each row.
  const insertLegacyNode = legacyDb.prepare(`
    INSERT INTO nodes (
      id, title, source, belief_credence, belief_computed_at,
      belief_credence_is_fixed, belief_evidence_for_mass, belief_evidence_against_mass
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertLegacyNode.run(
    1,
    'Mass-graded legacy node',
    'graded fixture content',
    GRADED_LEGACY_CREDENCE,
    '2026-07-01T00:00:00.000Z',
    0,
    GRADED_LEGACY_FOR_MASS,
    GRADED_LEGACY_AGAINST_MASS
  );
  insertLegacyNode.run(
    2,
    'Conflicted legacy node',
    'conflicted fixture content',
    CONFLICTED_LEGACY_CREDENCE,
    '2026-07-02T00:00:00.000Z',
    0,
    CONFLICTED_LEGACY_FOR_MASS,
    CONFLICTED_LEGACY_AGAINST_MASS
  );
  insertLegacyNode.run(3, 'Never-assessed legacy node', 'ungraded fixture content', null, null, 0, null, null);
  insertLegacyNode.run(
    4,
    'Fixed legacy node',
    'fixed fixture content',
    FIXED_LEGACY_CREDENCE,
    '2026-07-03T00:00:00.000Z',
    1,
    null,
    null
  );

  // One plain edge, so the trigger/index survival test below has edge rows in
  // play while the nodes migration runs.
  legacyDb
    .prepare(
      `INSERT INTO edges (from_node_id, to_node_id, source, explanation)
       VALUES (1, 2, 'user', 'pre-slice plain edge fixture')`
    )
    .run();

  legacyDb.close();
}

// The four belief columns of one node as stored after the migration — the
// display surface, nothing else.
interface StoredDisplayBeliefRow {
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
}

// Read one node's stored display-belief row straight from the database.
function readStoredDisplayBeliefRow(context: TempBeliefDatabase, nodeId: number): StoredDisplayBeliefRow {
  return context.sqlite
    .prepare(
      `SELECT belief_credence, belief_uncertainty, belief_computed_at, belief_credence_is_fixed
       FROM nodes WHERE id = ?`
    )
    .get(nodeId) as StoredDisplayBeliefRow;
}

describe('display-belief schema: fresh database', () => {
  // The fresh shape in one look: the stored uncertainty column exists (REAL,
  // nullable) and neither mass column was ever created.
  it('fresh database: nodes has belief_uncertainty REAL nullable and neither mass column', async () => {
    db = await openTempBeliefDatabase();
    const nodeColumns = db.readTableColumns('nodes');

    const uncertaintyColumn = findColumn(nodeColumns, 'belief_uncertainty');
    expect(uncertaintyColumn, 'nodes.belief_uncertainty must exist on a fresh database').toBeDefined();
    expect(uncertaintyColumn?.type.toUpperCase()).toBe('REAL');
    // Nullable: NULL is the never-assessed state, so the column must not be NOT NULL.
    expect(uncertaintyColumn?.notnull).toBe(0);

    for (const removedMassColumnName of removedNodeMassColumnNames) {
      expect(
        findColumn(nodeColumns, removedMassColumnName),
        `nodes.${removedMassColumnName} must not exist on a fresh database`
      ).toBeUndefined();
    }
  });
});

describe('display-belief schema: legacy migration', () => {
  // The whole drop-and-backfill in one pass: masses gone, uncertainty added,
  // and each of the four legacy belief states lands where the backfill rule
  // says — W/(r+s+W) where masses were non-NULL, NULL where they were NULL.
  it('legacy file: masses dropped, belief_uncertainty added and backfilled per W/(r+s+W)', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createPreSliceDatabaseWithMassColumns,
    });

    const nodeColumns = db.readTableColumns('nodes');
    for (const removedMassColumnName of removedNodeMassColumnNames) {
      expect(
        findColumn(nodeColumns, removedMassColumnName),
        `nodes.${removedMassColumnName} must be dropped from a legacy database`
      ).toBeUndefined();
    }
    const uncertaintyColumn = findColumn(nodeColumns, 'belief_uncertainty');
    expect(uncertaintyColumn, 'nodes.belief_uncertainty must be added to a legacy database').toBeDefined();
    expect(uncertaintyColumn?.type.toUpperCase()).toBe('REAL');
    expect(uncertaintyColumn?.notnull).toBe(0);

    // Node 1 (r=0.72, s=0): backfilled to 2/2.72 = 0.7352941176470588...
    const gradedRow = readStoredDisplayBeliefRow(db, 1);
    expect(gradedRow.belief_uncertainty).not.toBeNull();
    expect(gradedRow.belief_uncertainty).toBeCloseTo(GRADED_LEGACY_EXPECTED_UNCERTAINTY, 12);
    // The credence beside it survives the migration untouched.
    expect(gradedRow.belief_credence).toBeCloseTo(GRADED_LEGACY_CREDENCE, 12);

    // Node 2 (r=3, s=1): backfilled to 2/6 = 0.3333333333333333...
    const conflictedRow = readStoredDisplayBeliefRow(db, 2);
    expect(conflictedRow.belief_uncertainty).not.toBeNull();
    expect(conflictedRow.belief_uncertainty).toBeCloseTo(CONFLICTED_LEGACY_EXPECTED_UNCERTAINTY, 12);
    expect(conflictedRow.belief_credence).toBeCloseTo(CONFLICTED_LEGACY_CREDENCE, 12);

    // Node 3 (masses NULL, never assessed): stays NULL — never a number.
    const neverAssessedRow = readStoredDisplayBeliefRow(db, 3);
    expect(neverAssessedRow.belief_uncertainty).toBeNull();
    expect(neverAssessedRow.belief_credence).toBeNull();

    // Node 4 (fixed, masses NULL): the STORED column stays NULL — the read
    // surface's fixed-node 0 is the mapper's rule, never a stored value.
    const fixedRow = readStoredDisplayBeliefRow(db, 4);
    expect(fixedRow.belief_uncertainty).toBeNull();
    expect(fixedRow.belief_credence_is_fixed).toBe(1);
    expect(fixedRow.belief_credence).toBeCloseTo(FIXED_LEGACY_CREDENCE, 12);
  });

  // Idempotence: the migration rerun over its own output must find nothing to
  // do — same columns, and the backfilled figures unchanged (a second
  // backfill pass would have no masses left to derive from, so any change
  // here means the migration is not guarded).
  it('legacy migration is idempotent: a reopen changes neither columns nor backfilled values', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createPreSliceDatabaseWithMassColumns,
    });

    // The backfilled figures as the first migration pass left them.
    const gradedUncertaintyAfterFirstOpen = readStoredDisplayBeliefRow(db, 1).belief_uncertainty;

    await db.reopenBeliefDatabase();

    const nodeColumnsAfterReopen = db.readTableColumns('nodes');
    for (const removedMassColumnName of removedNodeMassColumnNames) {
      expect(findColumn(nodeColumnsAfterReopen, removedMassColumnName)).toBeUndefined();
    }
    // Exactly one belief_uncertainty column — never a duplicate.
    expect(
      nodeColumnsAfterReopen.filter(column => column.name === 'belief_uncertainty')
    ).toHaveLength(1);

    // The stored figures are byte-identical to the first pass.
    expect(readStoredDisplayBeliefRow(db, 1).belief_uncertainty).toBe(gradedUncertaintyAfterFirstOpen);
    expect(readStoredDisplayBeliefRow(db, 3).belief_uncertainty).toBeNull();
    expect(readStoredDisplayBeliefRow(db, 4).belief_uncertainty).toBeNull();
  });

  // The nodes migration must not cost the database its graph-event journal
  // triggers or the direction-slot uniqueness index — the structures the
  // journal and the no-parallel-edges rule stand on. The mass-drop assertion
  // comes first so this guard is tied to the migration actually having run:
  // the survival claim is only meaningful over the migration's own output.
  it('legacy migration leaves the graph-events triggers and the direction-slot index in place', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createPreSliceDatabaseWithMassColumns,
    });

    // The migration ran: the masses are gone from this database.
    const nodeColumnNamesAfterMigration = db.readTableColumns('nodes').map(column => column.name);
    for (const removedMassColumnName of removedNodeMassColumnNames) {
      expect(nodeColumnNamesAfterMigration).not.toContain(removedMassColumnName);
    }

    // Every trigger and index name present after client init.
    const survivingTriggerAndIndexNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'index')")
        .all() as Array<{ name: string }>
    ).map(row => row.name);

    expect(survivingTriggerAndIndexNames).toContain('trg_graph_events_edge_delete');
    expect(survivingTriggerAndIndexNames).toContain('trg_graph_events_node_delete');
    expect(survivingTriggerAndIndexNames).toContain('trg_graph_events_edge_reorient');
    expect(survivingTriggerAndIndexNames).toContain('idx_edges_direction_slot');

    // The seeded edge row survives beside them.
    const survivingEdgeRows = db.sqlite
      .prepare('SELECT from_node_id, to_node_id FROM edges ORDER BY id ASC')
      .all() as Array<{ from_node_id: number; to_node_id: number }>;
    expect(survivingEdgeRows).toEqual([{ from_node_id: 1, to_node_id: 2 }]);
  });
});
