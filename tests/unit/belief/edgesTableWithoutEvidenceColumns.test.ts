/**
 * FAILING-FIRST schema tests for the evidence-leaves-the-edges-table slice:
 * belief evidence no longer lives on edges AT ALL.
 *
 * Belief evidence moved out of this fork into samai's own store, so an edge
 * is now a plain knowledge-graph relationship. This file pins the storage
 * half of that:
 *
 *  - a FRESH database's edges table is born WITHOUT belief_evidence_support
 *    and WITHOUT belief_evidence_contribution — the DDL in
 *    src/services/database/sqlite-client.ts no longer names either column,
 *  - a LEGACY database whose edges table still carries both columns (with
 *    populated values) has them DROPPED by a guarded migration on open, while
 *    every OTHER edge field survives byte-for-byte: id, ends, source,
 *    created_at, context, explanation,
 *  - the survivors of the slice survive the migration: the graph-event
 *    journal triggers are still present and still FIRE (deleting an edge
 *    writes an edge_deleted journal row), and the UNIQUE
 *    idx_edges_direction_slot index is still there,
 *  - reopening the migrated file is a no-op: the guarded migration finds
 *    nothing left to drop and the rows are untouched.
 *
 * Every database in this file is a fresh temp file under the OS tmpdir —
 * see tempBeliefDatabase.ts for the safety seam.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// The two columns this slice deletes from the edges table.
const removedEdgeEvidenceColumnNames = [
  'belief_evidence_support',
  'belief_evidence_contribution',
];

// The database context under test; opened per test, closed after each.
let tempDb: TempBeliefDatabase | undefined;

afterEach(() => {
  tempDb?.close();
  tempDb = undefined;
});

// Column names of the edges table as the OPEN client sees them.
function readEdgeTableColumnNames(context: TempBeliefDatabase): string[] {
  return context.readTableColumns('edges').map(column => column.name);
}

// One legacy edges row's NON-evidence fields, read back for the
// rows-survive-the-migration pins. Evidence columns are deliberately not
// selected here: after the migration they do not exist to select.
interface SurvivingEdgeRowFields {
  id: number;
  from_node_id: number;
  to_node_id: number;
  source: string | null;
  created_at: string | null;
  context: string | null;
  explanation: string | null;
}

// Read every edge row's surviving fields, ordered by id, through the client.
function readSurvivingEdgeRowFields(context: TempBeliefDatabase): SurvivingEdgeRowFields[] {
  return context.sqlite
    .prepare(
      `SELECT id, from_node_id, to_node_id, source, created_at, context, explanation
       FROM edges ORDER BY id ASC`
    )
    .all() as SurvivingEdgeRowFields[];
}

// True when the named trigger exists in this database.
function hasTrigger(context: TempBeliefDatabase, triggerName: string): boolean {
  const triggerRow = context.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name = ?")
    .get(triggerName) as { name: string } | undefined;
  return triggerRow !== undefined;
}

// Fixed timestamps for the legacy fixture rows, so the survive-the-migration
// comparison is against literal known values rather than "whatever now was".
const LEGACY_EDGE_CREATED_AT = '2026-06-01T00:00:00.000Z';

// The context JSON stored on the legacy evidence edge, kept as one constant
// so the byte-for-byte survival pin compares against the exact stored string.
const LEGACY_EVIDENCE_EDGE_CONTEXT_JSON = JSON.stringify({
  type: 'source_of',
  confidence: 0.9,
  inferred_at: LEGACY_EDGE_CREATED_AT,
  explanation: 'derived from the legacy source node',
  created_via: 'mcp',
});

/**
 * Lay down a LEGACY database file with a raw better-sqlite3 connection: the
 * pre-slice edges shape carrying BOTH evidence columns, two nodes, and two
 * edge rows — one graded evidence edge (support AND contribution populated)
 * and one plain relationship edge. This is the file the SQLiteClient under
 * test must migrate on open.
 */
function createLegacyEvidenceBearingDbFile(targetPath: string): void {
  const legacyDb = new Database(targetPath);
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
      chunk_status TEXT DEFAULT 'not_chunked',
      belief_credence REAL,
      belief_computed_at TEXT,
      belief_credence_is_fixed INTEGER NOT NULL DEFAULT 0,
      belief_evidence_for_mass REAL,
      belief_evidence_against_mass REAL
    );

    CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      from_node_id INTEGER NOT NULL,
      to_node_id INTEGER NOT NULL,
      source TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      context TEXT,
      explanation TEXT,
      belief_evidence_support REAL,
      belief_evidence_contribution REAL,
      FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (to_node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );
  `);

  const insertLegacyNode = legacyDb.prepare(
    'INSERT INTO nodes (id, title, source) VALUES (?, ?, ?)'
  );
  insertLegacyNode.run(1, 'legacy derived node', 'legacy derived node content');
  insertLegacyNode.run(2, 'legacy source node', 'legacy source node content');

  const insertLegacyEdge = legacyDb.prepare(
    `INSERT INTO edges
       (id, from_node_id, to_node_id, source, created_at, context, explanation,
        belief_evidence_support, belief_evidence_contribution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // The graded evidence edge: BOTH evidence values populated, so the drop is
  // proven against real data rather than against two all-NULL columns.
  insertLegacyEdge.run(
    1,
    1,
    2,
    'user',
    LEGACY_EDGE_CREATED_AT,
    LEGACY_EVIDENCE_EDGE_CONTEXT_JSON,
    'derived from the legacy source node',
    0.9,
    0.72
  );
  // The plain relationship edge: evidence columns NULL, everything else set.
  insertLegacyEdge.run(
    2,
    2,
    1,
    'user',
    LEGACY_EDGE_CREATED_AT,
    null,
    'plain legacy relationship edge',
    null,
    null
  );

  legacyDb.close();
}

// The surviving fields both legacy edges must still carry after migration —
// exactly what createLegacyEvidenceBearingDbFile wrote, minus the two
// evidence values that go down with their columns.
const expectedSurvivingLegacyEdgeRows: SurvivingEdgeRowFields[] = [
  {
    id: 1,
    from_node_id: 1,
    to_node_id: 2,
    source: 'user',
    created_at: LEGACY_EDGE_CREATED_AT,
    context: LEGACY_EVIDENCE_EDGE_CONTEXT_JSON,
    explanation: 'derived from the legacy source node',
  },
  {
    id: 2,
    from_node_id: 2,
    to_node_id: 1,
    source: 'user',
    created_at: LEGACY_EDGE_CREATED_AT,
    context: null,
    explanation: 'plain legacy relationship edge',
  },
];

describe('edges table without evidence columns (post-slice shape)', () => {
  // The fresh-database half: the DDL itself no longer names either column,
  // so a brand-new database never has them to begin with.
  it('a fresh database is born with neither evidence column on edges', async () => {
    tempDb = await openTempBeliefDatabase();
    const edgeColumnNames = readEdgeTableColumnNames(tempDb);
    for (const removedColumnName of removedEdgeEvidenceColumnNames) {
      expect(
        edgeColumnNames,
        `fresh edges table must not carry ${removedColumnName}`
      ).not.toContain(removedColumnName);
    }
  });

  // The legacy half: opening an evidence-bearing file through the client
  // DROPS both columns while every other edge field survives untouched.
  it('opening a legacy evidence-bearing database drops both columns and keeps every other edge field', async () => {
    tempDb = await openTempBeliefDatabase({
      prepareExistingDbFile: createLegacyEvidenceBearingDbFile,
    });

    const edgeColumnNames = readEdgeTableColumnNames(tempDb);
    for (const removedColumnName of removedEdgeEvidenceColumnNames) {
      expect(
        edgeColumnNames,
        `migration must drop edges.${removedColumnName}`
      ).not.toContain(removedColumnName);
    }

    // Both rows survive with every non-evidence field byte-identical.
    expect(readSurvivingEdgeRowFields(tempDb)).toEqual(expectedSurvivingLegacyEdgeRows);
  });

  // The survivors: the journal triggers and the direction-slot index must
  // come through the migration intact. The columns-are-gone precondition is
  // asserted FIRST because these survivor pins only mean anything about the
  // POST-slice migration once it has actually run on this file.
  it('the migrated legacy database still journals edge deletes and keeps the direction-slot index', async () => {
    tempDb = await openTempBeliefDatabase({
      prepareExistingDbFile: createLegacyEvidenceBearingDbFile,
    });

    // Precondition: the migration ran — without this, a still-evidence-bearing
    // table would make the survivor assertions below vacuously green.
    const edgeColumnNames = readEdgeTableColumnNames(tempDb);
    for (const removedColumnName of removedEdgeEvidenceColumnNames) {
      expect(
        edgeColumnNames,
        `migration must drop edges.${removedColumnName} before the survivor pins mean anything`
      ).not.toContain(removedColumnName);
    }

    // The journal trigger is still present…
    expect(
      hasTrigger(tempDb, 'trg_graph_events_edge_delete'),
      'trg_graph_events_edge_delete must survive the evidence-column migration'
    ).toBe(true);

    // …and still FIRES: deleting the legacy evidence edge writes exactly one
    // edge_deleted journal row carrying the dead edge's id and both ends.
    tempDb.sqlite.prepare('DELETE FROM edges WHERE id = 1').run();
    const edgeDeletedJournalRows = tempDb.sqlite
      .prepare(
        `SELECT edge_id, from_node_id, to_node_id FROM graph_events
         WHERE event_type = 'edge_deleted' ORDER BY id ASC`
      )
      .all() as Array<{ edge_id: number; from_node_id: number; to_node_id: number }>;
    expect(edgeDeletedJournalRows).toEqual([{ edge_id: 1, from_node_id: 1, to_node_id: 2 }]);

    // The UNIQUE direction-slot index survives too: DROP COLUMN edits the
    // table in place, so the index must never be lost to a table rebuild.
    const directionSlotIndexRow = tempDb.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_edges_direction_slot'")
      .get() as { name: string } | undefined;
    expect(
      directionSlotIndexRow,
      'idx_edges_direction_slot must survive the evidence-column migration'
    ).toBeDefined();
  });

  // Rerun safety: the guarded migration finds nothing to drop on a second
  // open and the rows are untouched — reopening is how every real app start
  // hits this code path after the first migration.
  it('a migrated legacy database survives a second open unchanged', async () => {
    tempDb = await openTempBeliefDatabase({
      prepareExistingDbFile: createLegacyEvidenceBearingDbFile,
    });
    await tempDb.reopenBeliefDatabase();

    const edgeColumnNames = readEdgeTableColumnNames(tempDb);
    for (const removedColumnName of removedEdgeEvidenceColumnNames) {
      expect(
        edgeColumnNames,
        `edges.${removedColumnName} must stay dropped across a reopen`
      ).not.toContain(removedColumnName);
    }
    expect(readSurvivingEdgeRowFields(tempDb)).toEqual(expectedSurvivingLegacyEdgeRows);
  });
});
