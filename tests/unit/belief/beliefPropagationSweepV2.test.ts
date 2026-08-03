/**
 * Behaviour tests for the v2 PROPAGATION SWEEP
 * (docs/belief-model-subjective-logic.md §4) against a real temp-file SQLite
 * database (see tempBeliefDatabase.ts for the safety seam).
 *
 * The one-node recompute becomes a sweep: when a regraded node's projected
 * credence moves by more than BELIEF_CREDENCE_CHANGE_EPSILON, every target of
 * its OUTGOING evidence edges is enqueued for regrade in the same sweep, with
 * a visited set (each node regrades at most once per sweep — the echo guard
 * that terminates cycles). Fixed-credence nodes are never regraded but their
 * targets are enqueued when the fixed node itself was the write target, which
 * only happens via set/clear-fixed.
 *
 * Pinned here:
 *  - one hop: regrading a node regrades the targets of its outgoing evidence,
 *  - two hops: a source-credence change reaches a target two evidence edges
 *    away — the v1 stale-credence bug (audit finding 3) as a failing test,
 *  - propagation writes movement rows with trigger 'propagation' (spec §5),
 *  - a cycle A→B→A terminates with each node regraded at most once per sweep,
 *  - a fixed node in the sweep's path is never regraded (GUARD; already true
 *    for v1's single-node recompute, restated so the sweep cannot regress it).
 *
 * Credence expectations use the v2 projection (r − s)/(r + s + 2) via the
 * shared hand-calculation helper, so every number is reproducible from §2.
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

// A three-node evidence chain expert → middle → downstream, the minimal graph
// on which propagation is observable: regrading the middle node must reach
// the downstream node through the middle's outgoing evidence edge.
interface EvidenceChainFixture {
  // The fixed-credence bootstrap source at the head of the chain.
  expertNodeId: number;
  // The node directly fed by the expert; the sweep's first regrade target.
  middleNodeId: number;
  // The node fed only by the middle node; only propagation can grade it.
  downstreamNodeId: number;
}

// Build the chain with support 1.0 on both edges so the arithmetic below
// stays a bare projection of the source credences.
function seedEvidenceChain(
  context: TempBeliefDatabase,
  expertBeliefCredence: number
): EvidenceChainFixture {
  const expertNodeId = context.insertFixedBeliefCredenceNodeFixture({
    title: 'fixed expert at the head of the chain',
    beliefCredence: expertBeliefCredence,
  });
  const middleNodeId = context.insertNodeFixture({ title: 'middle node fed by the expert' });
  const downstreamNodeId = context.insertNodeFixture({
    title: 'downstream node fed only by the middle node',
  });
  context.insertEvidenceEdgeFixture({
    fromNodeId: expertNodeId,
    toNodeId: middleNodeId,
    support: 1.0,
  });
  context.insertEvidenceEdgeFixture({
    fromNodeId: middleNodeId,
    toNodeId: downstreamNodeId,
    support: 1.0,
  });
  return { expertNodeId, middleNodeId, downstreamNodeId };
}

describe('propagation sweep (v2)', () => {
  // The core hop: regrading the middle node must regrade the downstream
  // target of its outgoing evidence edge IN THE SAME SWEEP — under v1 the
  // downstream node stays NULL forever, which is this test's red.
  it('regrading a node regrades the targets of its outgoing evidence edges in the same sweep', async () => {
    db = await openTempBeliefDatabase();
    const { middleNodeId, downstreamNodeId } = seedEvidenceChain(db, 0.9);
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(middleNodeId);

    // Middle: one +0.9 contribution → 0.9/2.9 (§3 row 2 arithmetic).
    const middleBeliefCredence = Number(db.readNodeBelief(middleNodeId).belief_credence);
    expect(middleBeliefCredence).toBeCloseTo(expectedBeliefCredenceProjection(0.9, 0), 10);
    // Downstream: graded by propagation from the middle's fresh credence.
    const downstreamBeliefCredence = db.readNodeBelief(downstreamNodeId).belief_credence;
    expect(downstreamBeliefCredence, 'propagation must grade the downstream node').not.toBeNull();
    expect(Number(downstreamBeliefCredence)).toBeCloseTo(
      expectedBeliefCredenceProjection(middleBeliefCredence, 0),
      10
    );
  });

  // Spec §5: nodes regraded BY the sweep (not the write target itself) log
  // their movement with trigger 'propagation'.
  it("logs the downstream regrade with movement trigger 'propagation'", async () => {
    db = await openTempBeliefDatabase();
    const { middleNodeId, downstreamNodeId } = seedEvidenceChain(db, 0.9);
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(middleNodeId);

    const downstreamMovements = db.readBeliefMovements(downstreamNodeId);
    expect(downstreamMovements.length).toBeGreaterThan(0);
    expect(downstreamMovements[downstreamMovements.length - 1].trigger).toBe('propagation');
  });

  // Audit finding 3 as a test: after the chain is graded, moving the expert's
  // asserted credence must reach the node TWO hops away. Under v1,
  // setBeliefFixedCredence regrades nothing at all, so both the middle and
  // the downstream node keep stale credences forever.
  it('a fixed-credence change propagates two hops to a downstream target', async () => {
    db = await openTempBeliefDatabase();
    const { expertNodeId, middleNodeId, downstreamNodeId } = seedEvidenceChain(db, 0.5);
    const { recomputeNodeBelief } = await db.importBeliefService();
    // Grade the chain once at expert credence 0.5, so both downstream nodes
    // hold real (soon-to-be-stale) credences.
    await recomputeNodeBelief(middleNodeId);
    await recomputeNodeBelief(downstreamNodeId);
    const staleMiddleBeliefCredence = Number(db.readNodeBelief(middleNodeId).belief_credence);

    // The write that must sweep: the expert's asserted credence moves. The
    // import happens after the temp database opened, per the helper's rule.
    const { setBeliefFixedCredence } = await import('@/services/belief/beliefFixedCredence');
    setBeliefFixedCredence(expertNodeId, 0.9);

    // Middle regraded from the new assertion: +0.9 → 0.9/2.9.
    const sweptMiddleBeliefCredence = Number(db.readNodeBelief(middleNodeId).belief_credence);
    expect(sweptMiddleBeliefCredence).toBeCloseTo(expectedBeliefCredenceProjection(0.9, 0), 10);
    expect(sweptMiddleBeliefCredence).not.toBeCloseTo(staleMiddleBeliefCredence, 10);
    // Downstream regraded from the middle's NEW credence — the two-hop reach
    // v1 never had.
    expect(Number(db.readNodeBelief(downstreamNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredenceProjection(sweptMiddleBeliefCredence, 0),
      10
    );
  });

  // The echo guard: in a cycle A→B→A the sweep terminates because a visited
  // node is never re-entered, and each node regrades AT MOST ONCE per sweep —
  // observable as at most one new movement row per node for the one write.
  it('a cycle A→B→A terminates with each node regraded at most once per sweep', async () => {
    db = await openTempBeliefDatabase();
    // A fixed seed feeds A, and A and B form the evidence cycle.
    const seedExpertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed seed feeding the cycle',
      beliefCredence: 0.9,
    });
    const cycleNodeAId = db.insertNodeFixture({ title: 'cycle node A' });
    const cycleNodeBId = db.insertNodeFixture({ title: 'cycle node B' });
    db.insertEvidenceEdgeFixture({ fromNodeId: seedExpertNodeId, toNodeId: cycleNodeAId, support: 1.0 });
    db.insertEvidenceEdgeFixture({ fromNodeId: cycleNodeAId, toNodeId: cycleNodeBId, support: 1.0 });
    db.insertEvidenceEdgeFixture({ fromNodeId: cycleNodeBId, toNodeId: cycleNodeAId, support: 1.0 });
    const { recomputeNodeBelief } = await db.importBeliefService();

    // If the sweep has no visited set this call never returns; its returning
    // at all is the termination proof.
    await recomputeNodeBelief(cycleNodeAId);

    // One sweep, at most one regrade per node: at most one movement row each.
    expect(db.readBeliefMovements(cycleNodeAId).length).toBeLessThanOrEqual(1);
    expect(db.readBeliefMovements(cycleNodeBId).length).toBeLessThanOrEqual(1);
    // And B really was reached through the cycle's forward edge.
    expect(db.readNodeBelief(cycleNodeBId).belief_credence).not.toBeNull();
  });

  // GUARD (spec §4 point 5): a fixed-credence node reached by the sweep is
  // never regraded — its asserted credence and empty movement log survive a
  // sweep washing over it. Already true of v1's single-node recompute;
  // restated so the sweep cannot regress it.
  it('GUARD: a fixed node reached by the sweep keeps its asserted credence and logs nothing', async () => {
    db = await openTempBeliefDatabase();
    const { middleNodeId } = seedEvidenceChain(db, 0.9);
    // A fixed node sitting where the sweep will arrive: fed by the middle node.
    const fixedTargetNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed node in the sweep path',
      beliefCredence: 0.2,
    });
    db.insertEvidenceEdgeFixture({
      fromNodeId: middleNodeId,
      toNodeId: fixedTargetNodeId,
      support: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(middleNodeId);

    expect(Number(db.readNodeBelief(fixedTargetNodeId).belief_credence)).toBeCloseTo(0.2, 10);
    expect(db.readNodeBeliefCredenceIsFixed(fixedTargetNodeId)).toBe(1);
    expect(db.readBeliefMovements(fixedTargetNodeId)).toHaveLength(0);
  });
});
