/**
 * Behavior tests for recomputeNodeBelief against a real temp-file SQLite
 * database (see tempBeliefDatabase.ts for the safety seam).
 *
 * Semantics pinned here:
 *  - trust weight per evidence edge comes from the FROM-node's metadata
 *    trustOriginKey looked up in belief_source_trust; an edge whose source
 *    has no trustOriginKey, or whose key has no belief_source_trust row, is
 *    UNASSESSED and is excluded from grading entirely (left unstamped, its
 *    belief_evidence_contribution stays NULL) — there is no fallback weight
 *  - recompute persists nodes.belief_credence + belief_computed_at, stamps
 *    edges.belief_evidence_contribution for ASSESSED edges only, and
 *    appends a belief_movements row only when the credence actually changed
 *  - a node with no counted (assessed) evidence stays ungraded
 *    (belief_credence NULL), whether it has zero evidence edges or only
 *    unassessed ones
 *
 * The static import of beliefGradingPolicy is safe (pure constants module);
 * everything database-bound is imported through the helper context.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEUTRAL_BELIEF_CREDENCE, SATURATION_RATE } from '@/services/belief/beliefGradingPolicy';
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

// Expected credence for a support mass S and contradiction mass C under the
// pinned v1 OPEN SIGNED saturation formula: e^(-RATE*C) - e^(-RATE*S).
// Renaming this MR moves no arithmetic: the formula is byte-for-byte the one
// the pre-rename tests asserted, so every number below is unchanged.
function expectedBeliefCredence(supportSum: number, contradictionSum: number): number {
  return (
    Math.exp(-SATURATION_RATE * contradictionSum) - Math.exp(-SATURATION_RATE * supportSum)
  );
}

// Create a claim node plus one evidence source node (with optional trusted
// origin), and connect them with one evidence edge. Returns all the ids.
function seedClaimWithOneEvidenceEdge(
  context: TempBeliefDatabase,
  options: {
    direction: 'for' | 'against';
    strength: number;
    trustOriginKey?: string;
    trustScore?: number;
  }
): { claimNodeId: number; sourceNodeId: number; edgeId: number } {
  const claimNodeId = context.insertNodeFixture({ title: 'claim under test' });
  const sourceNodeId = context.insertNodeFixture({
    title: `evidence source ${options.trustOriginKey ?? 'unassessed'}`,
    trustOriginKey: options.trustOriginKey,
  });
  if (options.trustOriginKey && options.trustScore !== undefined) {
    context.seedSourceTrustRow(options.trustOriginKey, options.trustScore);
  }
  const edgeId = context.insertEvidenceEdgeFixture({
    fromNodeId: sourceNodeId,
    toNodeId: claimNodeId,
    direction: options.direction,
    strength: options.strength,
  });
  return { claimNodeId, sourceNodeId, edgeId };
}

// Add one more evidence edge (with its own source node) pointing at an
// existing claim node.
function addEvidenceEdge(
  context: TempBeliefDatabase,
  claimNodeId: number,
  options: {
    direction: 'for' | 'against';
    strength: number;
    trustOriginKey?: string;
    trustScore?: number;
  }
): number {
  const sourceNodeId = context.insertNodeFixture({
    title: `extra evidence source ${options.trustOriginKey ?? 'unassessed'}-${options.strength}`,
    trustOriginKey: options.trustOriginKey,
  });
  if (options.trustOriginKey && options.trustScore !== undefined) {
    context.seedSourceTrustRow(options.trustOriginKey, options.trustScore);
  }
  return context.insertEvidenceEdgeFixture({
    fromNodeId: sourceNodeId,
    toNodeId: claimNodeId,
    direction: options.direction,
    strength: options.strength,
  });
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
      direction: 'for',
      strength: 0.6,
      trustOriginKey: 'origin-support',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeGreaterThan(NEUTRAL_BELIEF_CREDENCE);
  });

  // 2b. Any lone contradiction must push belief below the prior.
  it('grades a node with a single contradicting edge below the prior', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'against',
      strength: 0.6,
      trustOriginKey: 'origin-contra',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeLessThan(NEUTRAL_BELIEF_CREDENCE);
  });

  // 3. Exact anchor: strength 1.0 at trust 1.0 lands precisely on
  //    PRIOR + (1-PRIOR)(1 - e^-1), pinned to 10 decimal places, and the
  //    computed-at timestamp is stamped.
  it('grades one full-strength, fully-trusted support to the exact formula anchor', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 1.0,
      trustOriginKey: 'origin-anchor',
      trustScore: 1.0,
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
      direction: 'for',
      strength: 0.6,
      trustOriginKey: 'origin-first',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const credenceAfterFirstSupport = db.readNodeBelief(claimNodeId).belief_credence;

    addEvidenceEdge(db, claimNodeId, {
      direction: 'for',
      strength: 0.6,
      trustOriginKey: 'origin-second',
      trustScore: 1.0,
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
      direction: 'for',
      strength: 0.6,
      trustOriginKey: 'origin-first',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const credenceAfterFirstSupport = Number(db.readNodeBelief(claimNodeId).belief_credence);

    addEvidenceEdge(db, claimNodeId, {
      direction: 'for',
      strength: 0.6,
      trustOriginKey: 'origin-second',
      trustScore: 1.0,
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
      addEvidenceEdge(db, claimNodeId, {
        direction: 'for',
        strength: 1.0,
        trustOriginKey: `origin-support-${supportIndex}`,
        trustScore: 1.0,
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
  it('keeps belief strictly above -1 under ten strong independent contradictions', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'heavily contradicted claim' });
    for (let contradictionIndex = 0; contradictionIndex < 10; contradictionIndex += 1) {
      addEvidenceEdge(db, claimNodeId, {
        direction: 'against',
        strength: 1.0,
        trustOriginKey: `origin-contra-${contradictionIndex}`,
        trustScore: 1.0,
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

  // 6a. Repetition reinforces: an equal-strength repeat from the SAME
  //     assessed trust origin STACKS instead of being ignored, so the repeat
  //     must raise belief — S = 0.7 + 0.7 = 1.4, landing on the summed-mass
  //     anchor, strictly above the single-edge credence. (Nothing here depends
  //     on an origin key: repetition is weighted purely by source standing.)
  it('reinforcement: an equal-strength repeat from the same assessed source raises belief (stacks)', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.7,
      trustOriginKey: 'origin-x',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const credenceBeforeRepeat = Number(db.readNodeBelief(claimNodeId).belief_credence);

    addEvidenceEdge(db, claimNodeId, {
      direction: 'for',
      strength: 0.7,
      trustOriginKey: 'origin-x',
      trustScore: 1.0,
    });
    await recomputeNodeBelief(claimNodeId);
    const credenceAfterRepeat = Number(db.readNodeBelief(claimNodeId).belief_credence);

    expect(credenceAfterRepeat).toBeGreaterThan(credenceBeforeRepeat);
    expect(credenceAfterRepeat).toBeCloseTo(expectedBeliefCredence(0.7 + 0.7, 0), 10);
  });

  // 6b. A stronger repeat from the same assessed source does not replace the
  //     weaker one — both count, so S = 0.7 + 0.9 = 1.6, not just the
  //     stronger edge's 0.9 alone.
  it('reinforcement: a stronger contribution from the same assessed source adds to the weaker (stacks)', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.7,
      trustOriginKey: 'origin-x',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);

    addEvidenceEdge(db, claimNodeId, {
      direction: 'for',
      strength: 0.9,
      trustOriginKey: 'origin-x',
      trustScore: 1.0,
    });
    await recomputeNodeBelief(claimNodeId);

    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredence(0.7 + 0.9, 0),
      10
    );
  });

  // 7a. Trust weighting vs. non-counting: a same-strength support from a
  //     0.9-trust origin grades to a real positive number, while a support
  //     from an origin with NO belief_source_trust row is UNASSESSED and is
  //     not counted at all, so that node's belief stays NULL (not merely a
  //     smaller number).
  it('grades a 0.9-trust origin to a real credence; an unknown origin is not counted (NULL)', async () => {
    db = await openTempBeliefDatabase();
    const trustedClaim = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 1.0,
      trustOriginKey: 'origin-trusted',
      trustScore: 0.9,
    });
    // Second claim: its source node carries a trustOriginKey that has no
    // belief_source_trust row, so its only evidence edge is unassessed and
    // excluded from grading entirely.
    const unknownClaim = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 1.0,
      trustOriginKey: 'origin-unknown',
      // no trustScore: deliberately unseeded
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(trustedClaim.claimNodeId);
    await recomputeNodeBelief(unknownClaim.claimNodeId);

    const trustedCredence = Number(db.readNodeBelief(trustedClaim.claimNodeId).belief_credence);
    expect(Number.isFinite(trustedCredence)).toBe(true);
    expect(trustedCredence).toBeGreaterThan(0);
    expect(db.readNodeBelief(unknownClaim.claimNodeId).belief_credence).toBeNull();
  });

  // 7b. Non-counting is exact: a support edge from a source with NO
  //     trustOriginKey in its metadata is unassessed, so it contributes zero
  //     evidence mass and the node stays ungraded (NULL), not weighted down
  //     to a fallback trust weight.
  it('an unknown-origin support is not counted — the node stays NULL', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim with anonymous evidence' });
    // Source node without any trustOriginKey in its metadata.
    const anonymousSourceNodeId = db.insertNodeFixture({ title: 'anonymous evidence source' });
    db.insertEvidenceEdgeFixture({
      fromNodeId: anonymousSourceNodeId,
      toNodeId: claimNodeId,
      direction: 'for',
      strength: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    expect(db.readNodeBelief(claimNodeId).belief_credence).toBeNull();
  });

  // 8. A contradiction arriving after support must lower the credence below the
  //    support-only level, exactly per the formula.
  it('lowers belief below the support-only level when a contradiction is added', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.8,
      trustOriginKey: 'origin-support',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const supportOnlyCredence = Number(db.readNodeBelief(claimNodeId).belief_credence);

    addEvidenceEdge(db, claimNodeId, {
      direction: 'against',
      strength: 0.5,
      trustOriginKey: 'origin-contra',
      trustScore: 1.0,
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
      direction: 'for',
      strength: 0.6,
      trustOriginKey: 'origin-a',
      trustScore: 1.0,
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
      direction: 'for',
      strength: 0.6,
      trustOriginKey: 'origin-movement-shape',
      trustScore: 1.0,
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
      direction: 'for',
      strength: 0.6,
      trustOriginKey: 'origin-a',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);

    const secondResult = await recomputeNodeBelief(claimNodeId);

    expect(secondResult.movement).toBeNull();
    expect(db.readBeliefMovements(claimNodeId)).toHaveLength(1);
  });

  // 10. Edge stamping vs. non-counting: after a recompute, an ASSESSED
  //     evidence edge carries its signed effective contribution
  //     (strength × trustWeight) in belief_evidence_contribution and is
  //     reported in result.contributions; an UNASSESSED edge (unknown
  //     origin) is excluded from grading, left unstamped (NULL), and does
  //     NOT appear in result.contributions. The node's belief_credence comes
  //     from the assessed support alone — the unassessed contradiction
  //     contributes nothing.
  it('only assessed-source edges are counted and stamped; unassessed edges stay NULL', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId: supportEdgeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.8,
      trustOriginKey: 'origin-trusted',
      trustScore: 0.9,
    });
    // Contradicting edge from an unknown origin: unassessed, excluded from
    // grading and stamping entirely.
    const contradictionEdgeId = addEvidenceEdge(db, claimNodeId, {
      direction: 'against',
      strength: 0.5,
      trustOriginKey: 'origin-unknown',
      // no trustScore: deliberately unseeded
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    const expectedSupportContribution = 0.8 * 0.9;
    // Node grades from the assessed support alone; the unassessed
    // contradiction contributes zero mass.
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredence(expectedSupportContribution, 0),
      10
    );
    expect(Number(db.readEvidenceStamp(supportEdgeId))).toBeCloseTo(
      expectedSupportContribution,
      10
    );
    // Unassessed edge is left unstamped.
    expect(db.readEvidenceStamp(contradictionEdgeId)).toBeNull();
    const reportedEdgeIds = result.contributions.map(entry => entry.edgeId);
    expect(reportedEdgeIds).toEqual([supportEdgeId]);
  });

  // 10b. Mixed assessed + unassessed support: the node must grade from the
  //      assessed edge alone (strength 0.8, trust 1.0 -> S = 0.8), and the
  //      unassessed support edge (no belief_source_trust row) must add
  //      nothing to that mass — so the graded credence is strictly less than
  //      it would be if the unassessed edge's strength were also counted.
  it('grades only from assessed-source support when an unassessed support is also present', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.8,
      trustOriginKey: 'origin-assessed',
      trustScore: 1.0,
    });
    // Second support edge from a source with no belief_source_trust row:
    // unassessed, must be excluded from the graded mass entirely.
    const unassessedStrength = 0.6;
    addEvidenceEdge(db, claimNodeId, {
      direction: 'for',
      strength: unassessedStrength,
      trustOriginKey: 'origin-unassessed',
      // no trustScore: deliberately unseeded
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const beliefCredence = Number(db.readNodeBelief(claimNodeId).belief_credence);
    expect(beliefCredence).toBeCloseTo(expectedBeliefCredence(0.8, 0), 10);
    // If the unassessed edge's strength had also been counted, the credence
    // would be strictly higher — confirms it was excluded, not just
    // down-weighted.
    expect(beliefCredence).toBeLessThan(expectedBeliefCredence(0.8 + unassessedStrength, 0));
  });

  // 12. Origin-key removal at the service boundary: recomputeNodeBelief must
  //     hand the grading policy contributions carrying ONLY edgeId and
  //     signedContribution. No beliefEvidenceOriginKey may be attached — the
  //     field is gone from BeliefEvidenceContribution and the service no
  //     longer selects the column it came from.
  it('passes the grading policy contributions with no beliefEvidenceOriginKey field', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.6,
      trustOriginKey: 'origin-policy-shape',
      trustScore: 1.0,
    });
    // Spy on the SAME policy-module instance the belief service binds to
    // (both are imported after the helper reset the module registry).
    const beliefGradingPolicyModule = await db.importBeliefGradingPolicyModule();
    const gradeBeliefSpy = vi.spyOn(beliefGradingPolicyModule.beliefGradingPolicyV1, 'gradeBelief');
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

  // 11. Raising an origin's trust and recomputing must raise the credence and
  //     append a second movement row recording the change.
  it('raises belief and appends a movement when the origin trust score increases', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 1.0,
      trustOriginKey: 'origin-growing',
      trustScore: 0.2,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const credenceAtLowTrust = Number(db.readNodeBelief(claimNodeId).belief_credence);

    // Raise the origin's trust through the real service, then regrade.
    const { upsertTrustScore } = await db.importSourceTrustService();
    await upsertTrustScore('origin-growing', 0.9);
    await recomputeNodeBelief(claimNodeId);
    const credenceAtHighTrust = Number(db.readNodeBelief(claimNodeId).belief_credence);

    expect(credenceAtHighTrust).toBeGreaterThan(credenceAtLowTrust);
    const movements = db.readBeliefMovements(claimNodeId);
    expect(movements).toHaveLength(2);
    expect(Number(movements[1].from_credence)).toBeCloseTo(credenceAtLowTrust, 10);
    expect(movements[1].to_credence).toBeCloseTo(credenceAtHighTrust, 10);
  });
});
