/**
 * Tests for the EdgeService evidence hook (MR-A).
 *
 * Pins that EdgeService.createEdge:
 *  - stores the optional evidence fields (belief_evidence_direction,
 *    belief_evidence_strength) in the dedicated edge columns,
 *  - triggers recomputeNodeBelief(to_node_id) so the target node's
 *    belief_value becomes non-NULL WITHOUT any explicit belief call,
 *  - leaves belief_value NULL and the evidence columns NULL when called
 *    without evidence fields,
 *  - IGNORES a belief_evidence_origin_key field from a stale caller rather
 *    than erroring: the column is removed, so there is nothing to store,
 *    but the edge must still be created with its other evidence intact.
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

// EdgeData with the two surviving evidence fields made required, so the
// tests below cannot accidentally omit them.
type EvidenceEdgeInput = EdgeData & {
  belief_evidence_direction: 'for' | 'against';
  belief_evidence_strength: number;
};

// An evidence edge input from a STALE caller that still sends the removed
// origin key. It stays assignable to EdgeData, which is exactly the point:
// createEdge must accept it and ignore the extra field.
type StaleOriginKeyEdgeInput = EvidenceEdgeInput & {
  belief_evidence_origin_key: string;
};

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// One edges row as read back by these tests.
interface EvidenceEdgeRow {
  belief_evidence_direction: string | null;
  belief_evidence_strength: number | null;
}

// Read the evidence columns of one edge straight from SQLite.
function readEvidenceColumns(context: TempBeliefDatabase, edgeId: number): EvidenceEdgeRow {
  return context.sqlite
    .prepare(
      `SELECT belief_evidence_direction, belief_evidence_strength
       FROM edges WHERE id = ?`
    )
    .get(edgeId) as EvidenceEdgeRow;
}

// Names of the columns the edges table actually has, straight from SQLite —
// used to prove the removed origin key has no storage behind it.
function readEdgeTableColumnNames(context: TempBeliefDatabase): string[] {
  return context.readTableColumns('edges').map(column => column.name);
}

describe('EdgeService evidence hook', () => {
  // Evidence fields passed to createEdge must land in the new edge columns,
  // not in the app-owned context JSON.
  it('stores the evidence fields in the new edge columns on createEdge', async () => {
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
      belief_evidence_direction: 'for',
      belief_evidence_strength: 0.8,
    };
    const createdEdge = await edgeService.createEdge(evidenceInput);

    const storedEvidence = readEvidenceColumns(db, createdEdge.id);
    expect(storedEvidence.belief_evidence_direction).toBe('for');
    expect(Number(storedEvidence.belief_evidence_strength)).toBeCloseTo(0.8, 10);
    // There is no origin-key column left for createEdge to write into.
    expect(readEdgeTableColumnNames(db)).not.toContain('belief_evidence_origin_key');
  });

  // A caller that has not yet dropped the removed field must not break: the
  // extra belief_evidence_origin_key is ignored and the edge is created
  // normally with its direction and strength intact.
  it('ignores a stale belief_evidence_origin_key field and still creates the edge with its other evidence', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim node' });
    const sourceNodeId = db.insertNodeFixture({ title: 'evidence source node' });
    const { edgeService } = await db.importEdgeService();

    const staleOriginKeyInput: StaleOriginKeyEdgeInput = {
      from_node_id: sourceNodeId,
      to_node_id: claimNodeId,
      explanation: 'Evidence fixture from a caller that still sends the origin key.',
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
      belief_evidence_direction: 'against',
      belief_evidence_strength: 0.4,
      belief_evidence_origin_key: 'origin-stale-caller',
    };
    const createdEdge = await edgeService.createEdge(staleOriginKeyInput);

    expect(createdEdge.id).toBeGreaterThan(0);
    const storedEvidence = readEvidenceColumns(db, createdEdge.id);
    expect(storedEvidence.belief_evidence_direction).toBe('against');
    expect(Number(storedEvidence.belief_evidence_strength)).toBeCloseTo(0.4, 10);
    // The ignored field left no trace: no column, hence nowhere it landed.
    expect(readEdgeTableColumnNames(db)).not.toContain('belief_evidence_origin_key');
  });

  // Creating an evidence edge must, by itself, grade the target node: its
  // belief_value becomes non-NULL with no explicit belief-service call.
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
      belief_evidence_direction: 'for',
      belief_evidence_strength: 0.8,
    };
    await edgeService.createEdge(evidenceInput);

    // Poll briefly in case the implementation recomputes asynchronously.
    await vi.waitFor(
      () => {
        expect(db!.readNodeBelief(claimNodeId).belief_value).not.toBeNull();
      },
      { timeout: 1500, interval: 25 }
    );
  });

  // A plain (non-evidence) edge must change nothing belief-wise: target
  // stays ungraded and all evidence columns stay NULL.
  it('leaves belief_value NULL and evidence columns NULL for a non-evidence createEdge', async () => {
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

    expect(db.readNodeBelief(claimNodeId).belief_value).toBeNull();
    const storedEvidence = readEvidenceColumns(db, createdEdge.id);
    expect(storedEvidence.belief_evidence_direction).toBeNull();
    expect(storedEvidence.belief_evidence_strength).toBeNull();
  });
});
