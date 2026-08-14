/**
 * Red set for the "database opens on first use" slice (belief-storage split,
 * slice 5b).
 *
 * TODAY: src/services/database/sqlite-client.ts ends with
 *   `export const sqliteDb = SQLiteClient.getInstance();`
 * so the private constructor — which creates the database DIRECTORY, opens
 * the SQLite FILE, and runs every schema migration — executes as a side
 * effect of merely importing the module. Any build, script or test that
 * transitively imports app code therefore opens (and part-migrates) whatever
 * database `SQLITE_DB_PATH || default` resolves to. During the previous
 * slice a `npm run build` part-migrated the developer's personal store
 * exactly this way.
 *
 * TARGET this red set specifies: importing app code opens NO database. The
 * connection is created lazily on the FIRST real use of the client, and from
 * that first use onward behaviour is identical to today — full schema
 * ensure, every migration, the same singleton behind every entry point. The
 * public surface must not change: `sqliteDb`, `getSQLiteClient()` and
 * `SQLiteClient.getInstance()` all remain and existing callers behave
 * unchanged after their first call.
 *
 * Isolation pattern: same as tests/unit/belief/helpers/tempBeliefDatabase.ts
 * — pin SQLITE_DB_PATH to a per-test temp path, vi.resetModules(), then
 * dynamically import the client module so each test gets its own module
 * generation bound to its own throwaway path.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Module-namespace type of the client under test, so the dynamic imports
// below stay fully typed without a static import (a static import would
// itself trigger today's import-time open and defeat every test here).
type SqliteClientModule = typeof import('@/services/database/sqlite-client');

// Module-load sentinel (same safety as tempBeliefDatabase.ts): from the
// instant this test file loads, any accidental sqlite-client import opens a
// harmless temp path instead of the developer's real database.
const sentinelTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-lazy-open-sentinel-'));
process.env.SQLITE_DB_PATH = path.join(sentinelTempDir, 'rah-lazy-open-sentinel.sqlite');

// Throws unless the given path resolves (symlinks included — macOS tmpdir is
// a /var -> /private/var symlink) to somewhere inside the OS temp directory.
// Copied from tempBeliefDatabase.ts: no test may ever point the client at a
// path whose contents matter.
function assertPathIsUnderOsTmpDir(candidatePath: string): void {
  const realTmpRoot = fs.realpathSync(os.tmpdir());
  // The database directory may deliberately not exist yet, so walk up to the
  // nearest existing ancestor before resolving symlinks.
  let existingAncestor = path.dirname(candidatePath);
  while (!fs.existsSync(existingAncestor)) {
    existingAncestor = path.dirname(existingAncestor);
  }
  const realAncestor = fs.realpathSync(existingAncestor);
  const isUnderTmp = realAncestor === realTmpRoot || realAncestor.startsWith(realTmpRoot + path.sep);
  if (!isUnderTmp) {
    throw new Error(
      `SAFETY: refusing to use database path outside the OS temp directory: ${candidatePath}`
    );
  }
}

// One test's throwaway database target: a temp root that EXISTS, containing
// a database directory and file that deliberately do NOT exist yet — so the
// tests can assert that importing the module created neither.
interface AbsentDatabaseTarget {
  // The mkdtemp root this test owns; removed wholesale in afterEach.
  tempRootDir: string;
  // The directory the client's open path would mkdir — absent at start.
  databaseDirectory: string;
  // The SQLite file the client's open path would create — absent at start.
  databasePath: string;
}

// Every temp root created during the current test, for afterEach removal.
let tempRootDirsToRemove: string[] = [];

// Every client a test actually used (and therefore opened), so afterEach can
// close its file handle. Deliberately NOT populated for import-only tests:
// calling close() there could itself become the "first use" that opens the
// database, corrupting what the test measured.
let openedSqliteClientsToClose: Array<{ close(): void }> = [];

// The environment variables these tests mutate, saved and restored around
// each test so the rest of the suite never sees this file's settings.
const mutatedEnvironmentKeys = ['SQLITE_DB_PATH', 'SQLITE_READONLY', 'RAH_DB_MAINTENANCE'] as const;
let savedEnvironmentValues: Partial<Record<(typeof mutatedEnvironmentKeys)[number], string | undefined>> = {};

// Create a fresh absent-database target and point SQLITE_DB_PATH at it, in
// normal (writable) mode unless a test overrides SQLITE_READONLY afterwards.
function pointClientAtAbsentDatabase(): AbsentDatabaseTarget {
  const tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-lazy-open-test-'));
  tempRootDirsToRemove.push(tempRootDir);
  // The database directory itself does not exist: today's constructor runs
  // fs.mkdirSync on it at import, so its absence is a witness that no open
  // path ran at all — not even the directory-creation prelude.
  const databaseDirectory = path.join(tempRootDir, 'database-directory-not-yet-created');
  const databasePath = path.join(databaseDirectory, 'rah-lazy-open-test.sqlite');
  assertPathIsUnderOsTmpDir(databasePath);
  process.env.SQLITE_DB_PATH = databasePath;
  delete process.env.SQLITE_READONLY;
  delete process.env.RAH_DB_MAINTENANCE;
  return { tempRootDir, databaseDirectory, databasePath };
}

// Import the sqlite-client module through a fresh module registry, so this
// test's generation binds to this test's SQLITE_DB_PATH.
async function importFreshSqliteClientModule(): Promise<SqliteClientModule> {
  vi.resetModules();
  return import('@/services/database/sqlite-client');
}

beforeEach(() => {
  savedEnvironmentValues = {};
  for (const environmentKey of mutatedEnvironmentKeys) {
    savedEnvironmentValues[environmentKey] = process.env[environmentKey];
  }
  tempRootDirsToRemove = [];
  openedSqliteClientsToClose = [];
});

afterEach(() => {
  for (const openedClient of openedSqliteClientsToClose) {
    try {
      openedClient.close();
    } catch {
      // A client that failed to open has nothing to close.
    }
  }
  for (const tempRootDir of tempRootDirsToRemove) {
    fs.rmSync(tempRootDir, { recursive: true, force: true });
  }
  for (const environmentKey of mutatedEnvironmentKeys) {
    const savedValue = savedEnvironmentValues[environmentKey];
    if (savedValue === undefined) {
      delete process.env[environmentKey];
    } else {
      process.env[environmentKey] = savedValue;
    }
  }
  // Re-arm the sentinel so any import after this test still hits temp.
  process.env.SQLITE_DB_PATH = path.join(sentinelTempDir, 'rah-lazy-open-sentinel.sqlite');
});

describe('sqlite-client opens its database on first use, not at import', () => {
  // RED CORE: today `export const sqliteDb = SQLiteClient.getInstance()`
  // runs the constructor at module evaluation, which mkdirs the database
  // directory and opens the file. After the slice, importing the module is
  // inert: no file, and not even the directory.
  it('importing the sqlite-client module creates neither the database file nor its directory', async () => {
    const absentDatabase = pointClientAtAbsentDatabase();

    await importFreshSqliteClientModule();

    expect(
      fs.existsSync(absentDatabase.databasePath),
      'importing sqlite-client must not create the database file'
    ).toBe(false);
    expect(
      fs.existsSync(absentDatabase.databaseDirectory),
      'importing sqlite-client must not create the database directory either'
    ).toBe(false);
  });

  // The laziness must not cost any of today's startup work: the FIRST real
  // call opens the file and leaves it fully migrated. The witnesses are
  // deliberately LATE artifacts of the ensure pass — the graph_events
  // journal table, the idx_edges_direction_slot unique index (the last two
  // ensures the constructor runs) and the belief_uncertainty node column —
  // so a lazy open that skips or truncates the migrations cannot pass.
  it('the first query through sqliteDb opens the file and leaves it fully migrated', async () => {
    const absentDatabase = pointClientAtAbsentDatabase();
    const sqliteClientModule = await importFreshSqliteClientModule();

    // Precondition = the red line today: nothing may exist before first use.
    expect(
      fs.existsSync(absentDatabase.databasePath),
      'no database file may exist before the first real call'
    ).toBe(false);

    // First real use through the surface app code calls everywhere.
    const probeResult = sqliteClientModule.sqliteDb.query<{ lazy_open_probe: number }>(
      'SELECT 1 AS lazy_open_probe'
    );
    openedSqliteClientsToClose.push(sqliteClientModule.sqliteDb);
    expect(probeResult.rows).toEqual([{ lazy_open_probe: 1 }]);

    // The first use created the file...
    expect(
      fs.existsSync(absentDatabase.databasePath),
      'the first query must create and open the database file'
    ).toBe(true);

    // ...and ran the FULL ensure pass, not a bare open.
    const graphEventsTableRows = sqliteClientModule.sqliteDb.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='graph_events'"
    );
    expect(
      graphEventsTableRows.rows,
      'the graph_events journal table must exist after the first use'
    ).toHaveLength(1);

    const directionSlotIndexRows = sqliteClientModule.sqliteDb.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_edges_direction_slot'"
    );
    expect(
      directionSlotIndexRows.rows,
      'the idx_edges_direction_slot unique index must exist after the first use'
    ).toHaveLength(1);

    const nodeTableColumns = sqliteClientModule.sqliteDb
      .prepare('PRAGMA table_info(nodes)')
      .all() as Array<{ name: string }>;
    expect(
      nodeTableColumns.map(column => column.name),
      'the belief_uncertainty display column must exist on nodes after the first use'
    ).toContain('belief_uncertainty');
  });

  // The singleton must survive the laziness: sqliteDb, getSQLiteClient()
  // and SQLiteClient.getInstance() are three names for ONE underlying open
  // connection, never three opens. Pinned by observables: a write through
  // one surface is read back through the others, and the connection they
  // share really has the test's temp file open as its main database.
  it('sqliteDb, getSQLiteClient() and SQLiteClient.getInstance() share one lazily-opened connection', async () => {
    const absentDatabase = pointClientAtAbsentDatabase();
    const sqliteClientModule = await importFreshSqliteClientModule();

    // Precondition = the red line today: import alone opened nothing.
    expect(
      fs.existsSync(absentDatabase.databasePath),
      'no database file may exist before the first real call'
    ).toBe(false);

    // Write through the first surface...
    const insertedNodeResult = sqliteClientModule.sqliteDb.query(
      'INSERT INTO nodes (title, source) VALUES (?, ?)',
      ['lazy-open singleton probe node', 'lazy-open singleton probe content']
    );
    openedSqliteClientsToClose.push(sqliteClientModule.sqliteDb);
    const insertedNodeId = insertedNodeResult.lastInsertRowid;
    expect(insertedNodeId).toBeTypeOf('number');

    // ...and read it back through the other two.
    const nodeRowViaGetSQLiteClient = sqliteClientModule
      .getSQLiteClient()
      .query<{ title: string }>('SELECT title FROM nodes WHERE id = ?', [insertedNodeId]);
    expect(nodeRowViaGetSQLiteClient.rows).toEqual([{ title: 'lazy-open singleton probe node' }]);

    const nodeRowViaGetInstance = sqliteClientModule.SQLiteClient.getInstance().query<{
      title: string;
    }>('SELECT title FROM nodes WHERE id = ?', [insertedNodeId]);
    expect(nodeRowViaGetInstance.rows).toEqual([{ title: 'lazy-open singleton probe node' }]);

    // The shared connection's main database is exactly this test's temp
    // file — one open, on the right path, not a second connection anywhere.
    const attachedDatabases = sqliteClientModule
      .getSQLiteClient()
      .prepare('PRAGMA database_list')
      .all() as Array<{ name: string; file: string }>;
    const mainDatabaseFile = attachedDatabases.find(row => row.name === 'main')?.file ?? '';
    expect(fs.realpathSync(mainDatabaseFile)).toBe(fs.realpathSync(absentDatabase.databasePath));
  });

  // Module-graph regression guard: it is not enough for sqlite-client's own
  // evaluation to be inert — no module BETWEEN it and the app may defeat the
  // laziness by issuing a query at import time. graphEvents and
  // beliefDisplayWrite both import getSQLiteClient at module top level and
  // sit on heavy transitive paths, so importing them is the canary.
  it('importing heavy transitive importers of sqlite-client also opens nothing', async () => {
    const absentDatabase = pointClientAtAbsentDatabase();
    vi.resetModules();

    await import('@/services/database/graphEvents');
    await import('@/services/belief/beliefDisplayWrite');

    expect(
      fs.existsSync(absentDatabase.databasePath),
      'importing graphEvents and beliefDisplayWrite must not create the database file'
    ).toBe(false);
    expect(
      fs.existsSync(absentDatabase.databaseDirectory),
      'importing graphEvents and beliefDisplayWrite must not create the database directory'
    ).toBe(false);
  });

  // Error timing moves with the open: an unopenable database path (readonly
  // mode over a file that does not exist — better-sqlite3's fileMustExist
  // refusal) must surface at FIRST USE. An import must never throw for a bad
  // database path, because import happens in builds and scripts that may
  // never touch the database at all.
  it('an unopenable database path fails at first use, never at import', async () => {
    const absentDatabase = pointClientAtAbsentDatabase();
    // Readonly mode refuses to create a missing file, making this path
    // unopenable without touching anything outside the temp directory.
    process.env.SQLITE_READONLY = 'true';

    // RED line today: module evaluation runs the constructor, the readonly
    // open throws on the missing file, and the import itself rejects.
    const freshImport = importFreshSqliteClientModule();
    await expect(
      freshImport,
      'importing sqlite-client must not throw for an unopenable database path'
    ).resolves.toBeDefined();

    const sqliteClientModule = await freshImport;

    // The failure belongs to the first real use instead.
    let firstUseFailure: unknown = null;
    try {
      sqliteClientModule.sqliteDb.query('SELECT 1 AS readonly_probe');
    } catch (queryError) {
      firstUseFailure = queryError;
    }
    expect(
      firstUseFailure,
      'the unopenable path must surface as an error on the first real call'
    ).not.toBeNull();

    // And the failed open created nothing.
    expect(
      fs.existsSync(absentDatabase.databasePath),
      'a failed readonly open must not create the database file'
    ).toBe(false);
  });
});
