/**
 * MR-B tests for the belief recovery sweep
 * (src/services/belief/beliefRecoveryService.recoverUngradedEvidence).
 *
 * The sweep exists for one scenario: the standalone MCP server wrote
 * evidence edges while the app was closed. Those edges carry a NULL
 * evidence_effective_contribution (the standalone server never grades), so
 * at app startup the sweep must find every node with such ungraded evidence
 * and regrade it — and must leave fully-stamped and evidence-free nodes
 * alone.
 *
 * Runs against a fresh temp-file database per test (see
 * tempBeliefDatabase.ts for the safety seam). The recovery service is loaded
 * through a dynamic import AFTER the temp database opens, so it binds to the
 * same fresh client generation (per the helper's module-binding rule).
 */

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

// Import the recovery service bound to the current database generation
// (must run AFTER openTempBeliefDatabase so the module sees the temp file).
function importBeliefRecoveryService() {
  return import('@/services/belief/beliefRecoveryService');
}

describe('belief recovery sweep (MR-B)', () => {
  // The core recovery case: a node whose evidence edge was written offline
  // (contribution stamp NULL) must be regraded — belief value persisted,
  // stamps written, movement appended, and its id reported.
  it('regrades a node whose evidence edges have a NULL effective-contribution stamp', async () => {
    db = await openTempBeliefDatabase();
    const evidenceNodeId = db.insertNodeFixture({ title: 'offline evidence origin node' });
    const claimNodeId = db.insertNodeFixture({ title: 'claim node with offline evidence' });
    // Simulates a standalone write while the app was closed: evidence fields
    // set, evidence_effective_contribution left NULL (never graded).
    const ungradedEdgeId = db.insertEvidenceEdgeFixture({
      fromNodeId: evidenceNodeId,
      toNodeId: claimNodeId,
      direction: 'for',
      strength: 0.8,
      evidenceOriginKey: 'origin:offline-write',
    });

    const { recoverUngradedEvidence } = await importBeliefRecoveryService();
    const recoveryResult = await recoverUngradedEvidence();

    // The regraded node is reported.
    expect(recoveryResult.regradedNodeIds).toContain(claimNodeId);

    // Belief value and timestamp are persisted on the node.
    const nodeBelief = db.readNodeBelief(claimNodeId);
    expect(nodeBelief.belief_value).not.toBeNull();
    expect(nodeBelief.belief_computed_at).not.toBeNull();

    // The evidence edge is now stamped.
    expect(db.readEvidenceStamp(ungradedEdgeId)).not.toBeNull();

    // Exactly one movement row records the ungraded -> graded transition.
    const movements = db.readBeliefMovements(claimNodeId);
    expect(movements).toHaveLength(1);
    expect(movements[0].from_value).toBeNull();
    expect(movements[0].to_value).toBe(nodeBelief.belief_value);
  });

  // Idempotence: a node whose evidence is already fully stamped was graded
  // by the app and must NOT be regraded again by the sweep.
  it('does not regrade a node whose evidence edges are already fully stamped', async () => {
    db = await openTempBeliefDatabase();
    const evidenceNodeId = db.insertNodeFixture({ title: 'already graded evidence origin' });
    const claimNodeId = db.insertNodeFixture({ title: 'claim node already fully graded' });
    db.insertEvidenceEdgeFixture({
      fromNodeId: evidenceNodeId,
      toNodeId: claimNodeId,
      direction: 'for',
      strength: 0.6,
      evidenceOriginKey: 'origin:already-graded',
    });

    // Grade the node for real first, so its evidence carries stamps.
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const movementsAfterGrading = db.readBeliefMovements(claimNodeId);
    expect(movementsAfterGrading).toHaveLength(1);

    const { recoverUngradedEvidence } = await importBeliefRecoveryService();
    const recoveryResult = await recoverUngradedEvidence();

    // Fully-stamped node: not reported, no new movement rows.
    expect(recoveryResult.regradedNodeIds).not.toContain(claimNodeId);
    expect(db.readBeliefMovements(claimNodeId)).toHaveLength(1);
  });

  // Nodes without any evidence edges have nothing to recover: the sweep
  // must leave them completely untouched.
  it('leaves a node with no evidence edges untouched', async () => {
    db = await openTempBeliefDatabase();
    const plainNodeId = db.insertNodeFixture({ title: 'plain node without evidence' });

    const { recoverUngradedEvidence } = await importBeliefRecoveryService();
    const recoveryResult = await recoverUngradedEvidence();

    expect(recoveryResult.regradedNodeIds).not.toContain(plainNodeId);
    const nodeBelief = db.readNodeBelief(plainNodeId);
    expect(nodeBelief.belief_value).toBeNull();
    expect(nodeBelief.belief_computed_at).toBeNull();
    expect(db.readBeliefMovements(plainNodeId)).toHaveLength(0);
  });
});
