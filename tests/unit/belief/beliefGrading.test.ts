/**
 * Behavior tests for recomputeNodeBelief against a real temp-file SQLite
 * database (see tempBeliefDatabase.ts for the safety seam).
 *
 * SOURCES ARE NODES. A source's influence over the evidence it supplies is
 * its OWN nodes.belief_credence — the same number and the same word as any
 * other node's belief. The separate belief_source_trust table and the
 * trustOriginKey-in-metadata convention that used to supply that number are
 * deleted, so nothing outside the nodes table takes part in grading.
 *
 * DIRECTION (canon, docs/belief-model-subjective-logic.md §8): an evidence
 * edge runs Derivative→Source — the graded (derived) node is the edge's
 * FROM end, and the source whose credence weights the evidence is the
 * edge's TARGET (to_node_id). A node's evidence basis is its OUTGOING
 * support-bearing edges.
 *
 * Semantics pinned here:
 *  - WEIGHT: an evidence edge's contribution is its UNSIGNED
 *    belief_evidence_support (0..1) × the SOURCE node's (the edge target's)
 *    own SIGNED belief_credence. Credence is the ONLY signed term, so a
 *    contribution is negative exactly when the source is disbelieved
 *  - GATE: a source (edge target) with a NULL belief_credence has never been
 *    graded, so its edge is skipped entirely — no contribution, no stamp,
 *    not counted. This is the ONLY skip: there is no clamp any more
 *  - COUNTED NEGATIVES: a source we disbelieve (negative credence) IS
 *    counted — its edge is stamped with its negative contribution and that
 *    contribution feeds the contradiction mass C
 *  - COUNTED ZEROS: a source at credence exactly 0 IS counted, with a
 *    contribution of 0 — a recorded judgement of zero weight, exactly as a
 *    support of 0 is. A node whose only counted contributions are all 0
 *    grades to 0 (graded-and-balanced), never NULL
 *  - STALE STAMPS CLEARED: any edge skipped by the gate has its
 *    belief_evidence_contribution put back to NULL, because a stamp from an
 *    earlier recompute is wrong once the source's credence has moved
 *  - FIXED CREDENCE: a node with belief_credence_is_fixed set has its
 *    credence ASSERTED by a human, not derived from the graph, so a recompute
 *    leaves it completely alone
 *  - recompute persists nodes.belief_credence + belief_computed_at, stamps
 *    edges.belief_evidence_contribution for counted edges only, and appends a
 *    belief_movements row only when the credence actually changed
 *
 * The static import of beliefGradingPolicy is safe (pure constants module);
 * everything database-bound is imported through the helper context.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEUTRAL_BELIEF_CREDENCE } from '@/services/belief/beliefGradingPolicy';
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

// Expected credence for a for mass r (summed positive contributions) and an
// against mass s (summed |negative| contributions) under the pinned v2
// projection formula of docs/belief-model-subjective-logic.md §2:
// (r − s)/(r + s + W), W = 2. The 2 is a deliberate hand literal, exactly as
// in helpers/beliefEvidenceMassExpectations.ts: the independent calculation
// must not import the constant it is checking. EDITED per §3 (every v1
// exponential expectation in this file moves to the projection).
function expectedBeliefCredence(supportSum: number, contradictionSum: number): number {
  return (supportSum - contradictionSum) / (supportSum + contradictionSum + 2);
}

// Create a claim node plus one evidence source node, joined by one evidence
// edge in canon direction (claim→source: "my credence derives from you")
// whose UNSIGNED support runs 0..1 (how loudly the source speaks about the
// claim). sourceBeliefCredence is the source node's OWN signed credence —
// the weight AND the sign its evidence carries; omit it for a source nobody
// has graded, whose credence is NULL. Returns all the ids.
function seedClaimWithOneEvidenceEdge(
  context: TempBeliefDatabase,
  options: {
    support: number;
    sourceBeliefCredence?: number;
  }
): { claimNodeId: number; sourceNodeId: number; edgeId: number } {
  const claimNodeId = context.insertNodeFixture({ title: 'claim under test' });
  const sourceNodeId = context.insertNodeFixture({
    title: `evidence source at credence ${options.sourceBeliefCredence ?? 'ungraded'}`,
    beliefCredence: options.sourceBeliefCredence,
  });
  const edgeId = context.insertEvidenceEdgeFixture({
    derivedNodeId: claimNodeId,
    sourceNodeId,
    support: options.support,
  });
  return { claimNodeId, sourceNodeId, edgeId };
}

// Add one more evidence edge, from the existing claim node to a BRAND-NEW
// source node (canon: the claim derives from the new source). Returns both
// ids so a test can move that one source's credence afterwards.
function addEvidenceEdgeFromNewSource(
  context: TempBeliefDatabase,
  claimNodeId: number,
  options: {
    support: number;
    sourceBeliefCredence?: number;
  }
): { sourceNodeId: number; edgeId: number } {
  const sourceNodeId = context.insertNodeFixture({
    title: `extra evidence source at credence ${options.sourceBeliefCredence ?? 'ungraded'} for support ${options.support}`,
    beliefCredence: options.sourceBeliefCredence,
  });
  const edgeId = context.insertEvidenceEdgeFixture({
    derivedNodeId: claimNodeId,
    sourceNodeId,
    support: options.support,
  });
  return { sourceNodeId, edgeId };
}

describe('recomputeNodeBelief grading behavior', () => {
  // 1. Ungraded is a real state: no evidence means belief stays NULL (not
  //    0.5) and no movement is recorded.
  it('leaves an evidence-free node ungraded (belief_credence NULL) and records no movement', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'lonely claim' });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    expect(result.beliefCredence).toBeNull();
    expect(result.movement).toBeNull();
    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeNull();
    expect(db.readBeliefMovements(claimNodeId)).toHaveLength(0);
  });

  // 2a. Any lone support must push belief above the prior.
  it('grades a node with a single supporting edge above the prior', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.6,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeGreaterThan(NEUTRAL_BELIEF_CREDENCE);
  });

  // 2b. Any lone contradiction must push belief below the prior. REWRITTEN
  //     for unsigned support: a contradiction is now evidence from a source
  //     we DISBELIEVE (negative credence), not a negative support.
  it('grades a node whose only evidence comes from a disbelieved source below the prior', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.6,
      sourceBeliefCredence: -1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeLessThan(NEUTRAL_BELIEF_CREDENCE);
  });

  // 3. Exact anchor: support 1.0 from a source at credence 1.0 lands
  //    precisely on the formula anchor, pinned to 10 decimal places, and the
  //    computed-at timestamp is stamped.
  it('grades one full support from a fully credible source to the exact formula anchor', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 1.0,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    const anchor = expectedBeliefCredence(1.0, 0);
    expect(result.beliefCredence).toBeCloseTo(anchor, 10);
    const persisted = db.readNodeBelief(claimNodeId);
    expect(persisted.belief_credence).toBeCloseTo(anchor, 10);
    expect(persisted.belief_computed_at).toBeTruthy();
  });

  // 4a. Monotonic: a second INDEPENDENT support must raise the credence.
  it('raises belief when a second independent support is added', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.6,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const credenceAfterFirstSupport = db.readNodeBelief(claimNodeId).belief_credence;

    addEvidenceEdgeFromNewSource(db, claimNodeId, {
      support: 0.6,
      sourceBeliefCredence: 1.0,
    });
    await recomputeNodeBelief(claimNodeId);
    const credenceAfterSecondSupport = db.readNodeBelief(claimNodeId).belief_credence;

    expect(credenceAfterSecondSupport).toBeGreaterThan(Number(credenceAfterFirstSupport));
  });

  // 4b. Saturating: the second support's increment must be smaller than the
  //     first support's increment.
  it('gives the second independent support a smaller increment than the first (saturation)', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.6,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const credenceAfterFirstSupport = Number(db.readNodeBelief(claimNodeId).belief_credence);

    addEvidenceEdgeFromNewSource(db, claimNodeId, {
      support: 0.6,
      sourceBeliefCredence: 1.0,
    });
    await recomputeNodeBelief(claimNodeId);
    const credenceAfterSecondSupport = Number(db.readNodeBelief(claimNodeId).belief_credence);

    const firstIncrement = credenceAfterFirstSupport - NEUTRAL_BELIEF_CREDENCE;
    const secondIncrement = credenceAfterSecondSupport - credenceAfterFirstSupport;
    expect(secondIncrement).toBeGreaterThan(0);
    expect(secondIncrement).toBeLessThan(firstIncrement);
  });

  // 5a. Upper bound: even ten strong independent supports never reach 1.
  it('keeps belief strictly below 1 under ten strong independent supports', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'heavily supported claim' });
    for (let supportIndex = 0; supportIndex < 10; supportIndex += 1) {
      addEvidenceEdgeFromNewSource(db, claimNodeId, {
        support: 1.0,
        sourceBeliefCredence: 1.0,
      });
    }
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const beliefCredence = Number(db.readNodeBelief(claimNodeId).belief_credence);
    expect(beliefCredence).toBeGreaterThan(NEUTRAL_BELIEF_CREDENCE);
    expect(beliefCredence).toBeLessThan(1);
  });

  // 5b. Lower bound: even ten strong independent contradictions never reach
  //     -1 (the open-signed-scale floor, replacing the old 0..1 scale's 0).
  //     REWRITTEN for unsigned support: each contradiction is full-strength
  //     evidence (support 1.0) from a fully DISBELIEVED source (credence -1).
  it('keeps belief strictly above -1 under ten strong independent contradictions', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'heavily contradicted claim' });
    for (let contradictionIndex = 0; contradictionIndex < 10; contradictionIndex += 1) {
      addEvidenceEdgeFromNewSource(db, claimNodeId, {
        support: 1.0,
        sourceBeliefCredence: -1.0,
      });
    }
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const beliefCredence = Number(db.readNodeBelief(claimNodeId).belief_credence);
    expect(beliefCredence).toBeLessThan(NEUTRAL_BELIEF_CREDENCE);
    // Open-scale floor: heavy contradiction approaches -1 but must never
    // reach or pass it (the old scale's floor of 0 no longer applies).
    expect(beliefCredence).toBeGreaterThan(-1);
  });

  // 6a. Repetition reinforces: an equal-strength repeat from the SAME source
  //     node STACKS instead of being ignored, so the repeat must raise belief
  //     — S = 0.7 + 0.7 = 1.4, landing on the summed-mass anchor, strictly
  //     above the single-edge credence.
  it('reinforcement: an equal-strength repeat from the same source node raises belief (stacks)', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, sourceNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.7,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const credenceBeforeRepeat = Number(db.readNodeBelief(claimNodeId).belief_credence);

    // Second edge to the SAME source node — this is what "repetition" means
    // now that a source is just a node.
    db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId,
      support: 0.7,
    });
    await recomputeNodeBelief(claimNodeId);
    const credenceAfterRepeat = Number(db.readNodeBelief(claimNodeId).belief_credence);

    expect(credenceAfterRepeat).toBeGreaterThan(credenceBeforeRepeat);
    expect(credenceAfterRepeat).toBeCloseTo(expectedBeliefCredence(0.7 + 0.7, 0), 10);
  });

  // 6b. A stronger repeat from the same source node does not replace the
  //     weaker one — both count, so S = 0.7 + 0.9 = 1.6, not just the
  //     stronger edge's 0.9 alone.
  it('reinforcement: a stronger contribution from the same source node adds to the weaker (stacks)', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, sourceNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.7,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);

    db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId,
      support: 0.9,
    });
    await recomputeNodeBelief(claimNodeId);

    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredence(0.7 + 0.9, 0),
      10
    );
  });

  // 7a. Weighting vs. non-counting: a same-support edge from a source at
  //     credence 0.9 grades to a real positive number, while an edge from a
  //     source nobody has graded (credence NULL) is not counted at all, so
  //     that claim's belief stays NULL — not merely a smaller number.
  it('grades a 0.9-credence source to a real credence; an ungraded source is not counted (NULL)', async () => {
    db = await openTempBeliefDatabase();
    const credibleSourceClaim = seedClaimWithOneEvidenceEdge(db, {
      support: 1.0,
      sourceBeliefCredence: 0.9,
    });
    // Second claim: its source node has never been graded, so its only
    // evidence edge is excluded from grading entirely.
    const ungradedSourceClaim = seedClaimWithOneEvidenceEdge(db, {
      support: 1.0,
      // no sourceBeliefCredence: deliberately ungraded (NULL)
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(credibleSourceClaim.claimNodeId);
    await recomputeNodeBelief(ungradedSourceClaim.claimNodeId);

    const credibleSourceCredence = Number(
      db.readNodeBelief(credibleSourceClaim.claimNodeId).belief_credence
    );
    expect(Number.isFinite(credibleSourceCredence)).toBe(true);
    expect(credibleSourceCredence).toBeGreaterThan(0);
    expect(db.readNodeBelief(ungradedSourceClaim.claimNodeId).belief_credence).toBeNull();
  });

  // 7b. The gate is exact: a support edge whose source (edge target) has a NULL
  //     belief_credence contributes zero evidence mass and leaves the claim
  //     ungraded (NULL) — no default weight is ever invented for it.
  it('a support from a source with NULL belief_credence is not counted — the claim stays NULL', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim with ungraded evidence' });
    // Source node that has never been graded: belief_credence NULL.
    const ungradedSourceNodeId = db.insertNodeFixture({ title: 'ungraded evidence source' });
    const ungradedSourceEdgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId: ungradedSourceNodeId,
      support: 1.0,
    });
    // Positive control: an identical claim fed by a GRADED source, so a NULL
    // above means the gate fired rather than the engine grading nothing at all.
    const controlClaim = seedClaimWithOneEvidenceEdge(db, {
      support: 1.0,
      sourceBeliefCredence: 0.9,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);
    await recomputeNodeBelief(controlClaim.claimNodeId);

    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeNull();
    expect(result.contributions).toHaveLength(0);
    expect(db.readEvidenceStamp(ungradedSourceEdgeId)).toBeNull();
    expect(db.readNodeBelief(controlClaim.claimNodeId).belief_credence).not.toBeNull();
  });

  // 7c. The deleted convention: a trustOriginKey in the source node's
  //     metadata is just data now. It must NOT resurrect the source — a node
  //     carrying that key with a NULL belief_credence is still ungraded, so
  //     its evidence is still skipped.
  it('a trustOriginKey in the source node metadata does not grade anything — only belief_credence does', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim fed by a legacy-metadata source' });
    // A source node from the old world: metadata still carries the origin key
    // the deleted lookup used, but the node itself has no credence.
    const legacyMetadataSourceNodeId = db.insertNodeFixture({
      title: 'source still carrying a legacy trustOriginKey in metadata',
    });
    db.sqlite
      .prepare('UPDATE nodes SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ trustOriginKey: 'origin-legacy' }), legacyMetadataSourceNodeId);
    db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId: legacyMetadataSourceNodeId,
      support: 1.0,
    });
    // Positive control fed by a source with a real credence, so the NULL
    // below cannot be "nothing grades at all".
    const controlClaim = seedClaimWithOneEvidenceEdge(db, {
      support: 1.0,
      sourceBeliefCredence: 0.9,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);
    await recomputeNodeBelief(controlClaim.claimNodeId);

    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeNull();
    expect(db.readNodeBelief(controlClaim.claimNodeId).belief_credence).not.toBeNull();
  });

  // 8. A contradiction arriving after support must lower the credence below the
  //    support-only level, exactly per the formula. REWRITTEN for unsigned
  //    support: the contradiction is support 0.5 from a fully DISBELIEVED
  //    source (credence -1), contributing -0.5 to the contradiction mass.
  it('lowers belief below the support-only level when a disbelieved-source contradiction is added', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const supportOnlyCredence = Number(db.readNodeBelief(claimNodeId).belief_credence);

    addEvidenceEdgeFromNewSource(db, claimNodeId, {
      support: 0.5,
      sourceBeliefCredence: -1.0,
    });
    await recomputeNodeBelief(claimNodeId);
    const mixedEvidenceCredence = Number(db.readNodeBelief(claimNodeId).belief_credence);

    expect(mixedEvidenceCredence).toBeLessThan(supportOnlyCredence);
    expect(mixedEvidenceCredence).toBeCloseTo(expectedBeliefCredence(0.8, 0.5), 10);
  });

  // 9a. Movements: the FIRST grading of a node appends one movement row with
  //     from_credence NULL (there was no previous credence).
  it('appends one movement row with NULL from_credence on first grading', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.6,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const movements = db.readBeliefMovements(claimNodeId);
    expect(movements).toHaveLength(1);
    expect(movements[0].from_credence).toBeNull();
    expect(movements[0].to_credence).toBeCloseTo(
      Number(db.readNodeBelief(claimNodeId).belief_credence),
      10
    );
    expect(movements[0].trigger).toBeTruthy();
    expect(movements[0].occurred_at).toBeTruthy();
  });

  // 9a-bis. The RETURNED movement record names the quantity the same way the
  //     column does: fromCredence / toCredence, and nothing else. Pinning the
  //     exact key set stops a leftover fromValue / toValue surviving beside
  //     the renamed fields.
  it('returns a movement record whose fields are fromCredence, toCredence and trigger', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.6,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    expect(result.movement).not.toBeNull();
    const firstMovement = result.movement!;
    expect(Object.keys(firstMovement).sort()).toEqual(['fromCredence', 'toCredence', 'trigger']);
    // First grading: there was no previous credence.
    expect(firstMovement.fromCredence).toBeNull();
    expect(firstMovement.toCredence).toBeCloseTo(Number(result.beliefCredence), 10);
  });

  // 9b. Movements: recomputing with nothing changed (within 1e-12) must not
  //     append another row.
  it('appends no movement row when a recompute produces an unchanged credence', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.6,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);

    const secondResult = await recomputeNodeBelief(claimNodeId);

    expect(secondResult.movement).toBeNull();
    expect(db.readBeliefMovements(claimNodeId)).toHaveLength(1);
  });

  // 10. Edge stamping vs. non-counting: after a recompute, a COUNTED evidence
  //     edge carries its signed contribution (support × source credence) in
  //     belief_evidence_contribution and is reported in result.contributions;
  //     an edge from an ungraded source is excluded from grading, left
  //     unstamped (NULL), and does NOT appear in result.contributions. The
  //     claim's credence comes from the counted support alone.
  it('only edges from graded sources are counted and stamped; ungraded-source edges stay NULL', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId: supportEdgeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: 0.9,
    });
    // Second edge from a source nobody has graded: excluded from grading and
    // stamping entirely (an ungraded source has no number to multiply by).
    const { edgeId: contradictionEdgeId } = addEvidenceEdgeFromNewSource(db, claimNodeId, {
      support: 0.5,
      // no sourceBeliefCredence: deliberately ungraded
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    const expectedSupportContribution = 0.8 * 0.9;
    // Claim grades from the counted support alone; the ungraded-source
    // edge contributes zero mass.
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredence(expectedSupportContribution, 0),
      10
    );
    expect(Number(db.readEvidenceStamp(supportEdgeId))).toBeCloseTo(
      expectedSupportContribution,
      10
    );
    // Ungraded-source edge is left unstamped.
    expect(db.readEvidenceStamp(contradictionEdgeId)).toBeNull();
    const reportedEdgeIds = result.contributions.map(entry => entry.edgeId);
    expect(reportedEdgeIds).toEqual([supportEdgeId]);
  });

  // 10b. Mixed graded + ungraded support: the claim must grade from the
  //      counted edge alone (support 0.8 at credence 1.0 -> S = 0.8), and the
  //      ungraded-source support edge must add nothing to that mass — so the
  //      graded credence is strictly less than it would be if the ungraded
  //      edge's support were also counted.
  it('grades only from graded-source support when an ungraded-source support is also present', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: 1.0,
    });
    // Second support edge from a source with no credence: must be excluded
    // from the graded mass entirely.
    const ungradedSourceSupport = 0.6;
    addEvidenceEdgeFromNewSource(db, claimNodeId, {
      support: ungradedSourceSupport,
      // no sourceBeliefCredence: deliberately ungraded
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const beliefCredence = Number(db.readNodeBelief(claimNodeId).belief_credence);
    expect(beliefCredence).toBeCloseTo(expectedBeliefCredence(0.8, 0), 10);
    // If the ungraded edge's support had also been counted, the credence
    // would be strictly higher — confirms it was excluded, not down-weighted.
    expect(beliefCredence).toBeLessThan(expectedBeliefCredence(0.8 + ungradedSourceSupport, 0));
  });

  // 13. The evidence marker: "belief_evidence_support IS NOT NULL" is the
  //     ONLY thing that makes an edge evidence. A plain edge from a fully
  //     credible source carries no support, so it must be invisible to
  //     grading — the claim stays ungraded and the edge is never stamped or
  //     reported.
  it('an edge with NULL belief_evidence_support is not evidence and contributes nothing', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim with only a plain neighbour' });
    // Deliberately CREDIBLE: if the edge were treated as evidence, this
    // source's credence would let it grade — so a NULL credence on the claim
    // proves the edge itself was excluded, not its source.
    const credibleSourceNodeId = db.insertNodeFixture({
      title: 'credible source joined by a plain edge',
      beliefCredence: 1.0,
    });
    // Canon arrangement: the plain edge runs claim→source, exactly where an
    // evidence edge would sit — so only the NULL support keeps it out.
    const plainEdgeId = db.insertNonEvidenceEdgeFixture({
      fromNodeId: claimNodeId,
      toNodeId: credibleSourceNodeId,
    });
    // Precondition: the marker column this test is about actually exists, so
    // "no credence" below means "support was NULL", not "there is no support
    // column and every edge is invisible".
    expect(db.readTableColumns('edges').map(column => column.name)).toContain(
      'belief_evidence_support'
    );
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    expect(result.beliefCredence).toBeNull();
    expect(result.contributions).toHaveLength(0);
    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeNull();
    expect(db.readEvidenceStamp(plainEdgeId)).toBeNull();
  });

  // 13b. The other half of the contrast with test 13, and the behavioural
  //      point of allowing a zero support. Support carries the same two
  //      states credence does on a node: NULL means never assessed, 0 means
  //      assessed and leaning neither way. So a support of 0 from a CREDIBLE
  //      source IS evidence — it is counted, reported and stamped — even
  //      though it adds nothing to either mass. The claim is therefore GRADED
  //      (to the neutral credence), not left ungraded like the NULL case
  //      immediately above.
  //
  //      Note the deliberate SYMMETRY with the zero-credence tests below:
  //      a zero SUPPORT from a credible source and a zero CREDENCE behind a
  //      real support are both recorded judgements of zero weight, and BOTH
  //      count — the only thing that ever skips an edge is a source nobody
  //      has graded (credence NULL).
  it('an edge with a support of 0 from a credible source is evidence: counted, stamped, and the claim is graded', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId: neutralEvidenceEdgeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    // Counted: the edge reaches the grading policy and is reported back.
    expect(result.contributions.map(entry => entry.edgeId)).toEqual([neutralEvidenceEdgeId]);
    // Graded, NOT ungraded — this is what separates 0 from NULL. toBe(0)
    // rather than a null-coercing comparison, so a NULL cannot pass here.
    expect(result.beliefCredence).toBe(NEUTRAL_BELIEF_CREDENCE);
    const persistedBelief = db.readNodeBelief(claimNodeId);
    expect(persistedBelief.belief_credence).toBe(0);
    expect(persistedBelief.belief_credence).not.toBeNull();
    expect(persistedBelief.belief_computed_at).toBeTruthy();
    // Stamped with its own zero contribution (0 × 1.0), not left NULL like
    // an ungraded-source or non-evidence edge.
    expect(db.readEvidenceStamp(neutralEvidenceEdgeId)).toBe(0);
    // Going from ungraded to graded is a real movement and is logged.
    const movements = db.readBeliefMovements(claimNodeId);
    expect(movements).toHaveLength(1);
    expect(movements[0].from_credence).toBeNull();
    expect(movements[0].to_credence).toBe(0);
  });

  // 13c. Inert but present: a zero support adds nothing to the supporting or
  //      the contradicting mass, so a claim carrying a real support plus a
  //      neutral one must grade to EXACTLY the same credence as the real
  //      support alone. This is what "counted but contributes nothing" means
  //      numerically — being counted must not perturb the arithmetic.
  it('a support of 0 adds nothing to either mass — the credence matches the non-zero evidence alone', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const credenceBeforeNeutralEvidence = Number(
      db.readNodeBelief(claimNodeId).belief_credence
    );

    // Add an edge from a credible source that leans neither way.
    addEvidenceEdgeFromNewSource(db, claimNodeId, {
      support: 0,
      sourceBeliefCredence: 1.0,
    });
    const resultWithNeutralEvidence = await recomputeNodeBelief(claimNodeId);
    const credenceAfterNeutralEvidence = Number(db.readNodeBelief(claimNodeId).belief_credence);

    // Both edges are counted...
    expect(resultWithNeutralEvidence.contributions).toHaveLength(2);
    // ...but the mass is unchanged, so the credence is too.
    expect(credenceAfterNeutralEvidence).toBeCloseTo(credenceBeforeNeutralEvidence, 10);
    expect(credenceAfterNeutralEvidence).toBeCloseTo(expectedBeliefCredence(0.8, 0), 10);
    // Nothing moved, so no second movement row is appended.
    expect(resultWithNeutralEvidence.movement).toBeNull();
    expect(db.readBeliefMovements(claimNodeId)).toHaveLength(1);
  });

  // 14. Sign invariant end-to-end, REWRITTEN for unsigned support: the source
  //     node's CREDENCE is the only signed term, so a disbelieved source
  //     (credence -0.6) talking with support 0.9 must stamp a negative
  //     contribution of exactly credence × support = -0.54, and a claim with
  //     only that edge grades to (0 - 0.54)/(0.54 + 2) = -0.54/2.54 (§2): a real
  //     NEGATIVE credence, not NULL — the disbelieved source's edge is
  //     counted as contradiction mass, never silenced.
  it('stamps a disbelieved-source edge with exactly credence × support and grades the claim negative', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId: disbelievedSourceEdgeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.9,
      sourceBeliefCredence: -0.6,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    // -0.6 × 0.9 = -0.54, counted and reported, not skipped.
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0].effectiveContribution).toBeCloseTo(-0.54, 10);
    expect(Number(db.readEvidenceStamp(disbelievedSourceEdgeId))).toBeCloseTo(-0.54, 10);
    // r = 0, s = 0.54: credence = -0.54/2.54 (§2 projection), strictly negative.
    const expectedNegativeCredence = expectedBeliefCredence(0, 0.54);
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedNegativeCredence,
      10
    );
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeLessThan(0);
    // Going from ungraded to a negative credence is a real movement.
    const movements = db.readBeliefMovements(claimNodeId);
    expect(movements).toHaveLength(1);
    expect(movements[0].from_credence).toBeNull();
    expect(Number(movements[0].to_credence)).toBeCloseTo(expectedNegativeCredence, 10);
  });

  // 12. Contribution shape at the service boundary: recomputeNodeBelief must
  //     hand the grading policy contributions carrying ONLY edgeId and
  //     signedContribution — no origin key, no source identifier of any kind.
  it('passes the grading policy contributions with no beliefEvidenceOriginKey field', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.6,
      sourceBeliefCredence: 1.0,
    });
    // Spy on the SAME policy-module instance the belief service binds to
    // (both are imported after the helper reset the module registry).
    // EDITED per spec §7: the engine grades through beliefGradingPolicyV2 —
    // v1 (and its exponential) is deleted, not kept beside it.
    const beliefGradingPolicyModule = await db.importBeliefGradingPolicyModule();
    const gradeBeliefSpy = vi.spyOn(beliefGradingPolicyModule.beliefGradingPolicyV2, 'gradeBelief');
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    expect(gradeBeliefSpy).toHaveBeenCalledTimes(1);
    const gradedContributions = gradeBeliefSpy.mock.calls[0][0];
    expect(gradedContributions).toHaveLength(1);
    for (const gradedContribution of gradedContributions) {
      expect(Object.keys(gradedContribution).sort()).toEqual(['edgeId', 'signedContribution']);
    }
    gradeBeliefSpy.mockRestore();
  });

  // 11. Raising a SOURCE NODE's own credence and recomputing the claim must
  //     raise the claim's credence and append a second movement row recording
  //     the change. This replaces the old "raise the trust row" case: the
  //     number that moved is now the source node's own belief.
  it('raises belief and appends a movement when the source node credence increases', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, sourceNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 1.0,
      sourceBeliefCredence: 0.2,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const credenceAtLowSourceCredence = Number(db.readNodeBelief(claimNodeId).belief_credence);

    // The source itself becomes more believed, then the claim is regraded.
    db.setNodeBeliefCredence(sourceNodeId, 0.9);
    await recomputeNodeBelief(claimNodeId);
    const credenceAtHighSourceCredence = Number(db.readNodeBelief(claimNodeId).belief_credence);

    expect(credenceAtHighSourceCredence).toBeGreaterThan(credenceAtLowSourceCredence);
    expect(credenceAtHighSourceCredence).toBeCloseTo(expectedBeliefCredence(0.9, 0), 10);
    const movements = db.readBeliefMovements(claimNodeId);
    expect(movements).toHaveLength(2);
    expect(Number(movements[1].from_credence)).toBeCloseTo(credenceAtLowSourceCredence, 10);
    expect(movements[1].to_credence).toBeCloseTo(credenceAtHighSourceCredence, 10);
  });
});

describe('recomputeNodeBelief weights evidence by the source node credence', () => {
  // THE REAL THING, end to end: a human expert whose credence is fixed at
  // 0.9 supplies one piece of evidence with support 0.8 to a claim. The
  // claim's credence is what the v2 policy returns for a single contribution
  // of 0.8 × 0.9 = 0.72, and the edge carries that same 0.72 as its stamp.
  it('grades a claim from a fixed expert at credence 0.9 supplying support 0.8 to exactly the 0.72 contribution', async () => {
    db = await openTempBeliefDatabase();
    const expertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'Marelie, the human expert whose credence is asserted',
      beliefCredence: 0.9,
    });
    const claimNodeId = db.insertNodeFixture({ title: 'claim the expert supports' });
    const expertEvidenceEdgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId: expertNodeId,
      support: 0.8,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    // The one contribution is exactly support × the expert's own credence.
    const expertContribution = 0.8 * 0.9;
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0].edgeId).toBe(expertEvidenceEdgeId);
    expect(result.contributions[0].effectiveContribution).toBeCloseTo(expertContribution, 10);
    expect(Number(db.readEvidenceStamp(expertEvidenceEdgeId))).toBeCloseTo(expertContribution, 10);
    // The claim grades to what the v2 policy returns for that lone 0.72.
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredence(expertContribution, 0),
      10
    );
    // The expert is untouched by grading the claim: its asserted credence and
    // its fixed flag are exactly as seeded.
    expect(Number(db.readNodeBelief(expertNodeId).belief_credence)).toBeCloseTo(0.9, 10);
    expect(db.readNodeBeliefCredenceIsFixed(expertNodeId)).toBe(1);
  });

  // The weight is the source's credence and nothing else: the same support
  // from a half-credible source produces exactly half the contribution.
  it('halves the contribution when the source node credence is halved', async () => {
    db = await openTempBeliefDatabase();
    const fullCredenceClaim = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: 1.0,
    });
    const halfCredenceClaim = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: 0.5,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(fullCredenceClaim.claimNodeId);
    await recomputeNodeBelief(halfCredenceClaim.claimNodeId);

    expect(Number(db.readEvidenceStamp(fullCredenceClaim.edgeId))).toBeCloseTo(0.8, 10);
    expect(Number(db.readEvidenceStamp(halfCredenceClaim.edgeId))).toBeCloseTo(0.4, 10);
    expect(Number(db.readNodeBelief(halfCredenceClaim.claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredence(0.4, 0),
      10
    );
  });
});

describe('recomputeNodeBelief counts a disbelieved or zero-credence source', () => {
  // REWRITTEN from the clamp test "a source with negative credence casts no
  // vote". The clamp is GONE: a source we disbelieve (negative credence) IS
  // counted — its contribution is credence × support, negative exactly
  // because the source is disbelieved, and it feeds the contradiction mass C.
  // With no other evidence the claim grades to a real NEGATIVE credence, and
  // NULL is reserved for "no counted evidence at all".
  it('a source with negative credence IS counted — the claim grades negative, never NULL', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId: disbelievedSourceEdgeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: -0.9,
    });
    // Contrast control: the same edge from a BELIEVED source grades positive,
    // so the negative below is the sign of the credence carrying through.
    const controlClaim = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: 0.9,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);
    await recomputeNodeBelief(controlClaim.claimNodeId);

    // Counted: stamped with -0.9 × 0.8 = -0.72 and reported back.
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0].edgeId).toBe(disbelievedSourceEdgeId);
    expect(result.contributions[0].effectiveContribution).toBeCloseTo(-0.72, 10);
    expect(Number(db.readEvidenceStamp(disbelievedSourceEdgeId))).toBeCloseTo(-0.72, 10);
    // Graded, not NULL: r = 0, s = 0.72 -> -0.72/2.72 (§3 row 6 arithmetic), strictly negative.
    expect(Number(result.beliefCredence)).toBeCloseTo(expectedBeliefCredence(0, 0.72), 10);
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeLessThan(0);
    // Ungraded -> negative is a real movement and is logged.
    expect(db.readBeliefMovements(claimNodeId)).toHaveLength(1);
    // The believed-source mirror of the same edge grades positive.
    expect(Number(db.readNodeBelief(controlClaim.claimNodeId).belief_credence)).toBeGreaterThan(0);
  });

  // REWRITTEN from the clamp-boundary test "a source at credence exactly 0
  // casts no vote". A source at credence 0 IS counted, with a contribution of
  // exactly 0 — a recorded judgement of zero weight, consistent with how a
  // support of 0 from a credible source is treated. A claim whose only
  // counted contribution is that 0 grades to 0 (graded-and-balanced), which
  // is a DIFFERENT state from NULL (never graded).
  it('a source at credence exactly 0 is counted with contribution 0 — the claim grades to 0, not NULL', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId: tornSourceEdgeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: 0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    // Counted and reported, with a contribution of exactly 0 × 0.8 = 0.
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0].edgeId).toBe(tornSourceEdgeId);
    expect(result.contributions[0].effectiveContribution).toBe(0);
    // toBe(0), never toBeNull: the zero-credence source's edge is stamped
    // with its zero contribution — a recorded judgement, not an absence.
    expect(db.readEvidenceStamp(tornSourceEdgeId)).toBe(0);
    // Graded to 0, NOT left ungraded. toBe(0) so a NULL cannot pass.
    expect(result.beliefCredence).toBe(0);
    const persistedBelief = db.readNodeBelief(claimNodeId);
    expect(persistedBelief.belief_credence).toBe(0);
    expect(persistedBelief.belief_credence).not.toBeNull();
    expect(persistedBelief.belief_computed_at).toBeTruthy();
    // Ungraded -> graded (0) is a real movement and is logged.
    const movements = db.readBeliefMovements(claimNodeId);
    expect(movements).toHaveLength(1);
    expect(movements[0].from_credence).toBeNull();
    expect(movements[0].to_credence).toBe(0);
  });

  // REWRITTEN from "a disbelieved source subtracts nothing". It now DOES
  // subtract: mixed evidence from one believed and one disbelieved source
  // balances exactly. Believed: +0.8 × 0.5 = +0.4 of support mass. Disbelieved:
  // -0.5 × 0.8 = -0.4 of contradiction mass. S = C = 0.4, so the claim grades
  // to EXACTLY 0 — graded-and-balanced, with both edges stamped.
  it('mixed believed and disbelieved evidence balancing to S = C grades the claim to exactly 0', async () => {
    db = await openTempBeliefDatabase();
    // Believed source: credence +0.8 talking with support 0.5 -> +0.4.
    const { claimNodeId, edgeId: believedSourceEdgeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.5,
      sourceBeliefCredence: 0.8,
    });
    // Disbelieved source: credence -0.5 talking with support 0.8 -> -0.4.
    const { edgeId: disbelievedSourceEdgeId } = addEvidenceEdgeFromNewSource(db, claimNodeId, {
      support: 0.8,
      sourceBeliefCredence: -0.5,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    // Both edges are counted and stamped with their signed contributions.
    expect(result.contributions).toHaveLength(2);
    expect(Number(db.readEvidenceStamp(believedSourceEdgeId))).toBeCloseTo(0.4, 10);
    expect(Number(db.readEvidenceStamp(disbelievedSourceEdgeId))).toBeCloseTo(-0.4, 10);
    // S and C are the identical double (0.8 × 0.5 and 0.5 × 0.8), so
    // (r - s)/(r + s + 2) is exactly 0 — no tolerance needed, and toBe(0)
    // also proves the claim was GRADED to zero rather than left NULL.
    expect(result.beliefCredence).toBe(0);
    expect(db.readNodeBelief(claimNodeId).belief_credence).toBe(0);
    expect(db.readNodeBelief(claimNodeId).belief_credence).not.toBeNull();
    // First grading: NULL -> 0 is a movement and is logged as one.
    const movements = db.readBeliefMovements(claimNodeId);
    expect(movements).toHaveLength(1);
    expect(movements[0].from_credence).toBeNull();
    expect(movements[0].to_credence).toBe(0);
  });
});

describe('recomputeNodeBelief clears stale contribution stamps', () => {
  // A stamp records what a source contributed at the time it was counted. If
  // the source is later ungraded (credence back to NULL), that stamp is a
  // lie, so the recompute must clear it back to NULL rather than leave the
  // old number sitting on the edge.
  it('clears the stamp of an edge whose source credence has gone back to NULL', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, sourceNodeId, edgeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: 0.9,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    // Precondition: the stamp this test is about really was written.
    expect(Number(db.readEvidenceStamp(edgeId))).toBeCloseTo(0.72, 10);

    // The source is ungraded again, so its edge is now gated out.
    db.setNodeBeliefCredence(sourceNodeId, null);
    await recomputeNodeBelief(claimNodeId);

    expect(db.readEvidenceStamp(edgeId)).toBeNull();
    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeNull();
  });

  // REWRITTEN from "clears the stamp of an edge whose source credence has
  // fallen below zero". A source falling into disbelief no longer silences
  // its edge — the edge stays counted, so the stale POSITIVE stamp must be
  // REWRITTEN to the new NEGATIVE contribution, and the claim regrades from
  // support to contradiction instead of dropping back to NULL.
  it('restamps an edge with its negative contribution when the source credence falls below zero', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, sourceNodeId, edgeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: 0.9,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    // Precondition: the positive stamp this test watches move really exists.
    expect(Number(db.readEvidenceStamp(edgeId))).toBeCloseTo(0.72, 10);

    // We now disbelieve the source: its testimony flips to contradiction.
    db.setNodeBeliefCredence(sourceNodeId, -0.5);
    await recomputeNodeBelief(claimNodeId);

    // The stamp is the NEW contribution -0.5 × 0.8 = -0.4, not NULL and not
    // the stale +0.72.
    expect(Number(db.readEvidenceStamp(edgeId))).toBeCloseTo(-0.4, 10);
    // The claim regrades to S = 0, C = 0.4: a real negative credence.
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredence(0, 0.4),
      10
    );
  });

  // Clearing one stale stamp must not disturb the edges that are still
  // counted: a claim with two sources, one of which loses its credence, keeps
  // the surviving source's stamp and regrades to that source alone.
  it('clears only the skipped edge stamp and leaves the still-counted edge stamped', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId: survivingEdgeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.5,
      sourceBeliefCredence: 1.0,
    });
    const { sourceNodeId: fadingSourceNodeId, edgeId: fadingEdgeId } =
      addEvidenceEdgeFromNewSource(db, claimNodeId, {
        support: 0.7,
        sourceBeliefCredence: 1.0,
      });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    expect(Number(db.readEvidenceStamp(fadingEdgeId))).toBeCloseTo(0.7, 10);

    db.setNodeBeliefCredence(fadingSourceNodeId, null);
    await recomputeNodeBelief(claimNodeId);

    expect(db.readEvidenceStamp(fadingEdgeId)).toBeNull();
    expect(Number(db.readEvidenceStamp(survivingEdgeId))).toBeCloseTo(0.5, 10);
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredence(0.5, 0),
      10
    );
  });
});

describe('recomputeNodeBelief leaves a fixed-credence node alone', () => {
  // The bootstrap rule. A node with belief_credence_is_fixed set has its
  // credence ASSERTED by a human, not derived from the graph, so a recompute
  // must not touch it: same credence, same computed-at timestamp, no movement
  // row — even though it has outgoing evidence that would otherwise regrade
  // it. Without at least one such node, a derived-only graph could never
  // grade anything at all.
  it('leaves the credence and the computed-at timestamp of a fixed node exactly as they were', async () => {
    db = await openTempBeliefDatabase();
    const fixedExpertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'human expert whose credence is asserted, not derived',
      beliefCredence: 0.9,
    });
    const beliefBeforeRecompute = db.readNodeBelief(fixedExpertNodeId);
    // Evidence that WOULD regrade an ordinary node: the expert derives from a
    // disbelieved source (negative credence) at full strength, which under
    // the counted-negatives rule is hard contradiction mass.
    const criticNodeId = db.insertNodeFixture({
      title: 'disbelieved critic the expert would derive from',
      beliefCredence: -1.0,
    });
    const criticEdgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: fixedExpertNodeId,
      sourceNodeId: criticNodeId,
      support: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(fixedExpertNodeId);

    const beliefAfterRecompute = db.readNodeBelief(fixedExpertNodeId);
    expect(Number(beliefAfterRecompute.belief_credence)).toBeCloseTo(0.9, 10);
    expect(beliefAfterRecompute.belief_computed_at).toBe(beliefBeforeRecompute.belief_computed_at);
    // Nothing was logged and nothing was stamped.
    expect(db.readBeliefMovements(fixedExpertNodeId)).toHaveLength(0);
    expect(db.readEvidenceStamp(criticEdgeId)).toBeNull();
    expect(result.movement).toBeNull();
    expect(result.contributions).toHaveLength(0);
    // The reported credence is the asserted one the node still holds.
    expect(Number(result.beliefCredence)).toBeCloseTo(0.9, 10);
    // And the node is still marked as fixed afterwards.
    expect(db.readNodeBeliefCredenceIsFixed(fixedExpertNodeId)).toBe(1);
  });

  // The flag defaults to 0, and an ordinary node is graded normally — so
  // "fixed" is opt-in, not something every node falls into by accident.
  it('grades an ordinary node normally and reports its fixed flag as 0', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      support: 0.8,
      sourceBeliefCredence: 0.9,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    expect(db.readNodeBeliefCredenceIsFixed(claimNodeId)).toBe(0);
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredence(0.72, 0),
      10
    );
  });

  // There is exactly ONE kind of node. A venue, an agent and a claim are all
  // ordinary nodes: each is graded from its own outgoing evidence by the same
  // rule, with no per-class behaviour anywhere.
  it('grades venue, agent and claim nodes by the identical rule — no node class is special', async () => {
    db = await openTempBeliefDatabase();
    const fixedExpertNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'the one fixed expert',
      beliefCredence: 0.5,
    });
    // Three nodes a reader might expect to be different "kinds"; each gets
    // the same support from the same fixed expert.
    const venueNodeId = db.insertNodeFixture({ title: 'a venue node' });
    const agentNodeId = db.insertNodeFixture({ title: 'an agent node' });
    const claimNodeId = db.insertNodeFixture({ title: 'a claim node' });
    for (const gradedNodeId of [venueNodeId, agentNodeId, claimNodeId]) {
      db.insertEvidenceEdgeFixture({
        derivedNodeId: gradedNodeId,
        sourceNodeId: fixedExpertNodeId,
        support: 0.6,
      });
    }
    const { recomputeNodeBelief } = await db.importBeliefService();

    for (const gradedNodeId of [venueNodeId, agentNodeId, claimNodeId]) {
      await recomputeNodeBelief(gradedNodeId);
    }

    // 0.6 × 0.5 = 0.3 for every one of them.
    const expectedCredenceForEveryNodeKind = expectedBeliefCredence(0.3, 0);
    for (const gradedNodeId of [venueNodeId, agentNodeId, claimNodeId]) {
      expect(Number(db.readNodeBelief(gradedNodeId).belief_credence)).toBeCloseTo(
        expectedCredenceForEveryNodeKind,
        10
      );
      expect(db.readNodeBeliefCredenceIsFixed(gradedNodeId)).toBe(0);
    }
  });
});
