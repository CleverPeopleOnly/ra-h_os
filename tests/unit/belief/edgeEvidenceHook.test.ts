/**
 * Tests for the EdgeService evidence hook (MR-A).
 *
 * Pins that EdgeService.createEdge:
 *  - stores the new optional evidence fields (evidence_relation,
 *    evidence_strength, evidence_independence_key) in the new edge columns,
 *  - triggers recomputeNodeBelief(to_node_id) so the target node's
 *    belief_value becomes non-NULL WITHOUT any explicit belief call,
 *  - leaves belief_value NULL and the evidence columns NULL when called
 *    without evidence fields.
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

// EdgeData extended with the MR-A evidence fields. Declared here (assignable
// to EdgeData) so the tests compile before EdgeData itself gains the fields;
// once MR-A extends EdgeData this alias becomes redundant but stays valid.
type EvidenceEdgeInput = EdgeData & {
  evidence_relation: 'supports' | 'contradicts';
  evidence_strength: number;
  evidence_independence_key: string | null;
};

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// One edges row as read back by these tests.
interface EvidenceEdgeRow {
  evidence_relation: string | null;
  evidence_strength: number | null;
  evidence_independence_key: string | null;
}

// Read the evidence columns of one edge straight from SQLite.
function readEvidenceColumns(context: TempBeliefDatabase, edgeId: number): EvidenceEdgeRow {
  return context.sqlite
    .prepare(
      `SELECT evidence_relation, evidence_strength, evidence_independence_key
       FROM edges WHERE id = ?`
    )
    .get(edgeId) as EvidenceEdgeRow;
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
      evidence_relation: 'supports',
      evidence_strength: 0.8,
      evidence_independence_key: 'origin-hook-test',
    };
    const createdEdge = await edgeService.createEdge(evidenceInput);

    const storedEvidence = readEvidenceColumns(db, createdEdge.id);
    expect(storedEvidence.evidence_relation).toBe('supports');
    expect(Number(storedEvidence.evidence_strength)).toBeCloseTo(0.8, 10);
    expect(storedEvidence.evidence_independence_key).toBe('origin-hook-test');
  });

  // Creating an evidence edge must, by itself, grade the target node: its
  // belief_value becomes non-NULL with no explicit belief-service call.
  it('triggers a belief recompute of the target node when an evidence edge is created', async () => {
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
      evidence_relation: 'supports',
      evidence_strength: 0.8,
      evidence_independence_key: 'origin-hook-test',
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
    expect(storedEvidence.evidence_relation).toBeNull();
    expect(storedEvidence.evidence_strength).toBeNull();
    expect(storedEvidence.evidence_independence_key).toBeNull();
  });
});
