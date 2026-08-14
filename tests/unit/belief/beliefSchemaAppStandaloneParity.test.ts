/**
 * App/standalone schema parity for the belief engine.
 *
 * Why this file exists: the app (src/) and the standalone MCP server
 * (apps/mcp-server-standalone/) each own a copy of the belief schema, and
 * three real defects in this project were the two copies disagreeing in ways
 * no single-sided unit test could see. So these tests run BOTH sides against
 * one database file, in both orders:
 *
 *   1. standalone init-db creates the file, then the app's belief engine
 *      runs in it — proving the standalone path produces every column the
 *      engine reads (including belief_credence_is_fixed) and none of the
 *      deleted ones (belief_source_trust). Since the
 *      evidence-leaves-the-edges-table slice the engine's only real grade is
 *      a human-asserted fixed credence: a non-fixed recompute lands
 *      never-assessed,
 *   2. the app creates the file, then standalone init-db runs over it —
 *      proving the standalone path leaves the app's belief columns, its
 *      asserted-credence rows and its indexes alone.
 *
 * SAFETY: every database here is a fresh temp file under the OS tmpdir (see
 * tempBeliefDatabase.ts for the seam that pins SQLITE_DB_PATH), and the
 * spawned init-db process is a short synchronous run that always terminates.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
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

// Absolute path of the standalone server entry point, whose "init-db"
// subcommand owns the standalone copy of the schema.
const standaloneServerEntryPath = path.join(
  process.cwd(),
  'apps',
  'mcp-server-standalone',
  'index.js'
);

// Run the standalone server's init-db subcommand against one database file,
// failing the test with its stderr if it does not exit cleanly.
function runStandaloneInitDb(targetDbPath: string): void {
  const initDbResult = spawnSync(process.execPath, [standaloneServerEntryPath, 'init-db'], {
    cwd: process.cwd(),
    env: { ...process.env, RAH_DB_PATH: targetDbPath },
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(initDbResult.status, `standalone init-db stderr: ${initDbResult.stderr}`).toBe(0);
}

// Column names of one table in a database file, read through an independent
// connection rather than through either side's client.
function readColumnNamesDirectly(targetDbPath: string, tableName: string): string[] {
  const directDb = new Database(targetDbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      directDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
    ).map(column => column.name);
  } finally {
    directDb.close();
  }
}

// Table names in a database file, read through an independent connection.
function readTableNamesDirectly(targetDbPath: string): string[] {
  const directDb = new Database(targetDbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      directDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map(row => row.name);
  } finally {
    directDb.close();
  }
}

describe('app and standalone agree on the belief schema', () => {
  // Direction 1, the end-to-end proof: a database the STANDALONE path
  // created must be one the APP's belief engine can run in without touching
  // the schema itself. In the interim world that means a fixed credence
  // asserted through the app reads back intact, and a recompute of a
  // non-fixed claim lands never-assessed.
  it('the app belief engine runs in a database created by standalone init-db', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: runStandaloneInitDb,
    });

    const expertNodeId = db.insertNodeFixture({
      title: 'human expert asserted through the standalone-created database',
    });
    const claimNodeId = db.insertNodeFixture({ title: 'claim related to the expert' });
    db.insertNonEvidenceEdgeFixture({ fromNodeId: claimNodeId, toNodeId: expertNodeId });

    // The app's fixed-credence door writes into the standalone-created file.
    const { setBeliefFixedCredence } = await import('@/services/belief/beliefFixedCredence');
    setBeliefFixedCredence(expertNodeId, 0.9);
    expect(Number(db.readNodeBelief(expertNodeId).belief_credence)).toBeCloseTo(0.9, 10);
    expect(db.readNodeBeliefCredenceIsFixed(expertNodeId)).toBe(1);

    // The app's engine recomputes the non-fixed claim: never-assessed, the
    // interim world's only outcome for a derived node.
    const { recomputeNodeBelief } = await db.importBeliefService();
    const recomputeResult = await recomputeNodeBelief(claimNodeId);
    expect(recomputeResult.beliefCredence).toBeNull();
    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeNull();
  });

  // Direction 1, the schema half: whatever else it creates, the standalone
  // path must not put back the trust table the app-side migration drops —
  // otherwise every app start would drop it and every standalone init-db
  // would recreate it.
  it('a database created by standalone init-db has no belief_source_trust, before or after app init', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: (targetDbPath: string) => {
        runStandaloneInitDb(targetDbPath);
        // Read the standalone output BEFORE the app client touches it, so a
        // failure here blames the standalone path rather than the app's drop.
        expect(readTableNamesDirectly(targetDbPath)).not.toContain('belief_source_trust');
        expect(readColumnNamesDirectly(targetDbPath, 'nodes')).toContain(
          'belief_credence_is_fixed'
        );
      },
    });

    expect(db.hasTable('belief_source_trust')).toBe(false);
    expect(db.readTableColumns('nodes').map(column => column.name)).toContain(
      'belief_credence_is_fixed'
    );
  });

  // Direction 2: standalone init-db running over a database the APP created
  // must leave the belief state alone — the asserted credence stays asserted,
  // the edge row survives, no trust table reappears, and the traversal
  // indexes survive.
  it('standalone init-db over an app-created database preserves the belief columns, rows and indexes', async () => {
    db = await openTempBeliefDatabase();
    const expertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'human expert asserted through the app',
      beliefCredence: 0.9,
    });
    const claimNodeId = db.insertNodeFixture({ title: 'claim related to the expert' });
    const relationshipEdgeId = db.insertNonEvidenceEdgeFixture({
      fromNodeId: claimNodeId,
      toNodeId: expertNodeId,
    });
    const appCreatedDbPath = db.tempDbPath;

    // Hand the file over: close the app client, then run the standalone
    // schema pass over exactly the same file.
    db.sqlite.close();
    runStandaloneInitDb(appCreatedDbPath);

    const directDb = new Database(appCreatedDbPath, { readonly: true, fileMustExist: true });
    try {
      // The trust table stays gone and the fixed-credence flag stays present.
      expect(readTableNamesDirectly(appCreatedDbPath)).not.toContain('belief_source_trust');
      expect(readColumnNamesDirectly(appCreatedDbPath, 'nodes')).toContain(
        'belief_credence_is_fixed'
      );
      // And no evidence column reappears on edges.
      const edgeColumnNames = readColumnNamesDirectly(appCreatedDbPath, 'edges');
      expect(edgeColumnNames).not.toContain('belief_evidence_support');
      expect(edgeColumnNames).not.toContain('belief_evidence_contribution');

      // The asserted expert is untouched.
      const preservedExpertRow = directDb
        .prepare('SELECT belief_credence, belief_credence_is_fixed FROM nodes WHERE id = ?')
        .get(expertNodeId) as { belief_credence: number; belief_credence_is_fixed: number };
      expect(Number(preservedExpertRow.belief_credence)).toBeCloseTo(0.9, 10);
      expect(preservedExpertRow.belief_credence_is_fixed).toBe(1);

      // The relationship edge row is untouched.
      const preservedEdgeRow = directDb
        .prepare('SELECT from_node_id, to_node_id FROM edges WHERE id = ?')
        .get(relationshipEdgeId) as { from_node_id: number; to_node_id: number };
      expect(preservedEdgeRow.from_node_id).toBe(claimNodeId);
      expect(preservedEdgeRow.to_node_id).toBe(expertNodeId);

      // The traversal indexes the app created are still there: the standalone
      // pass must not rebuild the edges table out from under them.
      const survivingEdgeIndexNames = (
        directDb
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'")
          .all() as Array<{ name: string }>
      ).map(indexRow => indexRow.name);
      expect(survivingEdgeIndexNames).toContain('idx_edges_from');
      expect(survivingEdgeIndexNames).toContain('idx_edges_to');
    } finally {
      directDb.close();
    }
  });
});
