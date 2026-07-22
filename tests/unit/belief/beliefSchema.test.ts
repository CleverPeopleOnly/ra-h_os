/**
 * Schema tests for the belief engine (MR-A).
 *
 * Pins that SQLite client bootstrap gives a database:
 *  - nodes.belief_value / nodes.belief_computed_at
 *  - edges.evidence_direction / evidence_strength / evidence_independence_key /
 *    evidence_effective_contribution
 *  - source_trust and belief_movements tables
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

// Lay down a database from the brief evidence_relation era (MR-A vocabulary):
// evidence columns exist under the old name with supports/contradicts values,
// so client init must RENAME the column and MAP the stored values.
function createDatabaseWithLegacyEvidenceRelationColumn(dbPath: string): void {
  createLegacyDatabaseWithoutBeliefColumns(dbPath);
  const oldVocabularyDb = new Database(dbPath);
  oldVocabularyDb.exec(`
    ALTER TABLE edges ADD COLUMN evidence_relation TEXT;
    ALTER TABLE edges ADD COLUMN evidence_strength REAL;
    ALTER TABLE edges ADD COLUMN evidence_independence_key TEXT;
    ALTER TABLE edges ADD COLUMN evidence_effective_contribution REAL;
    INSERT INTO nodes (id, title) VALUES (1, 'claim'), (2, 'source');
    INSERT INTO edges (from_node_id, to_node_id, source, explanation, evidence_relation, evidence_strength, evidence_independence_key)
    VALUES (2, 1, 'user', 'old-vocabulary supporting edge', 'supports', 0.7, 'origin-a'),
           (2, 1, 'user', 'old-vocabulary contradicting edge', 'contradicts', 0.4, 'origin-b');
  `);
  oldVocabularyDb.close();
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
      evidence_direction: 'TEXT',
      evidence_strength: 'REAL',
      evidence_independence_key: 'TEXT',
      evidence_effective_contribution: 'REAL',
    };
    for (const [columnName, expectedType] of Object.entries(expectedEvidenceColumnTypes)) {
      const column = findColumn(edgeColumns, columnName);
      expect(column, `edges.${columnName} should exist`).toBeDefined();
      expect(column?.type.toUpperCase(), `edges.${columnName} type`).toBe(expectedType);
    }
  });

  it('fresh database: source_trust table exists with origin_key PK, NOT NULL score and updated_at', async () => {
    db = await openTempBeliefDatabase();
    const sourceTrustColumns = db.readTableColumns('source_trust');
    expect(sourceTrustColumns.length, 'source_trust table should exist').toBeGreaterThan(0);
    const originKeyColumn = findColumn(sourceTrustColumns, 'origin_key');
    const scoreColumn = findColumn(sourceTrustColumns, 'score');
    const updatedAtColumn = findColumn(sourceTrustColumns, 'updated_at');
    expect(originKeyColumn?.pk, 'origin_key is the primary key').toBe(1);
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
    expect(edgeColumnNames).toContain('evidence_direction');
    expect(edgeColumnNames).toContain('evidence_strength');
    expect(edgeColumnNames).toContain('evidence_independence_key');
    expect(edgeColumnNames).toContain('evidence_effective_contribution');
  });

  // Vocabulary migration: the field shipped briefly as evidence_relation with
  // supports/contradicts values; client init must rename the column to
  // evidence_direction and map the stored values to for/against.
  it('legacy evidence_relation column is renamed to evidence_direction with values mapped to for/against', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseWithLegacyEvidenceRelationColumn,
    });

    const edgeColumnNames = db.readTableColumns('edges').map(col => col.name);
    expect(edgeColumnNames).toContain('evidence_direction');
    expect(edgeColumnNames).not.toContain('evidence_relation');

    const migratedDirections = db.sqlite
      .prepare('SELECT evidence_direction FROM edges ORDER BY id ASC')
      .all() as Array<{ evidence_direction: string }>;
    expect(migratedDirections.map(row => row.evidence_direction)).toEqual(['for', 'against']);
  });

  it('legacy database file gains the source_trust and belief_movements tables after client init', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createLegacyDatabaseWithoutBeliefColumns,
    });
    const tableNames = (
      db.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map(row => row.name);
    expect(tableNames).toContain('source_trust');
    expect(tableNames).toContain('belief_movements');
  });
});
