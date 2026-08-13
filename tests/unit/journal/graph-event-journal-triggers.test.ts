/**
 * FAILING-FIRST tests for the trigger-written graph-event journal in the
 * SQLite database itself.
 *
 * THE FEATURE. Deletes and re-orientations of graph rows currently vanish
 * without trace: a consumer that mirrored an edge learns nothing when that
 * edge is deleted or re-pointed. This slice adds a journal the DATABASE FILE
 * writes for itself:
 *  - a dedicated `graph_events` table (NOT the existing `logs` table) with
 *    columns id, event_type ('edge_deleted' | 'node_deleted' |
 *    'edge_reoriented'), edge_id, node_id, from_node_id, to_node_id,
 *    old_from_node_id, old_to_node_id, occurred_at;
 *  - a single-row ack-cursor table `graph_events_ack`
 *    (id INTEGER PRIMARY KEY CHECK (id = 1), acked_event_id NOT NULL
 *    DEFAULT 0), seeded with its one row when the schema is ensured;
 *  - AFTER DELETE / AFTER UPDATE OF triggers on edges and nodes, stored IN
 *    THE FILE — so a write from ANY connection journals, including the
 *    standalone stdio server, which opens the file directly and never runs
 *    app code.
 *
 * CASCADE — the design question this file answers empirically. The app
 * connection sets foreign_keys = ON and the edges table declares
 * ON DELETE CASCADE on both node ends, so deleting a node deletes its edges
 * as a foreign-key action. Verified against this repo's better-sqlite3
 * (SQLite 3.51.2) with a scratch script before writing this file: an
 * FK-cascaded edge deletion DOES fire the edge's AFTER DELETE trigger, with
 * recursive_triggers at its default OFF (the cascade fired edge_deleted then
 * node_deleted). The cascade test below asserts that verified behaviour.
 *
 * SEAM. The shared temp-database harness
 * (tests/unit/belief/helpers/tempBeliefDatabase.ts): it pins SQLITE_DB_PATH
 * to a temp file BEFORE the sqlite client module loads, opens the file
 * through the real SQLiteClient (so the real ensure-schema path runs), and
 * verifies the client landed on the temp file. Nothing here ever touches
 * the real database under ~/Library.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from '../belief/helpers/tempBeliefDatabase';

// The temp-file database each test runs against; fresh per test.
let tempDb: TempBeliefDatabase;

// One journal row as stored in graph_events. Columns that do not apply to an
// event type are NULL (e.g. node_id on an edge_deleted row).
interface GraphEventRow {
  id: number;
  event_type: 'edge_deleted' | 'node_deleted' | 'edge_reoriented';
  edge_id: number | null;
  node_id: number | null;
  from_node_id: number | null;
  to_node_id: number | null;
  old_from_node_id: number | null;
  old_to_node_id: number | null;
  occurred_at: string;
}

// The one row of the ack-cursor table graph_events_ack.
interface GraphEventsAckRow {
  id: number;
  acked_event_id: number;
}

// Read every journal row, oldest first, straight from the table under test.
function readGraphEventRows(): GraphEventRow[] {
  return tempDb.sqlite
    .prepare(
      `SELECT id, event_type, edge_id, node_id, from_node_id, to_node_id,
              old_from_node_id, old_to_node_id, occurred_at
       FROM graph_events ORDER BY id ASC`
    )
    .all() as GraphEventRow[];
}

// Read every row of the single-row ack-cursor table (there must only ever be
// one, which is exactly what the tests below check).
function readGraphEventsAckRows(): GraphEventsAckRow[] {
  return tempDb.sqlite
    .prepare('SELECT id, acked_event_id FROM graph_events_ack ORDER BY id ASC')
    .all() as GraphEventsAckRow[];
}

// Seed two nodes joined by one edge and return all three ids — the smallest
// graph every delete/re-orient test below starts from.
function seedTwoNodesJoinedByOneEdge(): {
  fromNodeId: number;
  toNodeId: number;
  edgeId: number;
} {
  const fromNodeId = tempDb.insertNodeFixture({ title: 'Journal test from-node' });
  const toNodeId = tempDb.insertNodeFixture({ title: 'Journal test to-node' });
  const edgeId = tempDb.insertNonEvidenceEdgeFixture({ fromNodeId, toNodeId });
  return { fromNodeId, toNodeId, edgeId };
}

// Guard shared by the two "writes NO journal row" tests: without it, a
// missing graph_events table would make "no rows found" vacuously green (the
// SELECT would need the table; this assertion states the intent and fails
// RED today, before the table exists).
function assertGraphEventsTableExists(): void {
  expect(
    tempDb.hasTable('graph_events'),
    'graph_events must exist before a no-journal-row assertion means anything'
  ).toBe(true);
}

beforeEach(async () => {
  tempDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempDb.close();
});

describe('graph-event journal schema', () => {
  // The two tables the slice introduces must come into being when the schema
  // is ensured, and the ack cursor must start with its one row at 0 — the
  // "nothing acknowledged yet" position.
  it('ensuring the schema creates graph_events and a graph_events_ack seeded with one row at 0', () => {
    expect(tempDb.hasTable('graph_events'), 'graph_events table must exist').toBe(true);
    expect(tempDb.hasTable('graph_events_ack'), 'graph_events_ack table must exist').toBe(true);

    // Exactly one cursor row, id pinned to 1 by its CHECK, cursor at 0.
    expect(readGraphEventsAckRows()).toEqual([{ id: 1, acked_event_id: 0 }]);
  });

  // Re-running the ensure over its own output (close, reopen the same file)
  // must neither error nor disturb the single cursor row. The cursor's VALUE
  // must survive too: a re-seed that reset it to 0 would make every consumer
  // re-receive everything it had already acknowledged.
  it('ensuring the schema twice neither errors nor duplicates nor resets the cursor row', async () => {
    // Move the cursor off its seed value so a destructive re-seed is visible.
    tempDb.sqlite.prepare('UPDATE graph_events_ack SET acked_event_id = 5 WHERE id = 1').run();

    // Close and reopen the SAME file: the ensure runs a second time.
    await tempDb.reopenBeliefDatabase();

    expect(readGraphEventsAckRows()).toEqual([{ id: 1, acked_event_id: 5 }]);
  });
});

describe('graph-event journal triggers on deletes', () => {
  // The headline delete case: removing an edge must leave exactly one
  // edge_deleted row carrying the dead edge's id and both of its ends —
  // everything a consumer needs to drop its mirror of the edge.
  it('deleting an edge writes exactly one edge_deleted row carrying its id and both ends', () => {
    const { fromNodeId, toNodeId, edgeId } = seedTwoNodesJoinedByOneEdge();

    tempDb.sqlite.prepare('DELETE FROM edges WHERE id = ?').run(edgeId);

    const graphEventRows = readGraphEventRows();
    expect(graphEventRows).toHaveLength(1);
    expect(graphEventRows[0]).toMatchObject({
      event_type: 'edge_deleted',
      edge_id: edgeId,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      // Columns that belong to the other event types stay NULL.
      node_id: null,
      old_from_node_id: null,
      old_to_node_id: null,
    });
    // Every journal row is stamped with when it happened.
    expect(typeof graphEventRows[0].occurred_at).toBe('string');
    expect(graphEventRows[0].occurred_at.length).toBeGreaterThan(0);
  });

  // A node with no edges: deleting it must journal exactly one node_deleted
  // row naming the node, and nothing else.
  it('deleting an edgeless node writes exactly one node_deleted row carrying its id', () => {
    const lonelyNodeId = tempDb.insertNodeFixture({ title: 'Journal test edgeless node' });

    tempDb.sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(lonelyNodeId);

    const graphEventRows = readGraphEventRows();
    expect(graphEventRows).toHaveLength(1);
    expect(graphEventRows[0]).toMatchObject({
      event_type: 'node_deleted',
      node_id: lonelyNodeId,
      // Columns that belong to the edge event types stay NULL.
      edge_id: null,
      from_node_id: null,
      to_node_id: null,
      old_from_node_id: null,
      old_to_node_id: null,
    });
  });

  // THE CASCADE ANSWER, asserted. Deleting a node on the app's
  // foreign_keys=ON connection cascade-deletes its edges (ON DELETE CASCADE
  // on both ends of the edges table). EMPIRICALLY VERIFIED against this
  // repo's better-sqlite3 (SQLite 3.51.2, recursive_triggers at its default
  // OFF) before this file was written: the FK-cascaded edge deletion DOES
  // fire the edge's AFTER DELETE trigger. So the journal must hold BOTH rows
  // — the cascaded edge's edge_deleted AND the node's node_deleted — and a
  // consumer never has to infer edge deaths from node deaths.
  it('cascade: deleting a node with an edge journals BOTH the node_deleted and the cascaded edge_deleted', () => {
    const { fromNodeId, toNodeId, edgeId } = seedTwoNodesJoinedByOneEdge();

    tempDb.sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(fromNodeId);

    // The cascade really removed the edge (this is the FK doing its work).
    const survivingEdgeCount = (
      tempDb.sqlite.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
    ).n;
    expect(survivingEdgeCount).toBe(0);

    const graphEventRows = readGraphEventRows();
    // Exactly two journal rows: one per dead row, nothing extra.
    expect(graphEventRows).toHaveLength(2);

    // The node's own death is journalled…
    const nodeDeletedRow = graphEventRows.find(row => row.event_type === 'node_deleted');
    expect(nodeDeletedRow, 'the deleted node must have a node_deleted row').toBeDefined();
    expect(nodeDeletedRow).toMatchObject({ node_id: fromNodeId });

    // …and (the empirical CASCADE answer) so is the cascaded edge's.
    const cascadedEdgeDeletedRow = graphEventRows.find(row => row.event_type === 'edge_deleted');
    expect(
      cascadedEdgeDeletedRow,
      'the FK-cascaded edge deletion fires the edge trigger (verified on SQLite 3.51.2), so an edge_deleted row must be present'
    ).toBeDefined();
    expect(cascadedEdgeDeletedRow).toMatchObject({
      edge_id: edgeId,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
    });
  });
});

describe('graph-event journal trigger on edge re-orientation', () => {
  // Re-pointing an edge must journal exactly one edge_reoriented row that
  // carries BOTH the ends the edge had (old_from_node_id / old_to_node_id)
  // and the ends it has now (from_node_id / to_node_id) — a consumer needs
  // the old pair to find its mirror and the new pair to fix it.
  it('an UPDATE that changes the ends writes exactly one edge_reoriented row with old and new ends', () => {
    const { fromNodeId, toNodeId, edgeId } = seedTwoNodesJoinedByOneEdge();

    // Swap the ends in one UPDATE: the classic re-orientation RA-H's
    // classifier performs.
    tempDb.sqlite
      .prepare('UPDATE edges SET from_node_id = ?, to_node_id = ? WHERE id = ?')
      .run(toNodeId, fromNodeId, edgeId);

    const graphEventRows = readGraphEventRows();
    expect(graphEventRows).toHaveLength(1);
    expect(graphEventRows[0]).toMatchObject({
      event_type: 'edge_reoriented',
      edge_id: edgeId,
      // The ends the edge HAD…
      old_from_node_id: fromNodeId,
      old_to_node_id: toNodeId,
      // …and the ends it has NOW.
      from_node_id: toNodeId,
      to_node_id: fromNodeId,
      node_id: null,
    });
  });

  // SQLite fires AFTER UPDATE OF whenever the column is merely MENTIONED in
  // SET, changed or not — so the trigger needs a WHEN clause comparing OLD
  // to NEW, and this test is what pins it: a SET that restates the same ends
  // must journal nothing.
  it('an UPDATE whose SET restates the same ends writes NO journal row', () => {
    const { fromNodeId, toNodeId, edgeId } = seedTwoNodesJoinedByOneEdge();

    // Red-today guard: "no rows" is only meaningful once the table exists.
    assertGraphEventsTableExists();

    // Both end columns mentioned in SET, neither value changed.
    tempDb.sqlite
      .prepare('UPDATE edges SET from_node_id = ?, to_node_id = ? WHERE id = ?')
      .run(fromNodeId, toNodeId, edgeId);

    expect(readGraphEventRows()).toHaveLength(0);
  });

  // An update that never touches the end columns — rewriting the human
  // explanation — is not a graph event at all and must journal nothing.
  it('an UPDATE of explanation only writes NO journal row', () => {
    const { edgeId } = seedTwoNodesJoinedByOneEdge();

    // Red-today guard: "no rows" is only meaningful once the table exists.
    assertGraphEventsTableExists();

    tempDb.sqlite
      .prepare('UPDATE edges SET explanation = ? WHERE id = ?')
      .run('A rewritten reason for why the connection exists.', edgeId);

    expect(readGraphEventRows()).toHaveLength(0);
  });
});

describe('graph-event journal triggers live in the database file', () => {
  // THE POINT OF TRIGGERS over app code: the standalone stdio server opens
  // the database file directly with better-sqlite3 and runs none of the
  // app's services. A second, pragma-less connection — exactly what that
  // server is — deletes an edge, and the journal row must still appear,
  // because the triggers are stored in the file, not in any process.
  it('an edge deleted through a second pragma-less connection is still journalled', () => {
    const { fromNodeId, toNodeId, edgeId } = seedTwoNodesJoinedByOneEdge();

    // The stand-in for the stdio server: a raw better-sqlite3 handle on the
    // same file, with NO pragmas set.
    const pragmaLessConnection = new Database(tempDb.tempDbPath);
    try {
      pragmaLessConnection.prepare('DELETE FROM edges WHERE id = ?').run(edgeId);
    } finally {
      pragmaLessConnection.close();
    }

    const graphEventRows = readGraphEventRows();
    expect(graphEventRows).toHaveLength(1);
    expect(graphEventRows[0]).toMatchObject({
      event_type: 'edge_deleted',
      edge_id: edgeId,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
    });
  });
});
