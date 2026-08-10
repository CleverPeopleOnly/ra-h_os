/**
 * MR-B tests for the belief recovery sweep
 * (src/services/belief/beliefRecoveryService.runBeliefRecoverySweep —
 * RENAMED from recoverUngradedEvidence per belief model v2: the sweep now
 * recovers stale stamps as well as never-stamped edges).
 *
 * The sweep exists for one scenario: the standalone MCP server wrote
 * evidence edges while the app was closed. Those edges carry a NULL
 * belief_evidence_contribution (the standalone server never grades), so
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
  // (contribution stamp NULL) must be regraded — credence persisted,
  // stamps written, movement appended, and its id reported.
  it('regrades a node whose evidence edges have a NULL effective-contribution stamp', async () => {
    db = await openTempBeliefDatabase();
    // The source node must itself be GRADED — its own belief_credence is the
    // weight its evidence carries, and an ungraded source's evidence is
    // excluded from grading entirely, so it would never produce a credence.
    const evidenceNodeId = db.insertNodeFixture({
      title: 'offline evidence source node',
      beliefCredence: 0.9,
    });
    const claimNodeId = db.insertNodeFixture({ title: 'claim node with offline evidence' });
    // Simulates a standalone write while the app was closed: evidence fields
    // set, belief_evidence_contribution left NULL (never graded).
    const ungradedEdgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId: evidenceNodeId,
      support: 0.8,
    });

    const { runBeliefRecoverySweep } = await importBeliefRecoveryService();
    const recoveryResult = await runBeliefRecoverySweep();

    // The regraded node is reported.
    expect(recoveryResult.regradedNodeIds).toContain(claimNodeId);

    // Credence and timestamp are persisted on the node.
    const nodeBelief = db.readNodeBelief(claimNodeId);
    expect(nodeBelief.belief_credence).not.toBeNull();
    expect(nodeBelief.belief_computed_at).not.toBeNull();

    // The evidence edge is now stamped.
    expect(db.readEvidenceStamp(ungradedEdgeId)).not.toBeNull();

    // Exactly one movement row records the ungraded -> graded transition.
    const movements = db.readBeliefMovements(claimNodeId);
    expect(movements).toHaveLength(1);
    expect(movements[0].from_credence).toBeNull();
    expect(movements[0].to_credence).toBe(nodeBelief.belief_credence);
  });

  // Idempotence: a node whose evidence is already fully stamped was graded
  // by the app and must NOT be regraded again by the sweep.
  it('does not regrade a node whose evidence edges are already fully stamped', async () => {
    db = await openTempBeliefDatabase();
    // Graded source, as above: an ungraded source's edge is never stamped at
    // all, which would make the initial recompute below produce no movement
    // and defeat the point of this idempotence test.
    const evidenceNodeId = db.insertNodeFixture({
      title: 'already graded evidence source',
      beliefCredence: 0.9,
    });
    const claimNodeId = db.insertNodeFixture({ title: 'claim node already fully graded' });
    db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId: evidenceNodeId,
      support: 0.6,
    });

    // Grade the node for real first, so its evidence carries stamps.
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const movementsAfterGrading = db.readBeliefMovements(claimNodeId);
    expect(movementsAfterGrading).toHaveLength(1);

    const { runBeliefRecoverySweep } = await importBeliefRecoveryService();
    const recoveryResult = await runBeliefRecoverySweep();

    // Fully-stamped node: not reported, no new movement rows.
    expect(recoveryResult.regradedNodeIds).not.toContain(claimNodeId);
    expect(db.readBeliefMovements(claimNodeId)).toHaveLength(1);
  });

  // Ungraded source is not evidence: an evidence edge whose source (its
  // TO-node under canon) has a NULL belief_credence is excluded from grading entirely, so
  // recomputeNodeBelief never stamps it and it stays pending. The sweep's
  // NULL-stamp query still matches this node every run (the edge's stamp
  // never clears) and recomputes it — matching the current recovery
  // contract, the node IS visited/reported — but the recomputed
  // belief_credence must stay NULL since there is no counted evidence.
  it('recomputes a node with only ungraded-source evidence but leaves belief_credence NULL', async () => {
    db = await openTempBeliefDatabase();
    const ungradedSourceNodeId = db.insertNodeFixture({ title: 'ungraded evidence source' });
    const claimNodeId = db.insertNodeFixture({
      title: 'claim node with only ungraded-source offline evidence',
    });
    // The source has no belief_credence of its own, so its edge is left
    // ungraded/pending on purpose.
    db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId: ungradedSourceNodeId,
      support: 0.8,
    });
    // Positive control swept in the same run, so the NULL below means the
    // gate fired rather than the sweep grading nothing at all.
    const gradedSourceNodeId = db.insertNodeFixture({
      title: 'graded evidence source',
      beliefCredence: 0.9,
    });
    const controlClaimNodeId = db.insertNodeFixture({
      title: 'control claim deriving from a graded source',
    });
    db.insertEvidenceEdgeFixture({
      derivedNodeId: controlClaimNodeId,
      sourceNodeId: gradedSourceNodeId,
      support: 0.8,
    });

    const { runBeliefRecoverySweep } = await importBeliefRecoveryService();
    const recoveryResult = await runBeliefRecoverySweep();

    expect(recoveryResult.regradedNodeIds).toContain(claimNodeId);
    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeNull();
    expect(db.readNodeBelief(controlClaimNodeId).belief_credence).not.toBeNull();
  });

  // REWRITTEN from "leaves belief_credence NULL". Under the counted-negatives
  // rule a source we DISBELIEVE (negative credence) IS a vote — against. The
  // sweep must grade the claim to a real NEGATIVE credence and stamp the
  // edge with its negative contribution, which also clears the pending-work
  // condition so the next sweep has nothing left to do for this node.
  it('grades a node whose only source has a negative credence to a negative credence and stamps the edge', async () => {
    db = await openTempBeliefDatabase();
    const disbelievedSourceNodeId = db.insertNodeFixture({
      title: 'disbelieved evidence source',
      beliefCredence: -0.9,
    });
    const claimNodeId = db.insertNodeFixture({
      title: 'claim node deriving only from a disbelieved source',
    });
    const disbelievedSourceEdgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId: disbelievedSourceNodeId,
      support: 0.8,
    });

    const { runBeliefRecoverySweep } = await importBeliefRecoveryService();
    const recoveryResult = await runBeliefRecoverySweep();

    expect(recoveryResult.regradedNodeIds).toContain(claimNodeId);
    // Graded negative off s = |-0.9 × 0.8| = 0.72: -0.72/2.72 (EDITED per
    // docs/belief-model-subjective-logic.md §3 row 6 arithmetic — the v2
    // projection replaces the v1 exponential anchor e^(-0.72) - 1).
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      -0.72 / 2.72,
      10
    );
    // Stamped with the negative contribution, so the edge is no longer
    // pending work (contribution stamp non-NULL).
    expect(Number(db.readEvidenceStamp(disbelievedSourceEdgeId))).toBeCloseTo(-0.72, 10);

    // Idempotence for this shape: a second sweep finds nothing left to do.
    const secondSweepResult = await runBeliefRecoverySweep();
    expect(secondSweepResult.regradedNodeIds).not.toContain(claimNodeId);
  });

  // The sweep must EXCLUDE a fixed node from its candidate query outright,
  // not merely recompute it to no effect. A fixed node with unstamped
  // outgoing evidence matches the pending-work condition (support set,
  // contribution NULL) on every run, so unless the query filters it out the
  // one bootstrap node in the graph is reported as regraded work forever.
  it('never picks up a fixed-credence node as a sweep candidate', async () => {
    db = await openTempBeliefDatabase();
    const fixedExpertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'human expert whose credence is asserted',
      beliefCredence: 0.9,
    });
    const credibleSourceNodeId = db.insertNodeFixture({
      title: 'credible source the expert would derive from',
      beliefCredence: 1.0,
    });
    // Exactly the shape the sweep looks for: support set (in the unsigned
    // 0..1 range), contribution NULL.
    db.insertEvidenceEdgeFixture({
      derivedNodeId: fixedExpertNodeId,
      sourceNodeId: credibleSourceNodeId,
      support: 1.0,
    });
    // Positive control with the identical shape on an ORDINARY node, so a
    // clean result below means the fixed node was filtered out rather than
    // the sweep finding nothing at all.
    const ordinaryClaimNodeId = db.insertNodeFixture({ title: 'ordinary claim with the same shape' });
    db.insertEvidenceEdgeFixture({
      derivedNodeId: ordinaryClaimNodeId,
      sourceNodeId: credibleSourceNodeId,
      support: 0.8,
    });

    const { runBeliefRecoverySweep } = await importBeliefRecoveryService();
    const recoveryResult = await runBeliefRecoverySweep();

    expect(recoveryResult.regradedNodeIds).toContain(ordinaryClaimNodeId);
    expect(recoveryResult.regradedNodeIds).not.toContain(fixedExpertNodeId);
    // Nowhere else in the result either: flattening every field's ids catches
    // a fixed node reported under some other heading (skipped, visited, …).
    expect(Object.values(recoveryResult).flat()).not.toContain(fixedExpertNodeId);
  });

  // A node whose credence is human-asserted must survive the startup sweep
  // untouched, even when evidence it would derive from was written offline. The
  // sweep runs recomputeNodeBelief, and a recompute of a fixed node is a
  // no-op — otherwise the one bootstrap node in the graph would be silently
  // regraded away on the next app start.
  it('leaves a fixed-credence node untouched even when it has ungraded outgoing evidence', async () => {
    db = await openTempBeliefDatabase();
    const fixedExpertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'human expert whose credence is asserted',
      beliefCredence: 0.9,
    });
    // A disbelieved source at full strength: under the counted-negatives rule
    // this is hard contradiction mass that WOULD regrade an ordinary node.
    const criticNodeId = db.insertNodeFixture({
      title: 'disbelieved critic the expert would derive from',
      beliefCredence: -1.0,
    });
    const offlineCriticEdgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: fixedExpertNodeId,
      sourceNodeId: criticNodeId,
      support: 1.0,
    });

    const { runBeliefRecoverySweep } = await importBeliefRecoveryService();
    await runBeliefRecoverySweep();

    const fixedExpertBelief = db.readNodeBelief(fixedExpertNodeId);
    expect(Number(fixedExpertBelief.belief_credence)).toBeCloseTo(0.9, 10);
    expect(db.readBeliefMovements(fixedExpertNodeId)).toHaveLength(0);
    expect(db.readEvidenceStamp(offlineCriticEdgeId)).toBeNull();
  });

  // Nodes without any evidence edges have nothing to recover: the sweep
  // must leave them completely untouched.
  it('leaves a node with no evidence edges untouched', async () => {
    db = await openTempBeliefDatabase();
    const plainNodeId = db.insertNodeFixture({ title: 'plain node without evidence' });

    const { runBeliefRecoverySweep } = await importBeliefRecoveryService();
    const recoveryResult = await runBeliefRecoverySweep();

    expect(recoveryResult.regradedNodeIds).not.toContain(plainNodeId);
    const nodeBelief = db.readNodeBelief(plainNodeId);
    expect(nodeBelief.belief_credence).toBeNull();
    expect(nodeBelief.belief_computed_at).toBeNull();
    expect(db.readBeliefMovements(plainNodeId)).toHaveLength(0);
  });

  // The evidence marker in the sweep's own query: the pending-work query
  // selected on "belief_evidence_direction IS NOT NULL" and must now select
  // on "belief_evidence_support IS NOT NULL". A node joined only by a plain
  // edge (NULL support, NULL contribution) has no pending evidence, so the
  // sweep must not pick it up even though its stamp is NULL.
  it('does not regrade a node whose only outgoing edge has NULL belief_evidence_support', async () => {
    db = await openTempBeliefDatabase();
    const plainNeighbourNodeId = db.insertNodeFixture({ title: 'plain neighbour node' });
    const claimNodeId = db.insertNodeFixture({ title: 'claim joined only by a plain edge' });
    // Canon arrangement: the plain edge sits exactly where an evidence edge
    // would (claim at the from-end), so only its NULL support keeps it out.
    db.insertNonEvidenceEdgeFixture({
      fromNodeId: claimNodeId,
      toNodeId: plainNeighbourNodeId,
    });
    // Precondition: the marker column the sweep must select on actually
    // exists, so "not swept" below means "support was NULL", not "there is no
    // support column and the sweep is looking at something else entirely".
    expect(db.readTableColumns('edges').map(column => column.name)).toContain(
      'belief_evidence_support'
    );

    const { runBeliefRecoverySweep } = await importBeliefRecoveryService();
    const recoveryResult = await runBeliefRecoverySweep();

    expect(recoveryResult.regradedNodeIds).not.toContain(claimNodeId);
    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeNull();
    expect(db.readBeliefMovements(claimNodeId)).toHaveLength(0);
  });
});
