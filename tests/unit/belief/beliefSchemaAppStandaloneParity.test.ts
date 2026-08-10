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
 *      grades a real claim in it — proving the standalone path produces every
 *      column the engine reads (including belief_credence_is_fixed) and none
 *      of the deleted ones (belief_source_trust),
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
  // Direction 1, the end-to-end proof: a database the STANDALONE path created
  // must be one the APP's belief engine can grade in without touching the
  // schema itself. A fixed expert at credence 0.9 supports a claim with
  // support 0.8, and the claim grades on the resulting 0.72 contribution.
  it('the app belief engine grades a claim in a database created by standalone init-db', async () => {
    db = await openTempBeliefDatabase({
      prepareExistingDbFile: runStandaloneInitDb,
    });

    const expertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'human expert asserted through the standalone-created database',
      beliefCredence: 0.9,
    });
    const claimNodeId = db.insertNodeFixture({ title: 'claim the expert supports' });
    // Canon direction: the claim derives from the expert (claim→expert).
    const expertEvidenceEdgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId: expertNodeId,
      support: 0.8,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    // 0.8 × 0.9 = 0.72, graded by the pinned v2 projection: 0.72/2.72
    // (docs/belief-model-subjective-logic.md §3, the 0.72-contribution
    // arithmetic of §2 — EDITED from the v1 exponential anchor).
    expect(Number(db.readEvidenceStamp(expertEvidenceEdgeId))).toBeCloseTo(0.72, 10);
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      0.72 / 2.72,
      10
    );
    // The expert's asserted credence survived the app opening the file.
    expect(db.readNodeBeliefCredenceIsFixed(expertNodeId)).toBe(1);
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
  // the evidence keeps its support and stamp, no trust table reappears, and
  // the traversal indexes survive.
  it('standalone init-db over an app-created database preserves the belief columns, rows and indexes', async () => {
    db = await openTempBeliefDatabase();
    const expertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'human expert asserted through the app',
      beliefCredence: 0.9,
    });
    const claimNodeId = db.insertNodeFixture({ title: 'claim the expert supports' });
    // Canon direction: the claim derives from the expert (claim→expert).
    const expertEvidenceEdgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId: expertNodeId,
      support: 0.8,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
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

      // The asserted expert is untouched.
      const preservedExpertRow = directDb
        .prepare('SELECT belief_credence, belief_credence_is_fixed FROM nodes WHERE id = ?')
        .get(expertNodeId) as { belief_credence: number; belief_credence_is_fixed: number };
      expect(Number(preservedExpertRow.belief_credence)).toBeCloseTo(0.9, 10);
      expect(preservedExpertRow.belief_credence_is_fixed).toBe(1);

      // The graded claim and its stamped evidence edge are untouched.
      const preservedClaimRow = directDb
        .prepare('SELECT belief_credence FROM nodes WHERE id = ?')
        .get(claimNodeId) as { belief_credence: number };
      // EDITED per spec §2/§3: the v2 projection anchor 0.72/2.72 replaces
      // the v1 exponential 1 − e^(−0.72).
      expect(Number(preservedClaimRow.belief_credence)).toBeCloseTo(0.72 / 2.72, 10);
      const preservedEvidenceRow = directDb
        .prepare(
          'SELECT belief_evidence_support, belief_evidence_contribution FROM edges WHERE id = ?'
        )
        .get(expertEvidenceEdgeId) as {
        belief_evidence_support: number;
        belief_evidence_contribution: number;
      };
      expect(Number(preservedEvidenceRow.belief_evidence_support)).toBeCloseTo(0.8, 10);
      expect(Number(preservedEvidenceRow.belief_evidence_contribution)).toBeCloseTo(0.72, 10);

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
