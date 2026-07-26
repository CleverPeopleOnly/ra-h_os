/**
 * Schema tests for the belief engine (MR-A).
 *
 * Pins that SQLite client bootstrap gives a database:
 *  - nodes.belief_value / nodes.belief_computed_at
 *  - edges.belief_evidence_direction / belief_evidence_strength /
 *    belief_evidence_origin_key / belief_evidence_contribution
 *  - belief_source_trust (keyed by trust_origin_key) and belief_movements tables
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
// client init must RENAME all three and MAP the stored relation values.
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
// four columns and move the trust rows into belief_source_trust.
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

  it('fresh database: edges has the four evidence columns with the pinned types', async () => {
    db = await openTempBeliefDatabase();
    const edgeColumns = db.readTableColumns('edges');
    const expectedEvidenceColumnTypes: Record<string, string> = {
      belief_evidence_direction: 'TEXT',
      belief_evidence_strength: 'REAL',
      belief_evidence_origin_key: 'TEXT',
      belief_evidence_contribution: 'REAL',
    };
    for (const [columnName, expectedType] of Object.entries(expectedEvidenceColumnTypes)) {
      const column = findColumn(edgeColumns, columnName);
      expect(column, `edges.${columnName} should exist`).toBeDefined();
      expect(column?.type.toUpperCase(), `edges.${columnName} type`).toBe(expectedType);
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
    expect(edgeColumnNames).toContain('belief_evidence_origin_key');
    expect(edgeColumnNames).toContain('belief_evidence_contribution');
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

  // Vocabulary migration: the origin-artifact key shipped briefly as
  // evidence_independence_key; client init must rename the column to
  // belief_evidence_origin_key with the stored keys carried over unchanged.
  it('legacy evidence_independence_key column is renamed to belief_evidence_origin_key with values preserved', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseWithMrAVocabulary,
    });

    const edgeColumnNames = db.readTableColumns('edges').map(col => col.name);
    expect(edgeColumnNames).toContain('belief_evidence_origin_key');
    expect(edgeColumnNames).not.toContain('evidence_independence_key');
    expect(edgeColumnNames).not.toContain('evidence_origin_key');

    const migratedOriginKeys = db.sqlite
      .prepare('SELECT belief_evidence_origin_key FROM edges ORDER BY id ASC')
      .all() as Array<{ belief_evidence_origin_key: string }>;
    expect(migratedOriginKeys.map(row => row.belief_evidence_origin_key)).toEqual(['origin-a', 'origin-b']);
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

  // Vocabulary migration: the evidence columns shipped briefly without the
  // belief_ prefix; client init must rename all four with values preserved,
  // and move the trust rows from source_trust into belief_source_trust.
  it('unprefixed evidence columns gain the belief_ prefix and trust rows move to belief_source_trust', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseWithUnprefixedVocabulary,
    });

    const edgeColumnNames = db.readTableColumns('edges').map(col => col.name);
    for (const oldName of ['evidence_direction', 'evidence_strength', 'evidence_origin_key', 'evidence_effective_contribution']) {
      expect(edgeColumnNames, `edges.${oldName} should be gone`).not.toContain(oldName);
    }

    const migratedEdge = db.sqlite
      .prepare(
        `SELECT belief_evidence_direction, belief_evidence_strength, belief_evidence_origin_key, belief_evidence_contribution
         FROM edges WHERE id = 1`
      )
      .get() as {
      belief_evidence_direction: string;
      belief_evidence_strength: number;
      belief_evidence_origin_key: string;
      belief_evidence_contribution: number;
    };
    expect(migratedEdge.belief_evidence_direction).toBe('for');
    expect(migratedEdge.belief_evidence_strength).toBeCloseTo(0.7, 10);
    expect(migratedEdge.belief_evidence_origin_key).toBe('origin-a');
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
