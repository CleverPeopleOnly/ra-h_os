/**
 * FAILING-FIRST red set for slice 9 — THE ENGINE AND BELIEF SERVICES LEAVE
 * THE FORK: the belief_movements table leaves the app-side schema.
 *
 * The movement log existed to audit the engine's recomputes and the
 * hand-assert path; both die with this slice (samai owns the engine, and the
 * fixed-credence machinery is deleted), so nothing writes or reads a
 * movement row any more. A fresh database must not create the table or its
 * index, and an existing database still carrying them must have them
 * DROPPED — house precedent: belief_source_trust is dropped via
 * DROP TABLE IF EXISTS in the same schema pass — with every neighbouring
 * row preserved.
 *
 * Seam: tests/unit/belief/helpers/tempBeliefDatabase.ts, DATABASE-BUILDING
 * PARTS ONLY — this file deliberately touches none of the helper's imports
 * of belief service modules, because those modules are deleted by the same
 * slice this red set pins.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// Read the index names of the open temp database, so the dropped table's
// index can be pinned gone rather than surviving as an orphan definition.
function readIndexNames(openDb: TempBeliefDatabase): string[] {
  return (
    openDb.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

// Lay down a database file in TODAY's shipped shape as far as this slice
// cares: the pre-belief nodes/edges tables plus a belief_movements table in
// its current column vocabulary, its node_id index, and one logged movement
// row — so the drop migration has a real populated table to remove and real
// neighbouring rows to preserve.
function createDatabaseCarryingBeliefMovements(dbPath: string): void {
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
    CREATE TABLE belief_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      from_credence REAL,
      to_credence REAL NOT NULL,
      "trigger" TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX idx_belief_movements_node_id ON belief_movements(node_id);
    INSERT INTO nodes (id, title) VALUES (1, 'node whose movement log dies'), (2, 'bystander node');
    INSERT INTO edges (from_node_id, to_node_id, source, explanation)
    VALUES (2, 1, 'user', 'plain relationship edge beside the doomed log');
    INSERT INTO belief_movements (node_id, from_credence, to_credence, "trigger", occurred_at)
    VALUES (1, NULL, 0.31, 'belief-recompute', '2026-07-26T00:00:00.000Z');
  `);
  legacyDb.close();
}

describe('the belief_movements table leaves the schema', () => {
  // The fresh half: client init must simply not create the table or its
  // index any more — there is no writer left to fill it and no reader left
  // to serve from it.
  it('a freshly-initialised database has no belief_movements table and no idx_belief_movements_node_id', async () => {
    db = await openTempBeliefDatabase();

    expect(
      db.hasTable('belief_movements'),
      'a fresh database must not create belief_movements — nothing writes movements any more'
    ).toBe(false);
    expect(
      readIndexNames(db),
      'the movements index must not be created either'
    ).not.toContain('idx_belief_movements_node_id');
  });

  // The migration half: a database that already carries the table (the state
  // every existing development database is in) must come out of client init
  // with it dropped — its rows deliberately carried nowhere, the way
  // belief_source_trust's rows were — while every row beside it survives.
  it('a database carrying belief_movements loses the table and its index, with neighbouring rows intact', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: createDatabaseCarryingBeliefMovements,
    });

    expect(
      db.hasTable('belief_movements'),
      'belief_movements must be dropped from an existing database, not left behind'
    ).toBe(false);
    expect(
      readIndexNames(db),
      'the movements index must be gone with its table'
    ).not.toContain('idx_belief_movements_node_id');

    // The drop ate nothing on the way past: both nodes and the edge between
    // them survive with their data intact.
    const survivingNodeTitles = (
      db.sqlite.prepare('SELECT title FROM nodes ORDER BY id ASC').all() as Array<{
        title: string;
      }>
    ).map((row) => row.title);
    expect(survivingNodeTitles).toEqual(['node whose movement log dies', 'bystander node']);

    const survivingEdge = db.sqlite
      .prepare('SELECT from_node_id, to_node_id, explanation FROM edges WHERE id = 1')
      .get() as { from_node_id: number; to_node_id: number; explanation: string };
    expect(survivingEdge.from_node_id).toBe(2);
    expect(survivingEdge.to_node_id).toBe(1);
    expect(survivingEdge.explanation).toBe('plain relationship edge beside the doomed log');
  });
});
