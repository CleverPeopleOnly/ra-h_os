/**
 * Behaviour tests for the v2 RECOVERY SWEEP
 * (docs/belief-model-subjective-logic.md §4, last paragraph) against a real
 * temp-file SQLite database (see tempBeliefDatabase.ts for the safety seam).
 *
 * V1's recovery (recoverUngradedEvidence) keys ONLY on
 * belief_evidence_contribution IS NULL, so a stamp that has gone STALE —
 * written when the source held a different credence — is invisible to it
 * forever (audit finding 3's recovery-side half). The v2 sweep additionally
 * flags an edge whose stamp differs from (source credence × support) by more
 * than epsilon and regrades its target.
 *
 * Because the sweep now recovers BOTH stale-stamped and never-stamped
 * evidence, the v1 name no longer says what the function does; the v2 export
 * is pinned as runBeliefRecoverySweep (same result shape: the regraded node
 * ids). It is reached through a namespace import + cast — the standard
 * pattern in this suite for exports that do not exist yet, keeping the red a
 * readable TypeError/assertion instead of a module link failure.
 *
 * The trigger the sweep writes on movements ('recovery-sweep', spec §5) is
 * pinned in beliefMovementTriggersV2.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';
import { expectedBeliefCredenceProjection } from './helpers/beliefEvidenceMassExpectations';

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// What one recovery sweep reports: the ids of every node it regraded.
interface BeliefRecoverySweepResult {
  regradedNodeIds: number[];
}

// Import the recovery module bound to the current database generation and
// hand back the v2 sweep entry point (undefined until implemented — that
// missing export is this file's red).
async function importBeliefRecoverySweep(): Promise<
  () => Promise<BeliefRecoverySweepResult>
> {
  const beliefRecoveryModule = (await import(
    '@/services/belief/beliefRecoveryService'
  )) as unknown as {
    runBeliefRecoverySweep: () => Promise<BeliefRecoverySweepResult>;
  };
  return beliefRecoveryModule.runBeliefRecoverySweep;
}

describe('belief recovery sweep detects stale stamps (v2)', () => {
  // The new detection: a stamp written at source credence 0.5 goes stale when
  // the source's stored credence moves to 0.9 OUTSIDE the engine (the raw
  // UPDATE below stands in for any write path that bypassed the sweep, e.g. a
  // pre-propagation database). The sweep must notice |0.4 − 0.72| > epsilon,
  // regrade the target from the live credence, and refresh the stamp.
  it('flags an edge whose stamp differs from source credence × support and regrades its target', async () => {
    db = await openTempBeliefDatabase();
    const expertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'expert whose credence moves behind the stamp',
      beliefCredence: 0.5,
    });
    const claimNodeId = db.insertNodeFixture({ title: 'claim with a soon-stale stamp' });
    const evidenceEdgeId = db.insertEvidenceEdgeFixture({
      fromNodeId: expertNodeId,
      toNodeId: claimNodeId,
      support: 0.8,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    // Precondition: stamped at 0.5 × 0.8 = 0.4 from the original credence.
    expect(Number(db.readEvidenceStamp(evidenceEdgeId))).toBeCloseTo(0.4, 10);

    // The source's credence moves without any engine write path running.
    db.sqlite
      .prepare('UPDATE nodes SET belief_credence = ? WHERE id = ?')
      .run(0.9, expertNodeId);
    const runBeliefRecoverySweep = await importBeliefRecoverySweep();
    const sweepResult = await runBeliefRecoverySweep();

    expect(sweepResult.regradedNodeIds).toContain(claimNodeId);
    // Regraded from the LIVE credence: contribution 0.72 → 0.72/2.72.
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredenceProjection(0.72, 0),
      10
    );
    // And the stamp is fresh again.
    expect(Number(db.readEvidenceStamp(evidenceEdgeId))).toBeCloseTo(0.72, 10);
  });

  // The v1 duty carries over: evidence that was never stamped at all (e.g.
  // written by the standalone server while the app was closed) is still
  // recovered by the same sweep.
  it('still regrades a node whose evidence was never stamped (contribution IS NULL)', async () => {
    db = await openTempBeliefDatabase();
    const expertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'expert behind offline-written evidence',
      beliefCredence: 0.9,
    });
    const claimNodeId = db.insertNodeFixture({ title: 'claim with unstamped evidence' });
    const offlineEvidenceEdgeId = db.insertEvidenceEdgeFixture({
      fromNodeId: expertNodeId,
      toNodeId: claimNodeId,
      support: 0.5,
    });
    const runBeliefRecoverySweep = await importBeliefRecoverySweep();

    const sweepResult = await runBeliefRecoverySweep();

    expect(sweepResult.regradedNodeIds).toContain(claimNodeId);
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredenceProjection(0.45, 0),
      10
    );
    expect(Number(db.readEvidenceStamp(offlineEvidenceEdgeId))).toBeCloseTo(0.45, 10);
  });

  // Idempotence: regrading refreshes every stamp, so an immediate second
  // sweep must find nothing left to do — neither NULL stamps nor stale ones.
  it('finds nothing on a second sweep over the graph it just recovered', async () => {
    db = await openTempBeliefDatabase();
    const expertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'expert for the idempotence check',
      beliefCredence: 0.7,
    });
    const claimNodeId = db.insertNodeFixture({ title: 'claim recovered once' });
    db.insertEvidenceEdgeFixture({
      fromNodeId: expertNodeId,
      toNodeId: claimNodeId,
      support: 0.6,
    });
    const runBeliefRecoverySweep = await importBeliefRecoverySweep();
    const firstSweepResult = await runBeliefRecoverySweep();
    expect(firstSweepResult.regradedNodeIds).toContain(claimNodeId);

    const secondSweepResult = await runBeliefRecoverySweep();

    expect(secondSweepResult.regradedNodeIds).toHaveLength(0);
  });

  // GUARD: an edge with NULL support is not evidence at all, so it is never
  // pending work — not for the NULL-stamp rule and not for the stale rule.
  it('GUARD: a non-evidence edge (NULL support) is never picked up by the sweep', async () => {
    db = await openTempBeliefDatabase();
    const gradedNeighbourNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'graded neighbour on a plain edge',
      beliefCredence: 0.9,
    });
    const plainTargetNodeId = db.insertNodeFixture({ title: 'target of a plain edge' });
    db.insertNonEvidenceEdgeFixture({
      fromNodeId: gradedNeighbourNodeId,
      toNodeId: plainTargetNodeId,
    });
    const runBeliefRecoverySweep = await importBeliefRecoverySweep();

    const sweepResult = await runBeliefRecoverySweep();

    expect(sweepResult.regradedNodeIds).not.toContain(plainTargetNodeId);
    expect(db.readNodeBelief(plainTargetNodeId).belief_credence).toBeNull();
  });
});
