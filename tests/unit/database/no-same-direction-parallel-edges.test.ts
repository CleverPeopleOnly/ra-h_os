/**
 * FAILING-FIRST tests for the no-same-direction-parallel-edges rule at the
 * DATABASE FILE level: two same-direction parallel edges between two nodes
 * must not exist; bidirectional (one each way) is fine.
 *
 * THE FEATURE. Enforcement lives in a UNIQUE index on
 * edges(from_node_id, to_node_id), stored in the database file itself — so it
 * runs after the classifier's direction inference by construction (the INSERT
 * is the final step) and covers EVERY connection, including the standalone
 * stdio server, which opens the file directly and runs no app code. The
 * migration for legacy databases collapses same-slot duplicate rows to the
 * lowest-id row per slot BEFORE creating the index, and those dedup deletes
 * run through the slice-2 journal triggers (trg_graph_events_edge_delete), so
 * graph_events records each one.
 *
 * SEAM (same as tests/unit/journal/graph-event-journal-triggers.test.ts): a
 * fresh temp-file database per test via tempBeliefDatabase — it pins
 * SQLITE_DB_PATH to a temp file before the sqlite client loads, runs the real
 * ensure-schema path, and verifies the client landed on the temp file.
 * Nothing here ever touches the real database under ~/Library.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from '../belief/helpers/tempBeliefDatabase';

// The temp-file database each test runs against; fresh per test.
let tempDb: TempBeliefDatabase;

beforeEach(async () => {
  tempDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempDb.close();
});

// One row of "PRAGMA index_list(edges)": every index on the edges table, with
// its uniqueness flag (1 = UNIQUE).
interface EdgesIndexListRow {
  name: string;
  unique: number;
}

// One row of "PRAGMA index_info(<index>)": a column the index covers, with its
// position inside the index (seqno 0 is the leading column).
interface EdgesIndexColumnRow {
  seqno: number;
  name: string;
}

// Find the UNIQUE index on edges that covers exactly (from_node_id,
// to_node_id) in that order — the direction-slot constraint under test.
// Returns undefined when no such index exists, which is the red today.
function findSameDirectionSlotUniqueIndex(
  databaseContext: TempBeliefDatabase
): EdgesIndexListRow | undefined {
  const edgesIndexes = databaseContext.sqlite
    .prepare('PRAGMA index_list(edges)')
    .all() as EdgesIndexListRow[];
  return edgesIndexes.find((indexRow) => {
    if (indexRow.unique !== 1) return false;
    const indexedColumns = databaseContext.sqlite
      .prepare(`PRAGMA index_info(${indexRow.name})`)
      .all() as EdgesIndexColumnRow[];
    const columnNamesInIndexOrder = [...indexedColumns]
      .sort((a, b) => a.seqno - b.seqno)
      .map((columnRow) => columnRow.name);
    return (
      columnNamesInIndexOrder.length === 2 &&
      columnNamesInIndexOrder[0] === 'from_node_id' &&
      columnNamesInIndexOrder[1] === 'to_node_id'
    );
  });
}

// Count the stored rows occupying one exact direction slot, straight from
// SQLite — the raw fact every parallel-edge assertion rests on.
function countStoredEdgeRowsInSlot(
  databaseContext: TempBeliefDatabase,
  fromNodeId: number,
  toNodeId: number
): number {
  const countRow = databaseContext.sqlite
    .prepare(
      'SELECT COUNT(*) AS slot_row_count FROM edges WHERE from_node_id = ? AND to_node_id = ?'
    )
    .get(fromNodeId, toNodeId) as { slot_row_count: number };
  return countRow.slot_row_count;
}

// Insert one raw edges row into the given slot through the ACTIVE client and
// return its id — the direct write the legacy-database simulation uses to lay
// down same-slot duplicates once the unique index is out of the way.
function insertRawEdgeRowIntoSlot(
  databaseContext: TempBeliefDatabase,
  fromNodeId: number,
  toNodeId: number
): number {
  const insertResult = databaseContext.sqlite
    .prepare(
      `INSERT INTO edges (from_node_id, to_node_id, source, explanation)
       VALUES (?, ?, 'user', 'legacy same-slot duplicate row')`
    )
    .run(fromNodeId, toNodeId);
  return Number(insertResult.lastInsertRowid);
}

// Lay a legacy database's same-slot duplicates down in the open temp file:
// drop the unique slot index if the ensure created one (a true legacy file
// predates it), then insert three rows into the one A→B slot. Returns the
// three row ids, insertion order. Today the drop is a no-op (no index exists
// yet), which is exactly the legacy state.
function simulateLegacySameSlotDuplicates(
  databaseContext: TempBeliefDatabase,
  fromNodeId: number,
  toNodeId: number
): number[] {
  const slotUniqueIndex = findSameDirectionSlotUniqueIndex(databaseContext);
  if (slotUniqueIndex) {
    databaseContext.sqlite.prepare(`DROP INDEX ${slotUniqueIndex.name}`).run();
  }
  return [
    insertRawEdgeRowIntoSlot(databaseContext, fromNodeId, toNodeId),
    insertRawEdgeRowIntoSlot(databaseContext, fromNodeId, toNodeId),
    insertRawEdgeRowIntoSlot(databaseContext, fromNodeId, toNodeId),
  ];
}

// One edge_deleted row of graph_events as these tests read it: which edge died
// and the ends it had.
interface EdgeDeletedJournalRow {
  edge_id: number | null;
  from_node_id: number | null;
  to_node_id: number | null;
}

// Read every edge_deleted journal row, oldest first — the record the dedup
// deletes must leave behind.
function readEdgeDeletedJournalRows(
  databaseContext: TempBeliefDatabase
): EdgeDeletedJournalRow[] {
  return databaseContext.sqlite
    .prepare(
      `SELECT edge_id, from_node_id, to_node_id FROM graph_events
       WHERE event_type = 'edge_deleted' ORDER BY id ASC`
    )
    .all() as EdgeDeletedJournalRow[];
}

describe('the UNIQUE direction-slot index on edges(from_node_id, to_node_id)', () => {
  // The constraint itself must exist in a fresh database: a UNIQUE index
  // covering exactly (from_node_id, to_node_id), in that order — one row per
  // direction slot, enforced by the file, not by any caller's guard.
  it('a fresh database has a UNIQUE index covering exactly (from_node_id, to_node_id) in that order', () => {
    const slotUniqueIndex = findSameDirectionSlotUniqueIndex(tempDb);
    expect(
      slotUniqueIndex,
      'edges must carry a UNIQUE index on exactly (from_node_id, to_node_id)'
    ).toBeDefined();
  });

  // THE POINT OF AN INDEX over app-code guards: the standalone stdio server
  // opens the database file directly with better-sqlite3, sets no pragmas and
  // runs none of the app's services. Its INSERT into an occupied slot must be
  // refused by the FILE with a constraint error, leaving the one stored row.
  it('a raw pragma-less second connection is refused a same-slot duplicate INSERT by the file itself', () => {
    const claimNodeAId = tempDb.insertNodeFixture({ title: 'claim node A, the derived end' });
    const sourceNodeBId = tempDb.insertNodeFixture({ title: 'source node B the claim derives from' });
    tempDb.insertNonEvidenceEdgeFixture({ fromNodeId: claimNodeAId, toNodeId: sourceNodeBId });

    // The stand-in for the stdio server: a raw better-sqlite3 handle on the
    // same file, with NO pragmas set.
    const pragmaLessConnection = new Database(tempDb.tempDbPath);
    // What the duplicate INSERT threw, if anything — captured rather than
    // asserted inline so the error's SQLite code can be inspected.
    let duplicateInsertError: unknown;
    try {
      pragmaLessConnection
        .prepare(
          `INSERT INTO edges (from_node_id, to_node_id, source, explanation)
           VALUES (?, ?, 'user', 'second row aimed at the occupied slot')`
        )
        .run(claimNodeAId, sourceNodeBId);
    } catch (thrownByInsert) {
      duplicateInsertError = thrownByInsert;
    } finally {
      pragmaLessConnection.close();
    }

    expect(
      duplicateInsertError,
      'the same-slot INSERT must throw a SqliteError instead of storing a second row'
    ).toBeDefined();
    // A UNIQUE-index violation surfaces as a SQLITE_CONSTRAINT code on the
    // thrown better-sqlite3 SqliteError.
    expect(String((duplicateInsertError as { code?: string }).code)).toContain(
      'SQLITE_CONSTRAINT'
    );
    // Exactly the one original row remains in the slot.
    expect(countStoredEdgeRowsInSlot(tempDb, claimNodeAId, sourceNodeBId)).toBe(1);
  });

  // Bidirectional is fine by design: A→B and B→A are two different direction
  // slots, so the index must let both exist, one row each. This is the
  // file-level twin of the route pin's per-direction case 1b.
  it('bidirectional edges coexist: A→B and B→A both insert, one row per direction slot', () => {
    const claimNodeAId = tempDb.insertNodeFixture({ title: 'claim node A' });
    const sourceNodeBId = tempDb.insertNodeFixture({ title: 'source node B' });

    tempDb.insertNonEvidenceEdgeFixture({ fromNodeId: claimNodeAId, toNodeId: sourceNodeBId });
    tempDb.insertNonEvidenceEdgeFixture({ fromNodeId: sourceNodeBId, toNodeId: claimNodeAId });

    expect(countStoredEdgeRowsInSlot(tempDb, claimNodeAId, sourceNodeBId)).toBe(1);
    expect(countStoredEdgeRowsInSlot(tempDb, sourceNodeBId, claimNodeAId)).toBe(1);
  });
});

describe('the legacy-database dedup migration', () => {
  // A database written before this slice can already hold same-slot parallel
  // rows, and CREATE UNIQUE INDEX fails on such data — so the ensure sequence
  // must first collapse each slot to its LOWEST-id row, then create the index.
  // Exercised the way a real legacy file meets the migration: duplicates laid
  // down, the file closed, then reopened so the ensure runs over it.
  it('reopening a database with same-slot duplicates keeps only the lowest-id row and recreates the index', async () => {
    const claimNodeAId = tempDb.insertNodeFixture({ title: 'claim node A, the derived end' });
    const sourceNodeBId = tempDb.insertNodeFixture({ title: 'source node B the claim derives from' });
    const duplicateRowIds = simulateLegacySameSlotDuplicates(tempDb, claimNodeAId, sourceNodeBId);

    // PRECONDITION guard: the legacy state is real — three rows share the
    // slot before the migration runs. Without this the dedup assertions below
    // could pass vacuously against a slot that never held duplicates.
    expect(countStoredEdgeRowsInSlot(tempDb, claimNodeAId, sourceNodeBId)).toBe(3);

    // Close and reopen the SAME file: the ensure sequence runs again, and the
    // dedup-then-index migration is part of it.
    await tempDb.reopenBeliefDatabase();

    // One survivor per slot, and it is the LOWEST id.
    expect(countStoredEdgeRowsInSlot(tempDb, claimNodeAId, sourceNodeBId)).toBe(1);
    const survivingRow = tempDb.sqlite
      .prepare('SELECT id FROM edges WHERE from_node_id = ? AND to_node_id = ?')
      .get(claimNodeAId, sourceNodeBId) as { id: number };
    expect(survivingRow.id).toBe(Math.min(...duplicateRowIds));

    // The constraint stands again for everything written after the migration.
    expect(
      findSameDirectionSlotUniqueIndex(tempDb),
      'the UNIQUE (from_node_id, to_node_id) index must exist after the migration'
    ).toBeDefined();
  });

  // The dedup deletes are real deletes and must run through the slice-2
  // journal triggers (trg_graph_events_edge_delete): a consumer mirroring the
  // graph learns of each collapsed duplicate the same way it learns of any
  // other edge death — an edge_deleted row carrying the dead row's id and ends.
  it('each dedup-deleted duplicate leaves an edge_deleted row in graph_events', async () => {
    const claimNodeAId = tempDb.insertNodeFixture({ title: 'claim node A, the derived end' });
    const sourceNodeBId = tempDb.insertNodeFixture({ title: 'source node B the claim derives from' });
    const duplicateRowIds = simulateLegacySameSlotDuplicates(tempDb, claimNodeAId, sourceNodeBId);

    // PRECONDITION guards against a vacuous green: the duplicates really
    // exist, the journal table (slice 2) really exists, and it holds no
    // edge_deleted rows yet — so every row found after the reopen was written
    // by the dedup deletes and nothing else.
    expect(countStoredEdgeRowsInSlot(tempDb, claimNodeAId, sourceNodeBId)).toBe(3);
    expect(
      tempDb.hasTable('graph_events'),
      'graph_events must exist before the dedup for its journalling to mean anything'
    ).toBe(true);
    expect(readEdgeDeletedJournalRows(tempDb)).toHaveLength(0);

    await tempDb.reopenBeliefDatabase();

    // The two non-surviving duplicates (everything but the lowest id), each
    // journalled with its id and the slot's ends.
    const survivingRowId = Math.min(...duplicateRowIds);
    const dedupDeletedRowIds = duplicateRowIds.filter((rowId) => rowId !== survivingRowId);
    const edgeDeletedJournalRows = readEdgeDeletedJournalRows(tempDb);
    expect(edgeDeletedJournalRows).toHaveLength(dedupDeletedRowIds.length);
    for (const dedupDeletedRowId of dedupDeletedRowIds) {
      expect(
        edgeDeletedJournalRows,
        `duplicate row ${dedupDeletedRowId} must have its own edge_deleted journal row`
      ).toContainEqual({
        edge_id: dedupDeletedRowId,
        from_node_id: claimNodeAId,
        to_node_id: sourceNodeBId,
      });
    }
  });
});
