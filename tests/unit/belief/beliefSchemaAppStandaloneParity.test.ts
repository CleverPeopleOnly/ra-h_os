/**
 * App/standalone schema parity for the belief engine.
 *
 * Why this file exists: the app (src/) and the standalone MCP server
 * (apps/mcp-server-standalone/) each own a copy of the belief schema, and
 * three real defects in this project were the two copies disagreeing in ways
 * no single-sided unit test could see. So these tests run BOTH sides against
 * one database file, in both orders:
 *
 *   1. standalone init-db creates the file, then the app's belief writes run
 *      in it — proving the standalone path produces every column the app
 *      reads and writes (the four display belief columns, including
 *      belief_credence_is_fixed and belief_uncertainty) and none of the
 *      deleted ones (belief_source_trust, the evidence masses). The app's
 *      writes are a human-asserted fixed credence and samai's display write —
 *      the engine left this fork in the display-belief-door-writable slice,
 *      so the engine-driven half of this test became a non-engine write,
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
  // created must be one the APP's belief writes can run in without touching
  // the schema itself. Reshaped in the display-belief-door-writable slice
  // from an engine-driven recompute to the two writes that remain: a fixed
  // credence asserted through the app reads back intact, and samai's display
  // write lands all four display belief columns on a non-fixed claim.
  it('the app belief writes run in a database created by standalone init-db', async () => {
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

    // The app's display write grades the non-fixed claim: a plain column
    // write of the four-column display surface, no engine anywhere.
    const { writeDisplayBelief } = await import('@/services/belief/beliefDisplayWrite');
    const displayWriteOutcome = writeDisplayBelief(claimNodeId, {
      beliefCredence: 0.31,
      beliefUncertainty: 0.42,
      beliefComputedAt: '2026-08-06T09:00:00.000Z',
    });
    expect(displayWriteOutcome.outcome).toBe('written');
    if (displayWriteOutcome.outcome === 'written') {
      expect(Number(displayWriteOutcome.storedRow.belief_credence)).toBeCloseTo(0.31, 10);
      expect(Number(displayWriteOutcome.storedRow.belief_uncertainty)).toBeCloseTo(0.42, 10);
      expect(displayWriteOutcome.storedRow.belief_computed_at).toBe('2026-08-06T09:00:00.000Z');
      expect(displayWriteOutcome.storedRow.belief_credence_is_fixed).toBe(0);
    }
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
        const standaloneNodeColumnNames = readColumnNamesDirectly(targetDbPath, 'nodes');
        expect(standaloneNodeColumnNames).toContain('belief_credence_is_fixed');
        expect(standaloneNodeColumnNames).toContain('belief_uncertainty');
        expect(standaloneNodeColumnNames).not.toContain('belief_evidence_for_mass');
        expect(standaloneNodeColumnNames).not.toContain('belief_evidence_against_mass');
      },
    });

    expect(db.hasTable('belief_source_trust')).toBe(false);
    const appNodeColumnNames = db.readTableColumns('nodes').map(column => column.name);
    expect(appNodeColumnNames).toContain('belief_credence_is_fixed');
    expect(appNodeColumnNames).toContain('belief_uncertainty');
    expect(appNodeColumnNames).not.toContain('belief_evidence_for_mass');
    expect(appNodeColumnNames).not.toContain('belief_evidence_against_mass');
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
      // The trust table stays gone and the display belief columns stay
      // present, with no mass column reappearing.
      expect(readTableNamesDirectly(appCreatedDbPath)).not.toContain('belief_source_trust');
      const preservedNodeColumnNames = readColumnNamesDirectly(appCreatedDbPath, 'nodes');
      expect(preservedNodeColumnNames).toContain('belief_credence_is_fixed');
      expect(preservedNodeColumnNames).toContain('belief_uncertainty');
      expect(preservedNodeColumnNames).not.toContain('belief_evidence_for_mass');
      expect(preservedNodeColumnNames).not.toContain('belief_evidence_against_mass');
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
