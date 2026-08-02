/**
 * Temp SQLite fixture for the embedder call-site tests.
 *
 * NodeEmbedder and UniversalEmbedder open their own database in their
 * constructors via createDatabaseConnection(), which resolves the file from
 * process.env.SQLITE_DB_PATH before falling back to the user's REAL database
 * (macOS: ~/Library/Application Support/RA-H/db/rah.sqlite). This helper
 * therefore creates a throwaway temp-file database carrying only the minimal
 * nodes/chunks schema those two classes touch, and pins SQLITE_DB_PATH to it
 * with vi.stubEnv so the per-test vi.unstubAllEnvs() restores the real value.
 *
 * The vec0 extension is NOT loaded here: createDatabaseConnection tolerates a
 * failed extension load (it logs and continues), and the tests mock the
 * vector backend module anyway — the assertions live on the embedding HTTP
 * request body, not on vector storage.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';

// Everything an embedder call-site test needs to drive one throwaway
// temp-file database that the embedder class under test will open itself.
export interface TempEmbedderSqliteDatabase {
  // Absolute path of the temp SQLite file SQLITE_DB_PATH now points at.
  tempDbPath: string;
  // Insert a node row for the embedder to pick up; returns its id.
  // `source` chooses the embedder path: empty string keeps NodeEmbedder away
  // from its LLM-analysis branch; non-empty text gives UniversalEmbedder
  // content to chunk.
  insertNodeFixture(options: {
    title: string;
    source: string;
    description?: string;
  }): number;
  // Close the fixture connection and delete the temp directory.
  cleanup(): void;
}

// Minimal slice of the real schema: exactly the nodes columns NodeEmbedder
// selects/updates plus the chunk_status column UniversalEmbedder stamps, and
// exactly the chunks columns UniversalEmbedder inserts/deletes.
const MINIMAL_EMBEDDER_SCHEMA_SQL = `
  CREATE TABLE nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source TEXT,
    description TEXT,
    chunk_status TEXT,
    embedding BLOB,
    embedding_updated_at TEXT,
    embedding_text TEXT
  );
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    chunk_idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding_type TEXT,
    metadata TEXT,
    created_at TEXT
  );
`;

// Create the temp-file database, lay down the minimal schema, and point
// SQLITE_DB_PATH at it so the next embedder constructor opens this file.
export function openTempEmbedderSqliteDatabase(): TempEmbedderSqliteDatabase {
  // Fresh per-test directory under the OS tmpdir; never a shared/real path.
  const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-embedder-inputtype-test-'));
  const tempDbPath = path.join(tempDbDir, 'rah-embedder-test.sqlite');

  // Fixture-side connection: seeds schema and rows. The embedder under test
  // opens its OWN connection to the same file, which better-sqlite3 allows.
  const fixtureDb = new Database(tempDbPath);
  fixtureDb.exec(MINIMAL_EMBEDDER_SCHEMA_SQL);

  // vi.stubEnv (not a bare assignment) so vi.unstubAllEnvs() in the test's
  // afterEach puts the real SQLITE_DB_PATH back.
  vi.stubEnv('SQLITE_DB_PATH', tempDbPath);

  return {
    tempDbPath,

    insertNodeFixture({ title, source, description }) {
      const insertResult = fixtureDb
        .prepare('INSERT INTO nodes (title, source, description) VALUES (?, ?, ?)')
        .run(title, source, description ?? null);
      return Number(insertResult.lastInsertRowid);
    },

    cleanup() {
      try {
        fixtureDb.close();
      } finally {
        // Delete only this test's own mkdtemp directory.
        fs.rmSync(tempDbDir, { recursive: true, force: true });
      }
    },
  };
}
