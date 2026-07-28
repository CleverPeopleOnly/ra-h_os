/**
 * Tests for the EdgeService evidence hook (MR-A).
 *
 * Pins that EdgeService.createEdge:
 *  - stores the one signed evidence field (belief_evidence_support) in its
 *    dedicated edge column,
 *  - triggers recomputeNodeBelief(to_node_id) so the target node's
 *    belief_credence becomes non-NULL WITHOUT any explicit belief call,
 *  - leaves belief_credence NULL and belief_evidence_support NULL when called
 *    without evidence fields,
 *  - IGNORES the merged-away belief_evidence_direction /
 *    belief_evidence_strength fields from a stale caller rather than
 *    erroring: those columns are gone, so there is nothing to store, and an
 *    edge created with no support is simply a plain non-evidence edge.
 *
 * All edges are created with skip_inference: true and an explicit
 * explanation so no LLM path is ever exercised. Runs against a fresh
 * temp-file database per test (see tempBeliefDatabase.ts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EdgeData } from '@/types/database';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// EdgeData with the single signed evidence field made required, so the tests
// below cannot accidentally omit it.
type EvidenceEdgeInput = EdgeData & {
  belief_evidence_support: number;
};

// An edge input from a STALE caller that still sends the merged-away pair.
// It stays assignable to EdgeData, which is exactly the point: createEdge
// must accept it and ignore both extra fields.
type StaleTwoFieldEdgeInput = EdgeData & {
  belief_evidence_direction: 'for' | 'against';
  belief_evidence_strength: number;
};

// Type-level pin: EdgeData's belief-evidence surface is exactly one field.
// Extract picks every belief_evidence_* key EdgeData declares, so this array
// only type-checks once direction and strength are gone from the type and
// support has replaced them.
type BeliefEvidenceFieldNameOnEdgeData = Extract<keyof EdgeData, `belief_evidence_${string}`>;
const beliefEvidenceFieldNamesOnEdgeData: BeliefEvidenceFieldNameOnEdgeData[] = [
  'belief_evidence_support',
];

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// One edges row as read back by these tests.
interface EvidenceEdgeRow {
  belief_evidence_support: number | null;
}

// Read the signed evidence column of one edge straight from SQLite.
function readEvidenceSupportColumn(context: TempBeliefDatabase, edgeId: number): EvidenceEdgeRow {
  return context.sqlite
    .prepare('SELECT belief_evidence_support FROM edges WHERE id = ?')
    .get(edgeId) as EvidenceEdgeRow;
}

// Names of the columns the edges table actually has, straight from SQLite —
// used to prove the merged-away pair has no storage behind it.
function readEdgeTableColumnNames(context: TempBeliefDatabase): string[] {
  return context.readTableColumns('edges').map(column => column.name);
}

describe('EdgeService evidence hook', () => {
  // The EdgeData contract itself: one signed belief-evidence field, no pair.
  it('EdgeData declares belief_evidence_support as its only belief-evidence field', () => {
    expect(beliefEvidenceFieldNamesOnEdgeData).toEqual(['belief_evidence_support']);
  });

  // EDITED from the two-field storage case: the signed support value passed
  // to createEdge must land in the new edge column, not in the app-owned
  // context JSON.
  it('stores belief_evidence_support in the new edge column on createEdge', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim node' });
    const sourceNodeId = db.insertNodeFixture({ title: 'evidence source node' });
    const { edgeService } = await db.importEdgeService();

    const evidenceInput: EvidenceEdgeInput = {
      from_node_id: sourceNodeId,
      to_node_id: claimNodeId,
      explanation: 'Evidence fixture supporting the claim node.',
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
      belief_evidence_support: 0.8,
    };
    const createdEdge = await edgeService.createEdge(evidenceInput);

    const storedEvidence = readEvidenceSupportColumn(db, createdEdge.id);
    expect(Number(storedEvidence.belief_evidence_support)).toBeCloseTo(0.8, 10);
    // No merged-away column is left for createEdge to write into.
    const edgeColumnNames = readEdgeTableColumnNames(db);
    expect(edgeColumnNames).not.toContain('belief_evidence_direction');
    expect(edgeColumnNames).not.toContain('belief_evidence_strength');
  });

  // Sign carries through the write path unchanged: a negative support is a
  // contradiction and must be stored as-is, never normalised to a magnitude.
  it('stores a negative belief_evidence_support as a contradiction without changing its sign', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim node' });
    const sourceNodeId = db.insertNodeFixture({ title: 'contradicting source node' });
    const { edgeService } = await db.importEdgeService();

    const contradictionInput: EvidenceEdgeInput = {
      from_node_id: sourceNodeId,
      to_node_id: claimNodeId,
      explanation: 'Evidence fixture contradicting the claim node.',
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
      belief_evidence_support: -0.4,
    };
    const createdEdge = await edgeService.createEdge(contradictionInput);

    expect(Number(readEvidenceSupportColumn(db, createdEdge.id).belief_evidence_support)).toBeCloseTo(
      -0.4,
      10
    );
  });

  // A support of exactly 0 must survive the write path as 0, never collapse
  // to NULL. This is the regression a truthiness test would cause: writing
  // `if (support)` instead of `if (support != null)` silently turns an
  // assessed "leans neither way" into an unassessed plain edge, erasing the
  // one distinction the field carries. The edge must also still count as
  // evidence, so the target node gets graded rather than left ungraded.
  it('stores a belief_evidence_support of exactly 0 as 0, not NULL, and still grades the target node', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim node' });
    // ASSESSED source, so the triggered recompute can actually grade.
    const sourceTrustOriginKey = 'trust:neutral-evidence-source';
    const sourceNodeId = db.insertNodeFixture({
      title: 'source that leans neither way',
      trustOriginKey: sourceTrustOriginKey,
    });
    db.seedSourceTrustRow(sourceTrustOriginKey, 0.9);
    const { edgeService } = await db.importEdgeService();

    const neutralEvidenceInput: EvidenceEdgeInput = {
      from_node_id: sourceNodeId,
      to_node_id: claimNodeId,
      explanation: 'Evidence fixture that bears neither way on the claim node.',
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
      belief_evidence_support: 0,
    };
    const createdEdge = await edgeService.createEdge(neutralEvidenceInput);

    // toBe(0) rather than a coercing comparison: Number(null) is also 0, so
    // only a strict check can tell a stored zero from a collapsed NULL.
    const storedSupport = readEvidenceSupportColumn(db, createdEdge.id).belief_evidence_support;
    expect(storedSupport).toBe(0);
    expect(storedSupport).not.toBeNull();

    // Still evidence, so the hook grades the target node.
    await vi.waitFor(
      () => {
        expect(db!.readNodeBelief(claimNodeId).belief_credence).not.toBeNull();
      },
      { timeout: 1500, interval: 25 }
    );
  });

  // EDITED from the stale-origin-key case: a caller that has not yet moved to
  // the signed field must not break. Both merged-away fields are ignored and
  // the edge is created as a plain, non-evidence edge — legitimate, because
  // NULL support simply means "not evidence".
  it('ignores stale belief_evidence_direction and belief_evidence_strength fields and creates a plain edge', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim node' });
    const sourceNodeId = db.insertNodeFixture({ title: 'evidence source node' });
    const { edgeService } = await db.importEdgeService();

    const staleTwoFieldInput: StaleTwoFieldEdgeInput = {
      from_node_id: sourceNodeId,
      to_node_id: claimNodeId,
      explanation: 'Evidence fixture from a caller that still sends the old pair.',
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
      belief_evidence_direction: 'against',
      belief_evidence_strength: 0.4,
    };
    const createdEdge = await edgeService.createEdge(staleTwoFieldInput);

    expect(createdEdge.id).toBeGreaterThan(0);
    // The ignored fields left no trace: no support was invented from them.
    expect(readEvidenceSupportColumn(db, createdEdge.id).belief_evidence_support).toBeNull();
    const edgeColumnNames = readEdgeTableColumnNames(db);
    expect(edgeColumnNames).not.toContain('belief_evidence_direction');
    expect(edgeColumnNames).not.toContain('belief_evidence_strength');
  });

  // Creating an evidence edge must, by itself, grade the target node: its
  // belief_credence becomes non-NULL with no explicit belief-service call.
  it('triggers a belief recompute of the target node when an evidence edge is created', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim node' });
    // The source must be ASSESSED (trustOriginKey + a seeded
    // belief_source_trust row) — an unassessed source's evidence is
    // excluded from grading entirely, so the recompute would stay NULL.
    const sourceTrustOriginKey = 'trust:evidence-hook-source';
    const sourceNodeId = db.insertNodeFixture({
      title: 'evidence source node',
      trustOriginKey: sourceTrustOriginKey,
    });
    db.seedSourceTrustRow(sourceTrustOriginKey, 0.9);
    const { edgeService } = await db.importEdgeService();

    const evidenceInput: EvidenceEdgeInput = {
      from_node_id: sourceNodeId,
      to_node_id: claimNodeId,
      explanation: 'Evidence fixture supporting the claim node.',
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
      belief_evidence_support: 0.8,
    };
    await edgeService.createEdge(evidenceInput);

    // Poll briefly in case the implementation recomputes asynchronously.
    await vi.waitFor(
      () => {
        expect(db!.readNodeBelief(claimNodeId).belief_credence).not.toBeNull();
      },
      { timeout: 1500, interval: 25 }
    );
  });

  // A plain (non-evidence) edge must change nothing belief-wise: target stays
  // ungraded and belief_evidence_support stays NULL.
  it('leaves belief_credence NULL and belief_evidence_support NULL for a non-evidence createEdge', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim node' });
    const sourceNodeId = db.insertNodeFixture({ title: 'plain neighbor node' });
    const { edgeService } = await db.importEdgeService();

    const plainInput: EdgeData = {
      from_node_id: sourceNodeId,
      to_node_id: claimNodeId,
      explanation: 'Plain non-evidence connection between the nodes.',
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
    };
    const createdEdge = await edgeService.createEdge(plainInput);

    // Give any (wrongly) triggered async recompute a moment to surface
    // before asserting that nothing happened.
    await new Promise(resolve => setTimeout(resolve, 250));

    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeNull();
    expect(readEvidenceSupportColumn(db, createdEdge.id).belief_evidence_support).toBeNull();
  });
});
