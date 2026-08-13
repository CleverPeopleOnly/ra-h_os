/**
 * Schema tests for the belief engine (MR-A).
 *
 * Pins that SQLite client bootstrap gives a database:
 *  - nodes.belief_credence / nodes.belief_computed_at — credence is the one
 *    word for the belief system's central quantity, so the column that holds
 *    it says credence and the old nodes.belief_value name is gone from fresh
 *    databases and renamed away on existing ones
 *  - belief_movements.from_credence / to_credence — the movement log records
 *    the SAME quantity before and after a recompute, so it uses the same word
 *    (the old from_value / to_value names are renamed, never re-created)
 *  - edges.belief_evidence_support / belief_evidence_contribution — support
 *    is the ONE UNSIGNED number (0..1) saying how loudly the source speaks
 *    about the derived node (canon direction, spec §8: the edge runs
 *    Derivative→Source, so the source is the edge's TARGET; NULL means the
 *    edge is not evidence at all; the SIGN of a contribution comes from the
 *    source node's credence). It
 *    replaces the old belief_evidence_direction + belief_evidence_strength
 *    pair, which could disagree: an edge could carry a strength with no
 *    direction, storable but impossible to grade. MIGRATION DECISION =
 *    MAGNITUDE: a legacy 'against'/'contradicts' row keeps its strength as
 *    support = |old value| — the relatedness strength survives, the
 *    direction reading is discarded, the edge stays evidence
 *  - and NO belief_evidence_origin_key: that column existed only to feed the
 *    deleted POLICY-V1 collapse-by-origin step, nothing reads it now, so it
 *    is removed from fresh databases and dropped (never renamed forward)
 *    from every database that still has it under any of its historical names
 *  - nodes.belief_credence_is_fixed INTEGER NOT NULL DEFAULT 0 — a node with
 *    this set has its credence ASSERTED by a human rather than derived from
 *    the graph, which is the bootstrap a derived-only graph needs before
 *    anything in it can be graded
 *  - the belief_movements table
 *  - and NO belief_source_trust table: a source is just a node and its
 *    influence IS its own nodes.belief_credence, so the separate trust table
 *    is dropped from every database that still has it and is never created
 * on BOTH a fresh database and a pre-existing legacy database file created
 * without those columns (the ensure-column migration path).
 *
 * Every database in this file is a fresh temp file under the OS tmpdir —
 * see tempBeliefDatabase.ts for the safety seam.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
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

// Every name the removed evidence-origin-key column has ever shipped under.
// After this MR none of them may survive on edges: the current name is
// dropped and neither legacy name is renamed forward into it.
// NOTE: trust_origin_key (on belief_source_trust) is a DIFFERENT concept —
// it names who is trusted and is deliberately absent from this list.
const removedEvidenceOriginKeyColumnNames = [
  'belief_evidence_origin_key',
  'evidence_origin_key',
  'evidence_independence_key',
] as const;

// The evidence columns edges carries after the direction+strength merge:
// one unsigned support field and the grading stamp. Used by the data
// preservation assertions below.
const survivingEdgeEvidenceColumnNames = [
  'belief_evidence_support',
  'belief_evidence_contribution',
] as const;

// The two columns the unsigned support field replaces. Neither may survive on
// any database, fresh or migrated: while both existed the schema allowed an
// edge whose strength and direction disagreed (or whose direction was
// missing entirely), which is exactly the invalid state the merge removes.
const mergedAwayEdgeEvidenceColumnNames = [
  'belief_evidence_direction',
  'belief_evidence_strength',
] as const;

// Lay down a legacy database file with today's pre-belief nodes/edges shape,
// so client init must ADD the new columns rather than create fresh tables.
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

// Lay down a database from the brief MR-A vocabulary era: evidence columns
// exist as evidence_relation (supports/contradicts values) and
// evidence_independence_key, and source_trust is keyed by origin_key — so
// client init must RENAME evidence_relation (MAPPING its stored values),
// RENAME the trust key, and DROP evidence_independence_key outright. The two
// edges come from DISTINCT source nodes: the direction-slot UNIQUE index
// outlaws same-slot parallels, and the dedup migration would otherwise eat
// the second fixture row before these tests could see it.
function createDatabaseWithMrAVocabulary(dbPath: string): void {
  createLegacyDatabaseWithoutBeliefColumns(dbPath);
  const oldVocabularyDb = new Database(dbPath);
  oldVocabularyDb.exec(`
    ALTER TABLE edges ADD COLUMN evidence_relation TEXT;
    ALTER TABLE edges ADD COLUMN evidence_strength REAL;
    ALTER TABLE edges ADD COLUMN evidence_independence_key TEXT;
    ALTER TABLE edges ADD COLUMN evidence_effective_contribution REAL;
    CREATE TABLE source_trust (
      origin_key TEXT PRIMARY KEY,
      score REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO nodes (id, title) VALUES (1, 'claim'), (2, 'source'), (3, 'second source');
    INSERT INTO edges (from_node_id, to_node_id, source, explanation, evidence_relation, evidence_strength, evidence_independence_key)
    VALUES (2, 1, 'user', 'old-vocabulary supporting edge', 'supports', 0.7, 'origin-a'),
           (3, 1, 'user', 'old-vocabulary contradicting edge', 'contradicts', 0.4, 'origin-b');
    INSERT INTO source_trust (origin_key, score, updated_at)
    VALUES ('marelie', 0.9, '2026-07-22T00:00:00.000Z');
  `);
  oldVocabularyDb.close();
}

// Lay down a database from the brief unprefixed-vocabulary era (fork PR #3):
// evidence columns exist without the belief_ prefix and the trust table is
// source_trust keyed by trust_origin_key — so client init must RENAME the
// three surviving columns, DROP evidence_origin_key, and move the trust rows
// into belief_source_trust.
function createDatabaseWithUnprefixedVocabulary(dbPath: string): void {
  createLegacyDatabaseWithoutBeliefColumns(dbPath);
  const unprefixedDb = new Database(dbPath);
  unprefixedDb.exec(`
    ALTER TABLE edges ADD COLUMN evidence_direction TEXT;
    ALTER TABLE edges ADD COLUMN evidence_strength REAL;
    ALTER TABLE edges ADD COLUMN evidence_origin_key TEXT;
    ALTER TABLE edges ADD COLUMN evidence_effective_contribution REAL;
    CREATE TABLE source_trust (
      trust_origin_key TEXT PRIMARY KEY,
      score REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO nodes (id, title) VALUES (1, 'claim'), (2, 'source');
    INSERT INTO edges (from_node_id, to_node_id, source, explanation, evidence_direction, evidence_strength, evidence_origin_key, evidence_effective_contribution)
    VALUES (2, 1, 'user', 'unprefixed-era supporting edge', 'for', 0.7, 'origin-a', 0.21);
    INSERT INTO source_trust (trust_origin_key, score, updated_at)
    VALUES ('marelie', 0.9, '2026-07-26T00:00:00.000Z');
  `);
  unprefixedDb.close();
}

// Lay down a database from TODAY's shipped shape: the full belief schema
// including belief_evidence_origin_key, with edge rows that hold real origin
// keys, a NULL origin key, and populated direction/strength/contribution
// values — so the drop migration has real data to preserve. Each edge comes
// from its OWN source node (the direction-slot UNIQUE index outlaws same-slot
// parallels; the dedup migration would eat stacked fixture rows).
//
// It also creates idx_edges_from / idx_edges_to explicitly. The base helper
// (createLegacyDatabaseWithoutBeliefColumns) declares the two edges->nodes
// foreign keys with ON DELETE CASCADE but creates NO indexes, so without
// this addition the index-survival assertions below would prove nothing.
function createDatabaseCarryingBeliefEvidenceOriginKey(dbPath: string): void {
  createLegacyDatabaseWithoutBeliefColumns(dbPath);
  const shippedOriginKeyDb = new Database(dbPath);
  shippedOriginKeyDb.exec(`
    ALTER TABLE nodes ADD COLUMN belief_value REAL;
    ALTER TABLE nodes ADD COLUMN belief_computed_at TEXT;
    ALTER TABLE edges ADD COLUMN belief_evidence_direction TEXT;
    ALTER TABLE edges ADD COLUMN belief_evidence_strength REAL;
    ALTER TABLE edges ADD COLUMN belief_evidence_origin_key TEXT;
    ALTER TABLE edges ADD COLUMN belief_evidence_contribution REAL;
    CREATE TABLE belief_source_trust (
      trust_origin_key TEXT PRIMARY KEY,
      score REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO nodes (id, title, belief_value, belief_computed_at)
    VALUES (1, 'claim', 0.31, '2026-07-27T00:00:00.000Z'),
           (2, 'source', NULL, NULL),
           (3, 'second source', NULL, NULL),
           (4, 'third source', NULL, NULL);
    INSERT INTO edges (id, from_node_id, to_node_id, source, explanation,
                       belief_evidence_direction, belief_evidence_strength,
                       belief_evidence_origin_key, belief_evidence_contribution)
    VALUES (1, 2, 1, 'user', 'keyed supporting edge', 'for', 0.7, 'origin-a', 0.63),
           (2, 3, 1, 'user', 'keyed contradicting edge', 'against', 0.4, 'origin-b', -0.36),
           (3, 4, 1, 'user', 'edge whose origin key was never set', 'for', 0.5, NULL, NULL);
    INSERT INTO belief_source_trust (trust_origin_key, score, updated_at)
    VALUES ('marelie', 0.9, '2026-07-27T00:00:00.000Z');
    CREATE INDEX idx_edges_from ON edges(from_node_id);
    CREATE INDEX idx_edges_to ON edges(to_node_id);
  `);
  shippedOriginKeyDb.close();
}

// Lay down a database in the shape shipped BEFORE the credence rename: the
// graded quantity is nodes.belief_value and the movement log records it as
// from_value / to_value. It carries real data for the rename to preserve —
// a graded node, an UNGRADED (NULL) node, an evidence edge, and two movement
// rows one of which has a NULL from_value.
//
// It also creates idx_edges_from / idx_edges_to / idx_nodes_updated_at
// explicitly (the base helper creates no indexes), so the rebuild guard below
// has something real to lose. ensureCoreSchema creates those same three
// indexes before the belief migration runs, so a copy-into-a-new-table
// rebuild inside the migration would destroy them with nothing to recreate
// them — which is exactly what the guard test catches.
function createDatabaseNamingCredenceAsBeliefValue(dbPath: string): void {
  createLegacyDatabaseWithoutBeliefColumns(dbPath);
  const oldQuantityNameDb = new Database(dbPath);
  oldQuantityNameDb.exec(`
    ALTER TABLE nodes ADD COLUMN belief_value REAL;
    ALTER TABLE nodes ADD COLUMN belief_computed_at TEXT;
    ALTER TABLE edges ADD COLUMN belief_evidence_direction TEXT;
    ALTER TABLE edges ADD COLUMN belief_evidence_strength REAL;
    ALTER TABLE edges ADD COLUMN belief_evidence_contribution REAL;
    CREATE TABLE belief_source_trust (
      trust_origin_key TEXT PRIMARY KEY,
      score REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE belief_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      from_value REAL,
      to_value REAL NOT NULL,
      "trigger" TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    INSERT INTO nodes (id, title, belief_value, belief_computed_at)
    VALUES (1, 'graded claim', -0.42, '2026-07-27T00:00:00.000Z'),
           (2, 'ungraded claim', NULL, NULL),
           (3, 'evidence source', 0.75, '2026-07-27T01:00:00.000Z');
    INSERT INTO edges (id, from_node_id, to_node_id, source, explanation,
                       belief_evidence_direction, belief_evidence_strength,
                       belief_evidence_contribution)
    VALUES (1, 3, 1, 'user', 'supporting evidence edge', 'for', 0.7, 0.63);
    INSERT INTO belief_movements (id, node_id, from_value, to_value, "trigger", occurred_at)
    VALUES (1, 1, NULL, 0.31, 'belief-recompute', '2026-07-26T00:00:00.000Z'),
           (2, 1, 0.31, -0.42, 'belief-recompute', '2026-07-27T00:00:00.000Z');
    CREATE INDEX idx_edges_from ON edges(from_node_id);
    CREATE INDEX idx_edges_to ON edges(to_node_id);
    CREATE INDEX idx_nodes_updated_at ON nodes(updated_at DESC);
  `);
  oldQuantityNameDb.close();
}

// Lay down the half-migrated shape the standalone MCP server can leave
// behind: a pre-rename app database (populated nodes.belief_value) that
// standalone init-db has since touched, adding an EMPTY nodes.belief_credence
// beside it. The standalone path only ever ADDs missing columns — it has no
// rename step — so both names end up on nodes at once, and the movement log
// it never touches still carries from_value / to_value.
//
// There is no production data to protect (the fork is still in development),
// so the specified fix is deliberately simple: the orphan belief_value column
// is DROPPED outright. Nothing is copied out of it first.
function createDatabaseCarryingBothBeliefValueAndBeliefCredence(dbPath: string): void {
  createDatabaseNamingCredenceAsBeliefValue(dbPath);
  const bothQuantityNamesDb = new Database(dbPath);
  // Exactly what standalone init-db's ensure-column loop would have done:
  // add the credence column, leave the old one and its rows alone.
  bothQuantityNamesDb.exec('ALTER TABLE nodes ADD COLUMN belief_credence REAL;');
  bothQuantityNamesDb.close();
}

// Lay down a database in TODAY's shipped shape, the one the support merge
// has to migrate: the graded quantity is already nodes.belief_credence and
// the evidence fields are still the separate belief_evidence_direction +
// belief_evidence_strength pair, with belief_evidence_contribution stamps
// beside them.
//
// The edge rows deliberately cover every case the merge must get right
// (MIGRATION DECISION = MAGNITUDE: direction is discarded, strength kept):
//  1. 'for' + 0.7, stamped 0.63          -> support 0.7, stamp preserved
//  2. 'against' + 0.4, stamped -0.36     -> support 0.4 (magnitude), stamp
//                                           preserved as data
//  3. 'for' + 0.5, never stamped (NULL)  -> support 0.5, stamp still NULL
//  4. NULL direction + NULL strength     -> support NULL (a plain edge)
//  5. NULL direction + strength 0.9      -> support NULL: the storable-but-
//     ungradeable state the two-column shape allowed. Recompute selected on
//     "direction IS NOT NULL", so this row was never evidence; the merge must
//     not resurrect it as evidence off the orphan magnitude alone.
//
// It also creates idx_nodes_updated_at / idx_edges_from / idx_edges_to
// explicitly (the base helper creates none), so the rebuild guard below has
// something real to lose: ensureCoreSchema creates those same three indexes
// BEFORE the belief migration runs, so a copy-into-a-new-table rebuild inside
// the migration would destroy them with nothing left to recreate them.
function createDatabaseSplittingSupportIntoDirectionAndStrength(dbPath: string): void {
  createLegacyDatabaseWithoutBeliefColumns(dbPath);
  const splitEvidenceFieldsDb = new Database(dbPath);
  splitEvidenceFieldsDb.exec(`
    ALTER TABLE nodes ADD COLUMN belief_credence REAL;
    ALTER TABLE nodes ADD COLUMN belief_computed_at TEXT;
    ALTER TABLE edges ADD COLUMN belief_evidence_direction TEXT;
    ALTER TABLE edges ADD COLUMN belief_evidence_strength REAL;
    ALTER TABLE edges ADD COLUMN belief_evidence_contribution REAL;
    CREATE TABLE belief_source_trust (
      trust_origin_key TEXT PRIMARY KEY,
      score REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE belief_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      from_credence REAL,
      to_credence REAL NOT NULL,
      "trigger" TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    INSERT INTO nodes (id, title, belief_credence, belief_computed_at)
    VALUES (1, 'graded claim', 0.31, '2026-07-27T00:00:00.000Z'),
           (2, 'ungraded claim', NULL, NULL),
           (3, 'evidence source', 0.75, '2026-07-27T01:00:00.000Z'),
           (4, 'second evidence source', NULL, NULL),
           (5, 'third evidence source', NULL, NULL),
           (6, 'fourth evidence source', NULL, NULL),
           (7, 'fifth evidence source', NULL, NULL);
    INSERT INTO edges (id, from_node_id, to_node_id, source, explanation,
                       belief_evidence_direction, belief_evidence_strength,
                       belief_evidence_contribution)
    VALUES (1, 3, 1, 'user', 'supporting evidence edge', 'for', 0.7, 0.63),
           (2, 4, 1, 'user', 'contradicting evidence edge', 'against', 0.4, -0.36),
           (3, 5, 1, 'user', 'supporting evidence edge never graded', 'for', 0.5, NULL),
           (4, 6, 1, 'user', 'plain non-evidence edge', NULL, NULL, NULL),
           (5, 7, 1, 'user', 'orphan strength with no direction', NULL, 0.9, NULL);
    INSERT INTO belief_movements (id, node_id, from_credence, to_credence, "trigger", occurred_at)
    VALUES (1, 1, NULL, 0.31, 'belief-recompute', '2026-07-27T00:00:00.000Z');
    CREATE INDEX idx_edges_from ON edges(from_node_id);
    CREATE INDEX idx_edges_to ON edges(to_node_id);
    CREATE INDEX idx_nodes_updated_at ON nodes(updated_at DESC);
  `);
  splitEvidenceFieldsDb.close();
}

// Lay down a database in TODAY's shipped shape carrying the belief_source_trust
// table WITH ROWS in it, which is the state every existing development
// database is in. The sources-as-nodes migration must drop that table
// regardless of what it holds — a source's influence is now its own
// nodes.belief_credence, so nothing reads those rows any more.
//
// It also creates idx_nodes_updated_at / idx_edges_from / idx_edges_to
// explicitly (the base helper creates none), so the rebuild guard below has
// something real to lose.
function createDatabaseCarryingBeliefSourceTrustRows(dbPath: string): void {
  createLegacyDatabaseWithoutBeliefColumns(dbPath);
  const populatedSourceTrustDb = new Database(dbPath);
  populatedSourceTrustDb.exec(`
    ALTER TABLE nodes ADD COLUMN belief_credence REAL;
    ALTER TABLE nodes ADD COLUMN belief_computed_at TEXT;
    ALTER TABLE edges ADD COLUMN belief_evidence_support REAL;
    ALTER TABLE edges ADD COLUMN belief_evidence_contribution REAL;
    CREATE TABLE belief_source_trust (
      trust_origin_key TEXT PRIMARY KEY,
      score REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE belief_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      from_credence REAL,
      to_credence REAL NOT NULL,
      "trigger" TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    INSERT INTO nodes (id, title, metadata, belief_credence, belief_computed_at)
    VALUES (1, 'graded claim', NULL, 0.31, '2026-07-27T00:00:00.000Z'),
           (2, 'evidence source', '{"trustOriginKey":"marelie"}', NULL, NULL);
    INSERT INTO edges (id, from_node_id, to_node_id, source, explanation,
                       belief_evidence_support, belief_evidence_contribution)
    VALUES (1, 2, 1, 'user', 'supporting evidence edge', 0.7, 0.63);
    INSERT INTO belief_source_trust (trust_origin_key, score, updated_at)
    VALUES ('marelie', 0.9, '2026-07-27T00:00:00.000Z'),
           ('agent:alpha', 0.4, '2026-07-27T00:00:00.000Z');
    CREATE INDEX idx_edges_from ON edges(from_node_id);
    CREATE INDEX idx_edges_to ON edges(to_node_id);
    CREATE INDEX idx_nodes_updated_at ON nodes(updated_at DESC);
  `);
  populatedSourceTrustDb.close();
}

// Lay down a database that is HALF-WAY through the sources-as-nodes
// migration, which is what a database touched by the standalone path first
// looks like: nodes already carries belief_credence_is_fixed with a fixed node
// in it, but the trust table is still there. The migration must add nothing on
// the column side (an unconditional ALTER TABLE ADD COLUMN would fail), must
// not clear the fixed flag, and must still drop the table.
function createDatabaseAlreadyCarryingBeliefCredenceIsFixed(dbPath: string): void {
  createLegacyDatabaseWithoutBeliefColumns(dbPath);
  const alreadyMigratedDb = new Database(dbPath);
  alreadyMigratedDb.exec(`
    ALTER TABLE nodes ADD COLUMN belief_credence REAL;
    ALTER TABLE nodes ADD COLUMN belief_computed_at TEXT;
    ALTER TABLE nodes ADD COLUMN belief_credence_is_fixed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE edges ADD COLUMN belief_evidence_support REAL;
    ALTER TABLE edges ADD COLUMN belief_evidence_contribution REAL;
    CREATE TABLE belief_source_trust (
      trust_origin_key TEXT PRIMARY KEY,
      score REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO belief_source_trust (trust_origin_key, score, updated_at)
    VALUES ('marelie', 0.9, '2026-07-27T00:00:00.000Z');
    CREATE TABLE belief_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      from_credence REAL,
      to_credence REAL NOT NULL,
      "trigger" TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    INSERT INTO nodes (id, title, belief_credence, belief_computed_at, belief_credence_is_fixed)
    VALUES (1, 'the fixed human expert', 0.9, '2026-07-27T00:00:00.000Z', 1),
           (2, 'an ordinary derived claim', 0.31, '2026-07-27T00:00:00.000Z', 0);
    CREATE INDEX idx_edges_from ON edges(from_node_id);
    CREATE INDEX idx_edges_to ON edges(to_node_id);
    CREATE INDEX idx_nodes_updated_at ON nodes(updated_at DESC);
  `);
  alreadyMigratedDb.close();
}

// One row of "PRAGMA foreign_key_list(edges)" as read by the survival test:
// which local column references which column of which table, and what the
// declared ON DELETE action is.
interface EdgeForeignKeyDeclaration {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

describe('belief engine schema', () => {
  // Guard test demanded by the safety rule: if the client under test ever
  // resolves its database file to anywhere outside the OS temp directory,
  // this fails and the whole belief suite is untrustworthy.
  it('GUARD: the SQLite client under test has its database file inside the OS temp directory', async () => {
    db = await openTempBeliefDatabase();
    const attachedDatabases = db.sqlite.prepare('PRAGMA database_list').all() as Array<{
      name: string;
      file: string;
    }>;
    const mainDatabaseFile = attachedDatabases.find(row => row.name === 'main')?.file;
    expect(mainDatabaseFile).toBeTruthy();
    // realpath both sides: macOS tmpdir is a /var -> /private/var symlink.
    const realTmpRoot = fs.realpathSync(os.tmpdir());
    const realMainFile = fs.realpathSync(String(mainDatabaseFile));
    expect(
      realMainFile === realTmpRoot || realMainFile.startsWith(realTmpRoot + path.sep)
    ).toBe(true);
  });

  // EDITED from the belief_value case: the graded quantity is credence, so a
  // fresh database must carry nodes.belief_credence and must NOT carry the
  // old nodes.belief_value name at all.
  it('fresh database: nodes has belief_credence REAL, belief_computed_at TEXT, and no belief_value', async () => {
    db = await openTempBeliefDatabase();
    const nodeColumns = db.readTableColumns('nodes');
    const beliefCredenceColumn = findColumn(nodeColumns, 'belief_credence');
    const beliefComputedAtColumn = findColumn(nodeColumns, 'belief_computed_at');
    expect(beliefCredenceColumn).toBeDefined();
    expect(beliefCredenceColumn?.type.toUpperCase()).toBe('REAL');
    expect(beliefComputedAtColumn).toBeDefined();
    expect(beliefComputedAtColumn?.type.toUpperCase()).toBe('TEXT');
    expect(
      nodeColumns.map(column => column.name),
      'the old nodes.belief_value name must not exist on a fresh database'
    ).not.toContain('belief_value');
  });

  // EDITED from the three-column case: direction and strength are merged into
  // one signed REAL support column, so a fresh database carries exactly two
  // evidence columns — support (the assertion) and contribution (the grading
  // stamp, whose type is unchanged by this merge).
  it('fresh database: edges has belief_evidence_support REAL and belief_evidence_contribution REAL', async () => {
    db = await openTempBeliefDatabase();
    const edgeColumns = db.readTableColumns('edges');
    const expectedEvidenceColumnTypes: Record<string, string> = {
      belief_evidence_support: 'REAL',
      belief_evidence_contribution: 'REAL',
    };
    for (const [columnName, expectedType] of Object.entries(expectedEvidenceColumnTypes)) {
      const column = findColumn(edgeColumns, columnName);
      expect(column, `edges.${columnName} should exist`).toBeDefined();
      expect(column?.type.toUpperCase(), `edges.${columnName} type`).toBe(expectedType);
    }
  });

  // The merge itself on a fresh database: neither half of the old pair may be
  // created any more. Keeping either alongside support would re-open the
  // disagreement the single signed field exists to prevent.
  it('fresh database: edges has neither belief_evidence_direction nor belief_evidence_strength', async () => {
    db = await openTempBeliefDatabase();
    const edgeColumnNames = db.readTableColumns('edges').map(column => column.name);
    for (const mergedAwayColumnName of mergedAwayEdgeEvidenceColumnNames) {
      expect(
        edgeColumnNames,
        `edges.${mergedAwayColumnName} must not exist on a fresh database`
      ).not.toContain(mergedAwayColumnName);
    }
  });

  // The removal itself: a freshly created database must have no origin-key
  // column on edges under ANY of its historical names — nothing reads it
  // since the POLICY-V1 collapse was deleted.
  it('fresh database: edges has no belief_evidence_origin_key column under any historical name', async () => {
    db = await openTempBeliefDatabase();
    const edgeColumnNames = db.readTableColumns('edges').map(column => column.name);
    for (const removedOriginKeyColumnName of removedEvidenceOriginKeyColumnNames) {
      expect(
        edgeColumnNames,
        `edges.${removedOriginKeyColumnName} must not exist on a fresh database`
      ).not.toContain(removedOriginKeyColumnName);
    }
  });

  // REPLACES the "belief_source_trust exists" case. A source is just a node
  // and its influence over the evidence it supplies IS its own
  // nodes.belief_credence, so there is nothing left for a separate trust
  // table to hold and a fresh database must not create one.
  it('fresh database: no belief_source_trust table is created', async () => {
    db = await openTempBeliefDatabase();
    expect(
      db.hasTable('belief_source_trust'),
      'a source node carries its own credence — no separate trust table exists'
    ).toBe(false);
  });

  // The fixed-credence flag on a fresh database. INTEGER NOT NULL DEFAULT 0
  // is what makes "ordinary" the state every node is in without any write:
  // only a deliberate write marks a node's credence as human-asserted.
  it('fresh database: nodes has belief_credence_is_fixed INTEGER NOT NULL DEFAULT 0', async () => {
    db = await openTempBeliefDatabase();
    const beliefCredenceIsFixedColumn = findColumn(
      db.readTableColumns('nodes'),
      'belief_credence_is_fixed'
    );
    expect(beliefCredenceIsFixedColumn, 'nodes.belief_credence_is_fixed should exist').toBeDefined();
    expect(beliefCredenceIsFixedColumn?.type.toUpperCase()).toBe('INTEGER');
    expect(beliefCredenceIsFixedColumn?.notnull, 'the flag is NOT NULL').toBe(1);
    expect(String(beliefCredenceIsFixedColumn?.dflt_value), 'the flag defaults to 0').toBe('0');

    // And the default really applies: a node inserted without mentioning the
    // flag comes back as an ordinary, derived node.
    const insertedNodeId = db.insertNodeFixture({ title: 'node inserted without the flag' });
    expect(db.readNodeBeliefCredenceIsFixed(insertedNodeId)).toBe(0);
  });

  // EDITED from the from_value / to_value case: a movement records the node's
  // credence before and after the recompute, which is the same quantity as
  // nodes.belief_credence, so both columns say credence and neither old name
  // may survive on a fresh database.
  it('fresh database: belief_movements table exists with from_credence / to_credence and no from_value / to_value', async () => {
    db = await openTempBeliefDatabase();
    const movementColumns = db.readTableColumns('belief_movements');
    expect(movementColumns.length, 'belief_movements table should exist').toBeGreaterThan(0);
    expect(findColumn(movementColumns, 'id')?.pk, 'id is the primary key').toBe(1);
    expect(findColumn(movementColumns, 'node_id')?.notnull, 'node_id is NOT NULL').toBe(1);
    expect(
      findColumn(movementColumns, 'from_credence'),
      'from_credence exists (nullable)'
    ).toBeDefined();
    expect(findColumn(movementColumns, 'from_credence')?.type.toUpperCase()).toBe('REAL');
    expect(findColumn(movementColumns, 'to_credence')?.notnull, 'to_credence is NOT NULL').toBe(1);
    expect(findColumn(movementColumns, 'to_credence')?.type.toUpperCase()).toBe('REAL');
    expect(findColumn(movementColumns, 'trigger')?.notnull, 'trigger is NOT NULL').toBe(1);
    expect(findColumn(movementColumns, 'occurred_at')?.notnull, 'occurred_at is NOT NULL').toBe(1);
    const movementColumnNames = movementColumns.map(column => column.name);
    expect(movementColumnNames, 'the old from_value name must be gone').not.toContain('from_value');
    expect(movementColumnNames, 'the old to_value name must be gone').not.toContain('to_value');
  });

  it('legacy database file without belief columns gains the nodes and edges columns after client init', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createLegacyDatabaseWithoutBeliefColumns,
    });
    const nodeColumnNames = db.readTableColumns('nodes').map(column => column.name);
    const edgeColumnNames = db.readTableColumns('edges').map(column => column.name);
    // EDITED from belief_value: a database that never had the quantity at all
    // gains it under its one correct name, never under the old one.
    expect(nodeColumnNames).toContain('belief_credence');
    expect(nodeColumnNames).not.toContain('belief_value');
    expect(nodeColumnNames).toContain('belief_computed_at');
    // EDITED from the direction/strength pair: a database that never had any
    // evidence fields gains the single unsigned support column, never the pair.
    expect(edgeColumnNames).toContain('belief_evidence_support');
    expect(edgeColumnNames).toContain('belief_evidence_contribution');
    for (const mergedAwayColumnName of mergedAwayEdgeEvidenceColumnNames) {
      expect(edgeColumnNames, `edges.${mergedAwayColumnName} must never be added`).not.toContain(
        mergedAwayColumnName
      );
    }
    // Edited from the old four-column expectation: the removed origin key
    // must never be added back to a database that does not have it.
    expect(edgeColumnNames).not.toContain('belief_evidence_origin_key');
    // A database that never had the fixed-credence flag gains it, and its
    // existing rows land on the default: derived, not asserted.
    expect(nodeColumnNames).toContain('belief_credence_is_fixed');
    // No trust table is created for a database that never had one.
    expect(db.hasTable('belief_source_trust')).toBe(false);
  });

  // ALTER TABLE ADD COLUMN with a NOT NULL DEFAULT 0 backfills every existing
  // row, so a populated legacy database comes out with every node marked
  // ordinary (derived) rather than with a NULL nobody can interpret.
  it('legacy database rows all come out with belief_credence_is_fixed 0', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseNamingCredenceAsBeliefValue,
    });

    const backfilledFixedFlags = db.sqlite
      .prepare('SELECT id, belief_credence_is_fixed FROM nodes ORDER BY id ASC')
      .all() as Array<{ id: number; belief_credence_is_fixed: number }>;
    expect(backfilledFixedFlags).toHaveLength(3);
    for (const backfilledFixedFlag of backfilledFixedFlags) {
      expect(
        backfilledFixedFlag.belief_credence_is_fixed,
        `node ${backfilledFixedFlag.id} must default to derived, not asserted`
      ).toBe(0);
    }
  });

  // EDITED from the rename-to-direction case. The field shipped briefly as
  // evidence_relation with supports/contradicts values beside an
  // evidence_strength magnitude. Both land in ONE unsigned
  // belief_evidence_support as the MAGNITUDE: 'supports' and 'contradicts'
  // alike keep their strength, the direction reading is discarded (a
  // direction cannot be represented in unsigned support — direction now
  // lives on the source node's credence). No intermediate direction column
  // may survive.
  it('legacy evidence_relation and evidence_strength merge into unsigned magnitude belief_evidence_support', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseWithMrAVocabulary,
    });

    const edgeColumnNames = db.readTableColumns('edges').map(col => col.name);
    expect(edgeColumnNames).toContain('belief_evidence_support');
    expect(edgeColumnNames).not.toContain('evidence_relation');
    expect(edgeColumnNames).not.toContain('evidence_direction');
    for (const mergedAwayColumnName of mergedAwayEdgeEvidenceColumnNames) {
      expect(edgeColumnNames, `edges.${mergedAwayColumnName} must be gone`).not.toContain(
        mergedAwayColumnName
      );
    }

    // Fixture rows: ('supports', 0.7) and ('contradicts', 0.4) — both come
    // out as their magnitude under the unsigned range.
    const migratedSupports = db.sqlite
      .prepare('SELECT belief_evidence_support FROM edges ORDER BY id ASC')
      .all() as Array<{ belief_evidence_support: number }>;
    expect(migratedSupports).toHaveLength(2);
    expect(migratedSupports[0].belief_evidence_support).toBeCloseTo(0.7, 10);
    expect(migratedSupports[1].belief_evidence_support).toBeCloseTo(0.4, 10);
  });

  // EDITED from the old rename-forward case. The origin-artifact key shipped
  // briefly as evidence_independence_key and was previously renamed forward
  // into belief_evidence_origin_key. It is now removed outright, so client
  // init must DROP the legacy column rather than carry its values into a
  // surviving column — while the direction/strength data beside it survives.
  it('legacy evidence_independence_key column is dropped, not renamed forward, with neighbouring evidence data preserved', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseWithMrAVocabulary,
    });

    const edgeColumnNames = db.readTableColumns('edges').map(col => col.name);
    for (const removedOriginKeyColumnName of removedEvidenceOriginKeyColumnNames) {
      expect(
        edgeColumnNames,
        `edges.${removedOriginKeyColumnName} must be gone, not renamed forward`
      ).not.toContain(removedOriginKeyColumnName);
    }

    // EDITED from the direction/strength read-back: the neighbouring evidence
    // data survives the drop as one unsigned magnitude support per row.
    const migratedEvidenceRows = db.sqlite
      .prepare('SELECT belief_evidence_support FROM edges ORDER BY id ASC')
      .all() as Array<{ belief_evidence_support: number }>;
    expect(migratedEvidenceRows[0].belief_evidence_support).toBeCloseTo(0.7, 10);
    expect(migratedEvidenceRows[1].belief_evidence_support).toBeCloseTo(0.4, 10);
  });

  // The headline migration: a database carrying TODAY's shipped
  // belief_evidence_origin_key column (with real keys, a NULL key, and
  // populated direction/strength/contribution values) must come out of
  // client init with the column gone and every other column and row value
  // preserved intact — including the belief columns on nodes.
  it('a database carrying belief_evidence_origin_key loses that column and keeps all other row data intact', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseCarryingBeliefEvidenceOriginKey,
    });

    const edgeColumnNames = db.readTableColumns('edges').map(col => col.name);
    expect(edgeColumnNames).not.toContain('belief_evidence_origin_key');
    // Everything else on edges is untouched by the drop.
    for (const survivingColumnName of survivingEdgeEvidenceColumnNames) {
      expect(edgeColumnNames, `edges.${survivingColumnName} must survive`).toContain(
        survivingColumnName
      );
    }
    for (const upstreamColumnName of ['id', 'from_node_id', 'to_node_id', 'source', 'created_at', 'context', 'explanation']) {
      expect(edgeColumnNames, `edges.${upstreamColumnName} must survive`).toContain(upstreamColumnName);
    }

    // EDITED from the direction/strength read-back: all three rows survive
    // with their evidence merged into one unsigned support value, NULL key
    // row included. 'for' and 'against' alike keep the MAGNITUDE — the
    // direction reading is discarded, the strength survives. The stamped
    // contribution beside it is preserved data, not remapped.
    const preservedEdgeRows = db.sqlite
      .prepare(
        `SELECT id, from_node_id, to_node_id, explanation,
                belief_evidence_support, belief_evidence_contribution
         FROM edges ORDER BY id ASC`
      )
      .all() as Array<{
      id: number;
      from_node_id: number;
      to_node_id: number;
      explanation: string;
      belief_evidence_support: number | null;
      belief_evidence_contribution: number | null;
    }>;
    expect(preservedEdgeRows).toHaveLength(3);
    expect(preservedEdgeRows.map(row => row.id)).toEqual([1, 2, 3]);
    expect(Number(preservedEdgeRows[0].belief_evidence_support)).toBeCloseTo(0.7, 10);
    expect(preservedEdgeRows[0].belief_evidence_contribution).toBeCloseTo(0.63, 10);
    expect(Number(preservedEdgeRows[1].belief_evidence_support)).toBeCloseTo(0.4, 10);
    expect(preservedEdgeRows[1].belief_evidence_contribution).toBeCloseTo(-0.36, 10);
    // The row whose origin key was NULL survives exactly like the others.
    expect(preservedEdgeRows[2].explanation).toBe('edge whose origin key was never set');
    expect(Number(preservedEdgeRows[2].belief_evidence_support)).toBeCloseTo(0.5, 10);
    expect(preservedEdgeRows[2].belief_evidence_contribution).toBeNull();

    // The nodes belief columns are unaffected by the edges-side drop. EDITED
    // from belief_value: the fixture lays the quantity down under its old
    // name, so after client init it is readable as belief_credence with the
    // stored number carried across unchanged.
    const preservedGradedNode = db.sqlite
      .prepare('SELECT title, belief_credence, belief_computed_at FROM nodes WHERE id = 1')
      .get() as { title: string; belief_credence: number; belief_computed_at: string };
    expect(preservedGradedNode.title).toBe('claim');
    expect(preservedGradedNode.belief_credence).toBeCloseTo(0.31, 10);
    expect(preservedGradedNode.belief_computed_at).toBe('2026-07-27T00:00:00.000Z');
  });

  // Table-rebuild guard. Dropping a column can be implemented either as
  // ALTER TABLE ... DROP COLUMN or as a copy-into-a-new-table rebuild, and a
  // rebuild silently loses whatever it does not re-declare. The edges table's
  // lookup indexes and its cascade rules are exactly that kind of casualty:
  // losing idx_edges_from/idx_edges_to degrades every graph traversal, and
  // losing ON DELETE CASCADE orphans edges when a node is deleted. Both must
  // still be there after the origin key is dropped.
  it('dropping the evidence origin key leaves the edges indexes and ON DELETE CASCADE foreign keys intact', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseCarryingBeliefEvidenceOriginKey,
    });

    // Precondition: the drop this test guards actually happened.
    const edgeColumnNames = db.readTableColumns('edges').map(col => col.name);
    expect(edgeColumnNames).not.toContain('belief_evidence_origin_key');

    // Both traversal indexes survive.
    const survivingEdgeIndexNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'")
        .all() as Array<{ name: string }>
    ).map(indexRow => indexRow.name);
    expect(survivingEdgeIndexNames, 'idx_edges_from must survive the drop').toContain('idx_edges_from');
    expect(survivingEdgeIndexNames, 'idx_edges_to must survive the drop').toContain('idx_edges_to');

    // Both foreign keys to nodes(id) survive, still cascading on delete.
    const survivingForeignKeys = db.sqlite
      .prepare("PRAGMA foreign_key_list('edges')")
      .all() as EdgeForeignKeyDeclaration[];
    for (const referencingColumnName of ['from_node_id', 'to_node_id']) {
      const foreignKeyForColumn = survivingForeignKeys.find(
        declaration => declaration.from === referencingColumnName
      );
      expect(
        foreignKeyForColumn,
        `edges.${referencingColumnName} must still declare a foreign key`
      ).toBeDefined();
      expect(foreignKeyForColumn?.table).toBe('nodes');
      expect(foreignKeyForColumn?.to).toBe('id');
      expect(
        foreignKeyForColumn?.on_delete.toUpperCase(),
        `edges.${referencingColumnName} must still cascade on delete`
      ).toBe('CASCADE');
    }
  });

  // EDITED from "trust is out of scope of this removal": both removals now
  // land in the same migration, so a database carrying the origin key AND the
  // trust table comes out with neither.
  it('dropping the evidence origin key also drops belief_source_trust', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseCarryingBeliefEvidenceOriginKey,
    });

    expect(db.readTableColumns('edges').map(column => column.name)).not.toContain(
      'belief_evidence_origin_key'
    );
    expect(
      db.hasTable('belief_source_trust'),
      'the trust table is dropped, not left beside the source nodes that replaced it'
    ).toBe(false);
  });

  // EDITED from "legacy source_trust rows land in belief_source_trust". The
  // trust mechanism is deleted outright, so a database carrying the earliest
  // source_trust table must come out with NEITHER that table nor the
  // belief_source_trust it used to be renamed into — its rows are not carried
  // anywhere, because a source's influence is now its own node credence.
  it('legacy source_trust is dropped and no belief_source_trust replaces it', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseWithMrAVocabulary,
    });

    expect(db.hasTable('source_trust'), 'legacy source_trust table is dropped').toBe(false);
    expect(
      db.hasTable('belief_source_trust'),
      'its rows are not carried into a replacement table either'
    ).toBe(false);

    // The evidence data beside it still migrates (to magnitude support), so
    // this removal has not eaten anything else on the way past.
    const migratedSupports = db.sqlite
      .prepare('SELECT belief_evidence_support FROM edges ORDER BY id ASC')
      .all() as Array<{ belief_evidence_support: number }>;
    expect(migratedSupports).toHaveLength(2);
    expect(migratedSupports[0].belief_evidence_support).toBeCloseTo(0.7, 10);
    expect(migratedSupports[1].belief_evidence_support).toBeCloseTo(0.4, 10);
  });

  // EDITED from the old four-column rename case: the three surviving evidence
  // columns still gain the belief_ prefix with values preserved, but
  // evidence_origin_key is now DROPPED instead of renamed to
  // belief_evidence_origin_key, and the trust table is dropped rather than
  // having its rows moved anywhere.
  it('unprefixed evidence columns gain the belief_ prefix, the origin key is dropped, and no trust table survives', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseWithUnprefixedVocabulary,
    });

    const edgeColumnNames = db.readTableColumns('edges').map(col => col.name);
    for (const oldName of ['evidence_direction', 'evidence_strength', 'evidence_origin_key', 'evidence_effective_contribution']) {
      expect(edgeColumnNames, `edges.${oldName} should be gone`).not.toContain(oldName);
    }
    // The dropped key is not renamed forward either.
    expect(edgeColumnNames).not.toContain('belief_evidence_origin_key');

    // EDITED from the direction/strength read-back: the unprefixed-era row
    // ('for', 0.7) lands as a single unsigned support of 0.7, with its
    // contribution stamp carried across untouched.
    const migratedEdge = db.sqlite
      .prepare(
        `SELECT belief_evidence_support, belief_evidence_contribution
         FROM edges WHERE id = 1`
      )
      .get() as {
      belief_evidence_support: number;
      belief_evidence_contribution: number;
    };
    expect(Number(migratedEdge.belief_evidence_support)).toBeCloseTo(0.7, 10);
    expect(migratedEdge.belief_evidence_contribution).toBeCloseTo(0.21, 10);

    expect(db.hasTable('source_trust')).toBe(false);
    expect(db.hasTable('belief_source_trust')).toBe(false);
  });

  // The headline credence migration on nodes: a database whose graded
  // quantity is stored as belief_value must come out of client init with
  // that column gone and belief_credence holding exactly the same numbers —
  // graded values and the ungraded NULL alike — with belief_computed_at and
  // the upstream node columns untouched beside them.
  it('a database naming the quantity belief_value comes out with belief_credence holding the same values', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseNamingCredenceAsBeliefValue,
    });

    const nodeColumnNames = db.readTableColumns('nodes').map(column => column.name);
    expect(nodeColumnNames, 'the quantity is now called credence').toContain('belief_credence');
    expect(nodeColumnNames, 'the old belief_value column is renamed away').not.toContain(
      'belief_value'
    );
    expect(nodeColumnNames).toContain('belief_computed_at');
    // The upstream-owned columns beside ours are untouched by the rename.
    for (const upstreamNodeColumnName of [
      'id',
      'title',
      'description',
      'source',
      'link',
      'event_date',
      'created_at',
      'updated_at',
      'metadata',
      'embedding',
      'embedding_updated_at',
      'embedding_text',
      'chunk_status',
    ]) {
      expect(nodeColumnNames, `nodes.${upstreamNodeColumnName} must survive`).toContain(
        upstreamNodeColumnName
      );
    }

    // Every row's stored number carries over unchanged, NULL row included.
    const migratedNodeRows = db.sqlite
      .prepare('SELECT id, title, belief_credence, belief_computed_at FROM nodes ORDER BY id ASC')
      .all() as Array<{
      id: number;
      title: string;
      belief_credence: number | null;
      belief_computed_at: string | null;
    }>;
    expect(migratedNodeRows).toHaveLength(3);
    expect(migratedNodeRows.map(row => row.title)).toEqual([
      'graded claim',
      'ungraded claim',
      'evidence source',
    ]);
    expect(Number(migratedNodeRows[0].belief_credence)).toBeCloseTo(-0.42, 10);
    expect(migratedNodeRows[0].belief_computed_at).toBe('2026-07-27T00:00:00.000Z');
    // An ungraded node stays ungraded: NULL is a real state, not a zero.
    expect(migratedNodeRows[1].belief_credence).toBeNull();
    expect(migratedNodeRows[1].belief_computed_at).toBeNull();
    expect(Number(migratedNodeRows[2].belief_credence)).toBeCloseTo(0.75, 10);

    // EDITED from the direction/strength read-back: the edges evidence data
    // sitting beside the renamed node column carries the same weight it
    // always did, now as one unsigned support of 0.7 with its stamp intact.
    const preservedEvidenceEdge = db.sqlite
      .prepare(
        `SELECT belief_evidence_support, belief_evidence_contribution
         FROM edges WHERE id = 1`
      )
      .get() as {
      belief_evidence_support: number;
      belief_evidence_contribution: number;
    };
    expect(Number(preservedEvidenceEdge.belief_evidence_support)).toBeCloseTo(0.7, 10);
    expect(preservedEvidenceEdge.belief_evidence_contribution).toBeCloseTo(0.63, 10);
  });

  // The same migration on the movement log: from_value / to_value record the
  // node's credence before and after a recompute, so they are renamed to
  // from_credence / to_credence with every logged row preserved — including
  // the first-grading row whose "before" is NULL.
  it('a database naming the movement columns from_value / to_value comes out with from_credence / to_credence and its rows intact', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseNamingCredenceAsBeliefValue,
    });

    const movementColumnNames = db.readTableColumns('belief_movements').map(column => column.name);
    expect(movementColumnNames).toContain('from_credence');
    expect(movementColumnNames).toContain('to_credence');
    expect(movementColumnNames, 'the old from_value column is renamed away').not.toContain(
      'from_value'
    );
    expect(movementColumnNames, 'the old to_value column is renamed away').not.toContain('to_value');

    // Read through the helper so the shared movement-row shape is exercised.
    const migratedMovements = db.readBeliefMovements(1);
    expect(migratedMovements).toHaveLength(2);
    expect(migratedMovements[0].from_credence, 'a first grading has no previous credence').toBeNull();
    expect(Number(migratedMovements[0].to_credence)).toBeCloseTo(0.31, 10);
    expect(migratedMovements[0].trigger).toBe('belief-recompute');
    expect(migratedMovements[0].occurred_at).toBe('2026-07-26T00:00:00.000Z');
    expect(Number(migratedMovements[1].from_credence)).toBeCloseTo(0.31, 10);
    expect(Number(migratedMovements[1].to_credence)).toBeCloseTo(-0.42, 10);
  });

  // Table-rebuild guard for the credence rename, mirroring the origin-key
  // one. Renaming a column can be implemented either as ALTER TABLE ...
  // RENAME COLUMN or as a copy-into-a-new-table rebuild, and a rebuild
  // silently loses whatever it does not re-declare. ensureCoreSchema creates
  // idx_edges_from / idx_edges_to / idx_nodes_updated_at BEFORE the belief
  // migration runs, so nothing would recreate them afterwards: losing them
  // degrades every graph traversal and every recent-nodes listing, and losing
  // ON DELETE CASCADE orphans edges when a node is deleted.
  it('renaming belief_value to belief_credence leaves the nodes and edges indexes and the ON DELETE CASCADE foreign keys intact', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseNamingCredenceAsBeliefValue,
    });

    // Precondition: the rename this test guards actually happened.
    expect(db.readTableColumns('nodes').map(column => column.name)).toContain('belief_credence');

    // The nodes listing index survives the nodes-table rename.
    const survivingNodeIndexNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='nodes'")
        .all() as Array<{ name: string }>
    ).map(indexRow => indexRow.name);
    expect(
      survivingNodeIndexNames,
      'idx_nodes_updated_at must survive the credence rename'
    ).toContain('idx_nodes_updated_at');

    // Both edges traversal indexes survive.
    const survivingEdgeIndexNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'")
        .all() as Array<{ name: string }>
    ).map(indexRow => indexRow.name);
    expect(survivingEdgeIndexNames, 'idx_edges_from must survive the rename').toContain(
      'idx_edges_from'
    );
    expect(survivingEdgeIndexNames, 'idx_edges_to must survive the rename').toContain(
      'idx_edges_to'
    );

    // Both foreign keys to nodes(id) survive, still cascading on delete.
    const survivingForeignKeys = db.sqlite
      .prepare("PRAGMA foreign_key_list('edges')")
      .all() as EdgeForeignKeyDeclaration[];
    for (const referencingColumnName of ['from_node_id', 'to_node_id']) {
      const foreignKeyForColumn = survivingForeignKeys.find(
        declaration => declaration.from === referencingColumnName
      );
      expect(
        foreignKeyForColumn,
        `edges.${referencingColumnName} must still declare a foreign key`
      ).toBeDefined();
      expect(foreignKeyForColumn?.table).toBe('nodes');
      expect(foreignKeyForColumn?.to).toBe('id');
      expect(
        foreignKeyForColumn?.on_delete.toUpperCase(),
        `edges.${referencingColumnName} must still cascade on delete`
      ).toBe('CASCADE');
    }
  });

  // The half-migrated case: standalone init-db can leave a database carrying
  // BOTH nodes.belief_value (populated) and an empty nodes.belief_credence.
  // App client init must resolve that to one column — belief_credence stays,
  // belief_value goes — so the quantity is never stored under two names at
  // once. Deliberately NOT asserted: what belief_credence holds afterwards.
  // There is no production data to protect, so the orphan column is simply
  // dropped and nothing is copied out of it; pinning the numbers either way
  // would over-specify the decision.
  it('a database carrying both belief_value and an empty belief_credence loses belief_value outright', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseCarryingBothBeliefValueAndBeliefCredence,
    });

    const nodeColumnNames = db.readTableColumns('nodes').map(column => column.name);
    expect(nodeColumnNames, 'the surviving column is the credence one').toContain(
      'belief_credence'
    );
    expect(
      nodeColumnNames,
      'the orphan belief_value column must be dropped, never left beside belief_credence'
    ).not.toContain('belief_value');
    expect(nodeColumnNames).toContain('belief_computed_at');

    // The rows themselves survive the drop: same three nodes, same titles,
    // same computed-at stamps, and the upstream-owned columns beside ours.
    const survivingNodeRows = db.sqlite
      .prepare('SELECT id, title, belief_computed_at FROM nodes ORDER BY id ASC')
      .all() as Array<{ id: number; title: string; belief_computed_at: string | null }>;
    expect(survivingNodeRows).toHaveLength(3);
    expect(survivingNodeRows.map(row => row.title)).toEqual([
      'graded claim',
      'ungraded claim',
      'evidence source',
    ]);
    expect(survivingNodeRows[0].belief_computed_at).toBe('2026-07-27T00:00:00.000Z');
    expect(survivingNodeRows[1].belief_computed_at).toBeNull();

    // EDITED from the direction/strength read-back: the edges evidence data
    // is untouched by a nodes-side drop, and reads back as unsigned support.
    const untouchedEvidenceEdge = db.sqlite
      .prepare(
        `SELECT belief_evidence_support, belief_evidence_contribution
         FROM edges WHERE id = 1`
      )
      .get() as {
      belief_evidence_support: number;
      belief_evidence_contribution: number;
    };
    expect(Number(untouchedEvidenceEdge.belief_evidence_support)).toBeCloseTo(0.7, 10);
    expect(untouchedEvidenceEdge.belief_evidence_contribution).toBeCloseTo(0.63, 10);
  });

  // Rebuild guard for the nodes-side DROP, which the rename guard above does
  // not cover: that test exercises ALTER TABLE ... RENAME COLUMN on nodes,
  // this one exercises ALTER TABLE ... DROP COLUMN on nodes, and only a drop
  // tempts an implementation into a copy-into-a-new-table rebuild. The
  // constraint is the same either way — ensureCoreSchema creates
  // idx_nodes_updated_at and the two edges indexes BEFORE the belief
  // migration runs, so nothing would recreate them afterwards.
  it('dropping the orphan belief_value column leaves the nodes and edges indexes and the ON DELETE CASCADE foreign keys intact', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseCarryingBothBeliefValueAndBeliefCredence,
    });

    // Precondition: the drop this test guards actually happened.
    expect(db.readTableColumns('nodes').map(column => column.name)).not.toContain('belief_value');

    // The nodes listing index survives the nodes-table drop.
    const survivingNodeIndexNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='nodes'")
        .all() as Array<{ name: string }>
    ).map(indexRow => indexRow.name);
    expect(survivingNodeIndexNames, 'idx_nodes_updated_at must survive the drop').toContain(
      'idx_nodes_updated_at'
    );

    // Both edges traversal indexes survive.
    const survivingEdgeIndexNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'")
        .all() as Array<{ name: string }>
    ).map(indexRow => indexRow.name);
    expect(survivingEdgeIndexNames, 'idx_edges_from must survive the drop').toContain(
      'idx_edges_from'
    );
    expect(survivingEdgeIndexNames, 'idx_edges_to must survive the drop').toContain('idx_edges_to');

    // Both foreign keys to nodes(id) survive, still cascading on delete — a
    // nodes rebuild would break what edges point at.
    const survivingForeignKeys = db.sqlite
      .prepare("PRAGMA foreign_key_list('edges')")
      .all() as EdgeForeignKeyDeclaration[];
    for (const referencingColumnName of ['from_node_id', 'to_node_id']) {
      const foreignKeyForColumn = survivingForeignKeys.find(
        declaration => declaration.from === referencingColumnName
      );
      expect(
        foreignKeyForColumn,
        `edges.${referencingColumnName} must still declare a foreign key`
      ).toBeDefined();
      expect(foreignKeyForColumn?.table).toBe('nodes');
      expect(foreignKeyForColumn?.to).toBe('id');
      expect(
        foreignKeyForColumn?.on_delete.toUpperCase(),
        `edges.${referencingColumnName} must still cascade on delete`
      ).toBe('CASCADE');
    }
  });

  // EDITED from "the credence rename leaves belief_source_trust untouched":
  // the sources-as-nodes migration now runs in the same pass, so a database
  // carrying both the old quantity name and the trust table comes out
  // renamed AND with the trust table gone.
  it('renaming belief_value to belief_credence also drops belief_source_trust', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseNamingCredenceAsBeliefValue,
    });

    // Precondition: the rename this test sits beside actually happened, so
    // the claim below is made about a migrated database.
    expect(db.readTableColumns('nodes').map(column => column.name)).toContain('belief_credence');

    expect(db.hasTable('belief_source_trust')).toBe(false);
  });

  // The headline merge migration: a database carrying TODAY's shipped
  // direction + strength pair must come out of client init with both columns
  // gone and belief_evidence_support holding the MAGNITUDE — support =
  // strength for 'for' and 'against' alike. The direction reading is
  // discarded (unsigned support cannot carry it; direction now lives on the
  // source node's credence), the relatedness strength survives, and the edge
  // stays evidence.
  it('a database carrying belief_evidence_direction and belief_evidence_strength comes out with the magnitude in belief_evidence_support', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseSplittingSupportIntoDirectionAndStrength,
    });

    const edgeColumnNames = db.readTableColumns('edges').map(column => column.name);
    expect(edgeColumnNames, 'the merged signed column is present').toContain(
      'belief_evidence_support'
    );
    for (const mergedAwayColumnName of mergedAwayEdgeEvidenceColumnNames) {
      expect(
        edgeColumnNames,
        `edges.${mergedAwayColumnName} must be gone once its value is merged into support`
      ).not.toContain(mergedAwayColumnName);
    }

    const mergedEdgeRows = db.sqlite
      .prepare('SELECT id, explanation, belief_evidence_support FROM edges ORDER BY id ASC')
      .all() as Array<{ id: number; explanation: string; belief_evidence_support: number | null }>;
    expect(mergedEdgeRows).toHaveLength(5);
    // 'for' 0.7 and 'against' 0.4 both keep their MAGNITUDE; the ungraded
    // 'for' 0.5 merges exactly like the graded ones.
    expect(Number(mergedEdgeRows[0].belief_evidence_support)).toBeCloseTo(0.7, 10);
    expect(Number(mergedEdgeRows[1].belief_evidence_support)).toBeCloseTo(0.4, 10);
    expect(Number(mergedEdgeRows[2].belief_evidence_support)).toBeCloseTo(0.5, 10);
    // A plain edge was never evidence and stays that way.
    expect(mergedEdgeRows[3].belief_evidence_support).toBeNull();
    // The invalid state the two-column shape allowed: a magnitude with no
    // direction was never gradeable, so it must NOT become evidence now.
    expect(
      mergedEdgeRows[4].belief_evidence_support,
      'an orphan strength with no direction was never evidence — support stays NULL'
    ).toBeNull();
  });

  // Data preservation across the merge: the existing grading stamps and every
  // other edge and node column keep their values. The merge rewrites one
  // quantity's storage and must move nothing else.
  it('merging direction and strength into support preserves the contribution stamps and all other row data', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseSplittingSupportIntoDirectionAndStrength,
    });

    // Precondition: the merge this test guards actually happened, so every
    // preservation claim below is made about a migrated database.
    expect(db.readTableColumns('edges').map(column => column.name)).toContain(
      'belief_evidence_support'
    );

    // Every existing belief_evidence_contribution stamp is carried across,
    // NULL stamps included — the merge does not regrade anything.
    const preservedStampRows = db.sqlite
      .prepare('SELECT id, belief_evidence_contribution FROM edges ORDER BY id ASC')
      .all() as Array<{ id: number; belief_evidence_contribution: number | null }>;
    expect(preservedStampRows[0].belief_evidence_contribution).toBeCloseTo(0.63, 10);
    expect(preservedStampRows[1].belief_evidence_contribution).toBeCloseTo(-0.36, 10);
    expect(preservedStampRows[2].belief_evidence_contribution).toBeNull();
    expect(preservedStampRows[3].belief_evidence_contribution).toBeNull();
    expect(preservedStampRows[4].belief_evidence_contribution).toBeNull();

    // The upstream-owned edge columns and their data survive untouched.
    const edgeColumnNames = db.readTableColumns('edges').map(column => column.name);
    for (const upstreamEdgeColumnName of [
      'id',
      'from_node_id',
      'to_node_id',
      'source',
      'created_at',
      'context',
      'explanation',
    ]) {
      expect(edgeColumnNames, `edges.${upstreamEdgeColumnName} must survive`).toContain(
        upstreamEdgeColumnName
      );
    }
    const preservedEdgeRows = db.sqlite
      .prepare('SELECT id, from_node_id, to_node_id, explanation FROM edges ORDER BY id ASC')
      .all() as Array<{
      id: number;
      from_node_id: number;
      to_node_id: number;
      explanation: string;
    }>;
    expect(preservedEdgeRows.map(row => row.id)).toEqual([1, 2, 3, 4, 5]);
    // One source node per edge — the direction-slot UNIQUE index outlaws
    // same-slot parallels, so the fixture fans the five edges out from five
    // distinct sources, all pointing at the claim.
    expect(preservedEdgeRows.map(row => row.from_node_id)).toEqual([3, 4, 5, 6, 7]);
    expect(preservedEdgeRows.every(row => row.to_node_id === 1)).toBe(true);
    expect(preservedEdgeRows[0].explanation).toBe('supporting evidence edge');
    expect(preservedEdgeRows[4].explanation).toBe('orphan strength with no direction');

    // The nodes side is untouched by an edges-side merge: graded credence,
    // ungraded NULL, and the computed-at stamps all carry over.
    const preservedNodeRows = db.sqlite
      .prepare('SELECT id, title, belief_credence, belief_computed_at FROM nodes ORDER BY id ASC')
      .all() as Array<{
      id: number;
      title: string;
      belief_credence: number | null;
      belief_computed_at: string | null;
    }>;
    // Seven nodes: the three characterized ones plus the four filler sources
    // that give each fixture edge its own direction slot.
    expect(preservedNodeRows).toHaveLength(7);
    expect(Number(preservedNodeRows[0].belief_credence)).toBeCloseTo(0.31, 10);
    expect(preservedNodeRows[0].belief_computed_at).toBe('2026-07-27T00:00:00.000Z');
    expect(preservedNodeRows[1].belief_credence).toBeNull();
    expect(Number(preservedNodeRows[2].belief_credence)).toBeCloseTo(0.75, 10);
    // The filler sources were laid down ungraded and must come out ungraded.
    for (const fillerSourceNodeRow of preservedNodeRows.slice(3)) {
      expect(fillerSourceNodeRow.belief_credence).toBeNull();
    }

    // The movement log is untouched too.
    const preservedMovements = db.readBeliefMovements(1);
    expect(preservedMovements).toHaveLength(1);
    expect(preservedMovements[0].from_credence).toBeNull();
    expect(Number(preservedMovements[0].to_credence)).toBeCloseTo(0.31, 10);
  });

  // Table-rebuild guard for the merge, mirroring the origin-key and credence
  // ones. The merge needs an ADD COLUMN + UPDATE + two DROP COLUMNs, all of
  // which an implementation could be tempted to do as one copy-into-a-new-
  // table rebuild — which silently loses whatever it does not re-declare.
  // ensureCoreSchema creates idx_nodes_updated_at / idx_edges_from /
  // idx_edges_to BEFORE this migration runs, so nothing would recreate them:
  // losing them degrades every graph traversal and every recent-nodes
  // listing, and losing ON DELETE CASCADE orphans edges when a node is
  // deleted.
  it('merging direction and strength into support leaves the nodes and edges indexes and the ON DELETE CASCADE foreign keys intact', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseSplittingSupportIntoDirectionAndStrength,
    });

    // Precondition: the merge this test guards actually happened.
    expect(db.readTableColumns('edges').map(column => column.name)).toContain(
      'belief_evidence_support'
    );

    // The nodes listing index survives an edges-table migration.
    const survivingNodeIndexNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='nodes'")
        .all() as Array<{ name: string }>
    ).map(indexRow => indexRow.name);
    expect(survivingNodeIndexNames, 'idx_nodes_updated_at must survive the merge').toContain(
      'idx_nodes_updated_at'
    );

    // Both edges traversal indexes survive.
    const survivingEdgeIndexNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'")
        .all() as Array<{ name: string }>
    ).map(indexRow => indexRow.name);
    expect(survivingEdgeIndexNames, 'idx_edges_from must survive the merge').toContain(
      'idx_edges_from'
    );
    expect(survivingEdgeIndexNames, 'idx_edges_to must survive the merge').toContain(
      'idx_edges_to'
    );

    // Both foreign keys to nodes(id) survive, still cascading on delete.
    const survivingForeignKeys = db.sqlite
      .prepare("PRAGMA foreign_key_list('edges')")
      .all() as EdgeForeignKeyDeclaration[];
    for (const referencingColumnName of ['from_node_id', 'to_node_id']) {
      const foreignKeyForColumn = survivingForeignKeys.find(
        declaration => declaration.from === referencingColumnName
      );
      expect(
        foreignKeyForColumn,
        `edges.${referencingColumnName} must still declare a foreign key`
      ).toBeDefined();
      expect(foreignKeyForColumn?.table).toBe('nodes');
      expect(foreignKeyForColumn?.to).toBe('id');
      expect(
        foreignKeyForColumn?.on_delete.toUpperCase(),
        `edges.${referencingColumnName} must still cascade on delete`
      ).toBe('CASCADE');
    }
  });

  // EDITED from "gains belief_source_trust and belief_movements": the
  // movement log is still created, but no trust table ever is.
  it('legacy database file gains the belief_movements table and no belief_source_trust after client init', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createLegacyDatabaseWithoutBeliefColumns,
    });
    const tableNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map(row => row.name);
    expect(tableNames).toContain('belief_movements');
    expect(tableNames).not.toContain('belief_source_trust');
  });
});

describe('sources-as-nodes schema migration', () => {
  // The headline removal: a database whose belief_source_trust table has rows
  // in it — which is the state every existing development database is in —
  // must come out with that table gone. The rows are deliberately NOT carried
  // anywhere: a source's influence is its own nodes.belief_credence now, and
  // a trust score keyed by a metadata string cannot be mapped onto a node.
  it('drops belief_source_trust even when it has rows in it', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseCarryingBeliefSourceTrustRows,
    });

    expect(db.hasTable('belief_source_trust')).toBe(false);
    // The graph itself is untouched by the drop: both nodes, the evidence
    // edge, its support and its stamp all survive.
    const survivingNodeRows = db.sqlite
      .prepare('SELECT id, title, belief_credence FROM nodes ORDER BY id ASC')
      .all() as Array<{ id: number; title: string; belief_credence: number | null }>;
    expect(survivingNodeRows).toHaveLength(2);
    expect(Number(survivingNodeRows[0].belief_credence)).toBeCloseTo(0.31, 10);
    expect(survivingNodeRows[1].belief_credence).toBeNull();
    const survivingEvidenceEdge = db.sqlite
      .prepare(
        'SELECT belief_evidence_support, belief_evidence_contribution FROM edges WHERE id = 1'
      )
      .get() as { belief_evidence_support: number; belief_evidence_contribution: number };
    expect(Number(survivingEvidenceEdge.belief_evidence_support)).toBeCloseTo(0.7, 10);
    expect(Number(survivingEvidenceEdge.belief_evidence_contribution)).toBeCloseTo(0.63, 10);
  });

  // Table-rebuild guard for the sources-as-nodes migration, mirroring the
  // origin-key, credence and merge guards. Adding belief_credence_is_fixed
  // must be an ALTER TABLE ADD COLUMN and removing belief_source_trust must
  // be a DROP TABLE — never a copy-into-a-new-table rebuild of nodes or
  // edges. ensureCoreSchema creates idx_nodes_updated_at / idx_edges_from /
  // idx_edges_to BEFORE this migration runs, so a rebuild would destroy them
  // with nothing left to recreate them, and would take the ON DELETE CASCADE
  // foreign keys with it.
  it('adding belief_credence_is_fixed and dropping belief_source_trust leaves the indexes and ON DELETE CASCADE foreign keys intact', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseCarryingBeliefSourceTrustRows,
    });

    // Preconditions: both halves of the migration this test guards happened.
    expect(db.readTableColumns('nodes').map(column => column.name)).toContain(
      'belief_credence_is_fixed'
    );
    expect(db.hasTable('belief_source_trust')).toBe(false);

    // The nodes listing index survives the nodes-table ALTER.
    const survivingNodeIndexNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='nodes'")
        .all() as Array<{ name: string }>
    ).map(indexRow => indexRow.name);
    expect(
      survivingNodeIndexNames,
      'idx_nodes_updated_at must survive the fixed-credence column being added'
    ).toContain('idx_nodes_updated_at');

    // Both edges traversal indexes survive.
    const survivingEdgeIndexNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'")
        .all() as Array<{ name: string }>
    ).map(indexRow => indexRow.name);
    expect(survivingEdgeIndexNames).toContain('idx_edges_from');
    expect(survivingEdgeIndexNames).toContain('idx_edges_to');

    // Both foreign keys to nodes(id) survive, still cascading on delete.
    const survivingForeignKeys = db.sqlite
      .prepare("PRAGMA foreign_key_list('edges')")
      .all() as EdgeForeignKeyDeclaration[];
    for (const referencingColumnName of ['from_node_id', 'to_node_id']) {
      const foreignKeyForColumn = survivingForeignKeys.find(
        declaration => declaration.from === referencingColumnName
      );
      expect(
        foreignKeyForColumn,
        `edges.${referencingColumnName} must still declare a foreign key`
      ).toBeDefined();
      expect(foreignKeyForColumn?.table).toBe('nodes');
      expect(foreignKeyForColumn?.to).toBe('id');
      expect(
        foreignKeyForColumn?.on_delete.toUpperCase(),
        `edges.${referencingColumnName} must still cascade on delete`
      ).toBe('CASCADE');
    }
  });

  // A database that has ALREADY been migrated must survive the migration
  // running over it again: the existing belief_credence_is_fixed column is
  // left alone (ALTER TABLE ADD COLUMN would fail on it) and the fixed node
  // keeps its flag — re-running must never demote a human-asserted node back
  // to a derived one.
  it('a database already carrying belief_credence_is_fixed keeps the column and its fixed rows', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseAlreadyCarryingBeliefCredenceIsFixed,
    });

    const nodeColumnNames = db.readTableColumns('nodes').map(column => column.name);
    expect(nodeColumnNames).toContain('belief_credence_is_fixed');
    // Exactly one such column — a second one under the same name is
    // impossible in SQLite, but a duplicated ADD would have thrown instead.
    expect(
      nodeColumnNames.filter(columnName => columnName === 'belief_credence_is_fixed')
    ).toHaveLength(1);

    const preservedFixedNode = db.sqlite
      .prepare('SELECT belief_credence, belief_credence_is_fixed FROM nodes WHERE id = 1')
      .get() as { belief_credence: number; belief_credence_is_fixed: number };
    expect(preservedFixedNode.belief_credence_is_fixed, 'the fixed node stays fixed').toBe(1);
    expect(Number(preservedFixedNode.belief_credence)).toBeCloseTo(0.9, 10);
    const preservedOrdinaryNode = db.sqlite
      .prepare('SELECT belief_credence_is_fixed FROM nodes WHERE id = 2')
      .get() as { belief_credence_is_fixed: number };
    expect(preservedOrdinaryNode.belief_credence_is_fixed).toBe(0);

    // The other half of the migration still runs on this database: having the
    // column already is no reason to leave the trust table behind.
    expect(db.hasTable('belief_source_trust')).toBe(false);
  });

  // Idempotence over the migration's OWN output: running client init a second
  // time on the same file must be a no-op. This is the run that catches a
  // migration step that only works once — an unconditional ADD COLUMN, or a
  // DROP TABLE without an IF EXISTS.
  it('running the migration twice over the same file changes nothing and does not throw', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseCarryingBeliefSourceTrustRows,
    });
    // Mark a node as human-asserted between the two runs, so the second run
    // has a fixed row to preserve as well as a column to leave alone.
    db.sqlite.prepare('UPDATE nodes SET belief_credence_is_fixed = 1 WHERE id = 2').run();
    const nodeColumnNamesAfterFirstRun = db
      .readTableColumns('nodes')
      .map(column => column.name);

    await db.reopenBeliefDatabase();

    expect(db.readTableColumns('nodes').map(column => column.name)).toEqual(
      nodeColumnNamesAfterFirstRun
    );
    expect(db.hasTable('belief_source_trust')).toBe(false);
    expect(db.readNodeBeliefCredenceIsFixed(2)).toBe(1);
    // The graph is still intact after the second pass.
    const survivingEvidenceEdge = db.sqlite
      .prepare('SELECT belief_evidence_support FROM edges WHERE id = 1')
      .get() as { belief_evidence_support: number };
    expect(Number(survivingEvidenceEdge.belief_evidence_support)).toBeCloseTo(0.7, 10);
    // And the indexes are still there after two passes, not just one.
    const survivingEdgeIndexNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'")
        .all() as Array<{ name: string }>
    ).map(indexRow => indexRow.name);
    expect(survivingEdgeIndexNames).toContain('idx_edges_from');
    expect(survivingEdgeIndexNames).toContain('idx_edges_to');
  });

  // Idempotence on a FRESH database too: the second pass over a database the
  // client itself created must be just as quiet as the second pass over a
  // migrated legacy one.
  it('running the migration twice over a fresh database changes nothing and does not throw', async () => {
    db = await openTempBeliefDatabase();
    const nodeColumnNamesAfterFirstRun = db.readTableColumns('nodes').map(column => column.name);
    const edgeColumnNamesAfterFirstRun = db.readTableColumns('edges').map(column => column.name);

    await db.reopenBeliefDatabase();

    expect(db.readTableColumns('nodes').map(column => column.name)).toEqual(
      nodeColumnNamesAfterFirstRun
    );
    expect(db.readTableColumns('edges').map(column => column.name)).toEqual(
      edgeColumnNamesAfterFirstRun
    );
    expect(db.hasTable('belief_source_trust')).toBe(false);
  });
});

describe('source trust mechanism removal', () => {
  // The module that read and wrote belief_source_trust is deleted outright,
  // not emptied or left importable: a source's influence is its own node
  // credence, so there is no separate service for it to live in. Checked on
  // disk rather than by importing, so this stays a valid assertion once the
  // module (and any import of it) is gone from the codebase.
  it('src/services/belief/sourceTrustService.ts no longer exists', () => {
    const deletedSourceTrustServicePath = path.join(
      process.cwd(),
      'src',
      'services',
      'belief',
      'sourceTrustService.ts'
    );
    expect(
      fs.existsSync(deletedSourceTrustServicePath),
      'the source trust service is deleted, not kept alongside the node credence it became'
    ).toBe(false);
  });

  // The belief service must not name the deleted table or the deleted
  // metadata convention anywhere: reading a trustOriginKey out of node
  // metadata is exactly the lookup that sources-as-nodes replaces.
  it('the belief service source names neither belief_source_trust nor trustOriginKey', () => {
    const beliefServiceSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'services', 'belief', 'beliefService.ts'),
      'utf8'
    );
    expect(beliefServiceSource).not.toContain('belief_source_trust');
    expect(beliefServiceSource).not.toContain('trustOriginKey');
  });
});
