/**
 * Schema tests for the belief engine (MR-A).
 *
 * Pins that SQLite client bootstrap gives a database:
 *  - nodes.belief_value / nodes.belief_computed_at
 *  - edges.belief_evidence_direction / belief_evidence_strength /
 *    belief_evidence_contribution — and NO belief_evidence_origin_key: that
 *    column existed only to feed the deleted POLICY-V1 collapse-by-origin
 *    step, nothing reads it now, so it is removed from fresh databases and
 *    dropped (never renamed forward) from every database that still has it
 *    under any of its historical names
 *  - belief_source_trust (keyed by trust_origin_key) and belief_movements tables
 * on BOTH a fresh database and a pre-existing legacy database file created
 * without those columns (the ensure-column migration path).
 *
 * OUT OF SCOPE here: trust_origin_key on belief_source_trust names WHO is
 * trusted and keeps working exactly as before — do not weaken those cases.
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

// The evidence columns that survive the removal, in the order they are read
// back by the data-preservation assertions below.
const survivingEdgeEvidenceColumnNames = [
  'belief_evidence_direction',
  'belief_evidence_strength',
  'belief_evidence_contribution',
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
// RENAME the trust key, and DROP evidence_independence_key outright.
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
    INSERT INTO nodes (id, title) VALUES (1, 'claim'), (2, 'source');
    INSERT INTO edges (from_node_id, to_node_id, source, explanation, evidence_relation, evidence_strength, evidence_independence_key)
    VALUES (2, 1, 'user', 'old-vocabulary supporting edge', 'supports', 0.7, 'origin-a'),
           (2, 1, 'user', 'old-vocabulary contradicting edge', 'contradicts', 0.4, 'origin-b');
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
// values — so the drop migration has real data to preserve.
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
           (2, 'source', NULL, NULL);
    INSERT INTO edges (id, from_node_id, to_node_id, source, explanation,
                       belief_evidence_direction, belief_evidence_strength,
                       belief_evidence_origin_key, belief_evidence_contribution)
    VALUES (1, 2, 1, 'user', 'keyed supporting edge', 'for', 0.7, 'origin-a', 0.63),
           (2, 2, 1, 'user', 'keyed contradicting edge', 'against', 0.4, 'origin-b', -0.36),
           (3, 2, 1, 'user', 'edge whose origin key was never set', 'for', 0.5, NULL, NULL);
    INSERT INTO belief_source_trust (trust_origin_key, score, updated_at)
    VALUES ('marelie', 0.9, '2026-07-27T00:00:00.000Z');
    CREATE INDEX idx_edges_from ON edges(from_node_id);
    CREATE INDEX idx_edges_to ON edges(to_node_id);
  `);
  shippedOriginKeyDb.close();
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

  it('fresh database: nodes has belief_value REAL and belief_computed_at TEXT', async () => {
    db = await openTempBeliefDatabase();
    const nodeColumns = db.readTableColumns('nodes');
    const beliefValueColumn = findColumn(nodeColumns, 'belief_value');
    const beliefComputedAtColumn = findColumn(nodeColumns, 'belief_computed_at');
    expect(beliefValueColumn).toBeDefined();
    expect(beliefValueColumn?.type.toUpperCase()).toBe('REAL');
    expect(beliefComputedAtColumn).toBeDefined();
    expect(beliefComputedAtColumn?.type.toUpperCase()).toBe('TEXT');
  });

  // Edited from the old four-column case: the origin key is removed, so a
  // fresh database must carry exactly the three surviving evidence columns
  // with their types unchanged.
  it('fresh database: edges has the three surviving evidence columns with the pinned types', async () => {
    db = await openTempBeliefDatabase();
    const edgeColumns = db.readTableColumns('edges');
    const expectedEvidenceColumnTypes: Record<string, string> = {
      belief_evidence_direction: 'TEXT',
      belief_evidence_strength: 'REAL',
      belief_evidence_contribution: 'REAL',
    };
    for (const [columnName, expectedType] of Object.entries(expectedEvidenceColumnTypes)) {
      const column = findColumn(edgeColumns, columnName);
      expect(column, `edges.${columnName} should exist`).toBeDefined();
      expect(column?.type.toUpperCase(), `edges.${columnName} type`).toBe(expectedType);
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

  it('fresh database: belief_source_trust table exists with trust_origin_key PK, NOT NULL score and updated_at', async () => {
    db = await openTempBeliefDatabase();
    const sourceTrustColumns = db.readTableColumns('belief_source_trust');
    expect(sourceTrustColumns.length, 'belief_source_trust table should exist').toBeGreaterThan(0);
    const trustOriginKeyColumn = findColumn(sourceTrustColumns, 'trust_origin_key');
    const scoreColumn = findColumn(sourceTrustColumns, 'score');
    const updatedAtColumn = findColumn(sourceTrustColumns, 'updated_at');
    expect(trustOriginKeyColumn?.pk, 'trust_origin_key is the primary key').toBe(1);
    expect(scoreColumn?.notnull, 'score is NOT NULL').toBe(1);
    expect(scoreColumn?.type.toUpperCase()).toBe('REAL');
    expect(updatedAtColumn?.notnull, 'updated_at is NOT NULL').toBe(1);
  });

  it('fresh database: belief_movements table exists with the pinned audit columns', async () => {
    db = await openTempBeliefDatabase();
    const movementColumns = db.readTableColumns('belief_movements');
    expect(movementColumns.length, 'belief_movements table should exist').toBeGreaterThan(0);
    expect(findColumn(movementColumns, 'id')?.pk, 'id is the primary key').toBe(1);
    expect(findColumn(movementColumns, 'node_id')?.notnull, 'node_id is NOT NULL').toBe(1);
    expect(findColumn(movementColumns, 'from_value'), 'from_value exists (nullable)').toBeDefined();
    expect(findColumn(movementColumns, 'to_value')?.notnull, 'to_value is NOT NULL').toBe(1);
    expect(findColumn(movementColumns, 'trigger')?.notnull, 'trigger is NOT NULL').toBe(1);
    expect(findColumn(movementColumns, 'occurred_at')?.notnull, 'occurred_at is NOT NULL').toBe(1);
  });

  it('legacy database file without belief columns gains the nodes and edges columns after client init', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createLegacyDatabaseWithoutBeliefColumns,
    });
    const nodeColumnNames = db.readTableColumns('nodes').map(column => column.name);
    const edgeColumnNames = db.readTableColumns('edges').map(column => column.name);
    expect(nodeColumnNames).toContain('belief_value');
    expect(nodeColumnNames).toContain('belief_computed_at');
    expect(edgeColumnNames).toContain('belief_evidence_direction');
    expect(edgeColumnNames).toContain('belief_evidence_strength');
    expect(edgeColumnNames).toContain('belief_evidence_contribution');
    // Edited from the old four-column expectation: the removed origin key
    // must never be added back to a database that does not have it.
    expect(edgeColumnNames).not.toContain('belief_evidence_origin_key');
  });

  // Vocabulary migration: the field shipped briefly as evidence_relation with
  // supports/contradicts values; client init must rename the column to
  // belief_evidence_direction and map the stored values to for/against.
  it('legacy evidence_relation column is renamed to belief_evidence_direction with values mapped to for/against', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseWithMrAVocabulary,
    });

    const edgeColumnNames = db.readTableColumns('edges').map(col => col.name);
    expect(edgeColumnNames).toContain('belief_evidence_direction');
    expect(edgeColumnNames).not.toContain('evidence_relation');
    expect(edgeColumnNames).not.toContain('evidence_direction');

    const migratedDirections = db.sqlite
      .prepare('SELECT belief_evidence_direction FROM edges ORDER BY id ASC')
      .all() as Array<{ belief_evidence_direction: string }>;
    expect(migratedDirections.map(row => row.belief_evidence_direction)).toEqual(['for', 'against']);
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

    // The rows and their surviving evidence values are untouched by the drop.
    const migratedEvidenceRows = db.sqlite
      .prepare(
        'SELECT belief_evidence_direction, belief_evidence_strength FROM edges ORDER BY id ASC'
      )
      .all() as Array<{ belief_evidence_direction: string; belief_evidence_strength: number }>;
    expect(migratedEvidenceRows.map(row => row.belief_evidence_direction)).toEqual(['for', 'against']);
    expect(migratedEvidenceRows[0].belief_evidence_strength).toBeCloseTo(0.7, 10);
    expect(migratedEvidenceRows[1].belief_evidence_strength).toBeCloseTo(0.4, 10);
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

    // All three rows survive with their evidence values, NULL key row included.
    const preservedEdgeRows = db.sqlite
      .prepare(
        `SELECT id, from_node_id, to_node_id, explanation,
                belief_evidence_direction, belief_evidence_strength, belief_evidence_contribution
         FROM edges ORDER BY id ASC`
      )
      .all() as Array<{
      id: number;
      from_node_id: number;
      to_node_id: number;
      explanation: string;
      belief_evidence_direction: string;
      belief_evidence_strength: number;
      belief_evidence_contribution: number | null;
    }>;
    expect(preservedEdgeRows).toHaveLength(3);
    expect(preservedEdgeRows.map(row => row.id)).toEqual([1, 2, 3]);
    expect(preservedEdgeRows.map(row => row.belief_evidence_direction)).toEqual([
      'for',
      'against',
      'for',
    ]);
    expect(preservedEdgeRows[0].belief_evidence_strength).toBeCloseTo(0.7, 10);
    expect(preservedEdgeRows[0].belief_evidence_contribution).toBeCloseTo(0.63, 10);
    expect(preservedEdgeRows[1].belief_evidence_strength).toBeCloseTo(0.4, 10);
    expect(preservedEdgeRows[1].belief_evidence_contribution).toBeCloseTo(-0.36, 10);
    // The row whose origin key was NULL survives exactly like the others.
    expect(preservedEdgeRows[2].explanation).toBe('edge whose origin key was never set');
    expect(preservedEdgeRows[2].belief_evidence_strength).toBeCloseTo(0.5, 10);
    expect(preservedEdgeRows[2].belief_evidence_contribution).toBeNull();

    // The nodes belief columns are unaffected by the edges-side drop.
    const preservedGradedNode = db.sqlite
      .prepare('SELECT title, belief_value, belief_computed_at FROM nodes WHERE id = 1')
      .get() as { title: string; belief_value: number; belief_computed_at: string };
    expect(preservedGradedNode.title).toBe('claim');
    expect(preservedGradedNode.belief_value).toBeCloseTo(0.31, 10);
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

  // Trust keys are OUT OF SCOPE of this removal: dropping the evidence origin
  // key must leave belief_source_trust and its trust_origin_key rows exactly
  // as they were on a database that carried both.
  it('dropping the evidence origin key leaves belief_source_trust and its trust_origin_key rows untouched', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseCarryingBeliefEvidenceOriginKey,
    });

    const sourceTrustColumns = db.readTableColumns('belief_source_trust');
    expect(findColumn(sourceTrustColumns, 'trust_origin_key')?.pk, 'trust_origin_key is still the primary key').toBe(1);

    const preservedTrustRow = db.sqlite
      .prepare('SELECT trust_origin_key, score FROM belief_source_trust')
      .get() as { trust_origin_key: string; score: number };
    expect(preservedTrustRow.trust_origin_key).toBe('marelie');
    expect(preservedTrustRow.score).toBeCloseTo(0.9, 10);
  });

  // Vocabulary migration: the trust table shipped briefly as source_trust
  // keyed by origin_key; client init must land its rows in
  // belief_source_trust keyed by trust_origin_key and drop the legacy table.
  it('legacy source_trust rows land in belief_source_trust keyed by trust_origin_key', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseWithMrAVocabulary,
    });

    const sourceTrustColumns = db.readTableColumns('belief_source_trust');
    expect(findColumn(sourceTrustColumns, 'trust_origin_key')?.pk, 'trust_origin_key is the primary key').toBe(1);
    expect(findColumn(sourceTrustColumns, 'origin_key')).toBeUndefined();

    const migratedTrustRow = db.sqlite
      .prepare('SELECT trust_origin_key, score FROM belief_source_trust')
      .get() as { trust_origin_key: string; score: number };
    expect(migratedTrustRow.trust_origin_key).toBe('marelie');
    expect(migratedTrustRow.score).toBeCloseTo(0.9, 10);

    const legacyTable = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='source_trust'")
      .get();
    expect(legacyTable, 'legacy source_trust table is dropped').toBeUndefined();
  });

  // EDITED from the old four-column rename case: the three surviving evidence
  // columns still gain the belief_ prefix with values preserved, but
  // evidence_origin_key is now DROPPED instead of renamed to
  // belief_evidence_origin_key. Trust rows still move to belief_source_trust.
  it('unprefixed evidence columns gain the belief_ prefix, the origin key is dropped, and trust rows move to belief_source_trust', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseWithUnprefixedVocabulary,
    });

    const edgeColumnNames = db.readTableColumns('edges').map(col => col.name);
    for (const oldName of ['evidence_direction', 'evidence_strength', 'evidence_origin_key', 'evidence_effective_contribution']) {
      expect(edgeColumnNames, `edges.${oldName} should be gone`).not.toContain(oldName);
    }
    // The dropped key is not renamed forward either.
    expect(edgeColumnNames).not.toContain('belief_evidence_origin_key');

    const migratedEdge = db.sqlite
      .prepare(
        `SELECT belief_evidence_direction, belief_evidence_strength, belief_evidence_contribution
         FROM edges WHERE id = 1`
      )
      .get() as {
      belief_evidence_direction: string;
      belief_evidence_strength: number;
      belief_evidence_contribution: number;
    };
    expect(migratedEdge.belief_evidence_direction).toBe('for');
    expect(migratedEdge.belief_evidence_strength).toBeCloseTo(0.7, 10);
    expect(migratedEdge.belief_evidence_contribution).toBeCloseTo(0.21, 10);

    const migratedTrustRow = db.sqlite
      .prepare('SELECT trust_origin_key, score FROM belief_source_trust')
      .get() as { trust_origin_key: string; score: number };
    expect(migratedTrustRow.trust_origin_key).toBe('marelie');
    expect(migratedTrustRow.score).toBeCloseTo(0.9, 10);
  });

  it('legacy database file gains the belief_source_trust and belief_movements tables after client init', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createLegacyDatabaseWithoutBeliefColumns,
    });
    const tableNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map(row => row.name);
    expect(tableNames).toContain('belief_source_trust');
    expect(tableNames).toContain('belief_movements');
  });
});
