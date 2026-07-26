/**
 * Behavior tests for recomputeNodeBelief against a real temp-file SQLite
 * database (see tempBeliefDatabase.ts for the safety seam).
 *
 * Semantics pinned here:
 *  - trust weight per evidence edge comes from the FROM-node's metadata
 *    trustOriginKey looked up in source_trust; missing key or row falls back
 *    to DEFAULT_ORIGIN_TRUST
 *  - recompute persists nodes.belief_value + belief_computed_at, stamps
 *    edges.evidence_effective_contribution, and appends a belief_movements
 *    row only when the value actually changed
 *  - a node with no evidence edges stays ungraded (belief_value NULL)
 *
 * The static import of beliefGradingPolicy is safe (pure constants module);
 * everything database-bound is imported through the helper context.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ORIGIN_TRUST,
  PRIOR_BELIEF,
  SATURATION_RATE,
} from '@/services/belief/beliefGradingPolicy';
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

// Expected belief for a support mass S and contradiction mass C under the
// pinned v1 saturation formula.
function expectedBelief(supportSum: number, contradictionSum: number): number {
  return (
    PRIOR_BELIEF +
    (1 - PRIOR_BELIEF) * (1 - Math.exp(-SATURATION_RATE * supportSum)) -
    PRIOR_BELIEF * (1 - Math.exp(-SATURATION_RATE * contradictionSum))
  );
}

// Create a claim node plus one evidence source node (with optional trusted
// origin), and connect them with one evidence edge. Returns all the ids.
function seedClaimWithOneEvidenceEdge(
  context: TempBeliefDatabase,
  options: {
    direction: 'for' | 'against';
    strength: number;
    evidenceOriginKey: string;
    trustOriginKey?: string;
    trustScore?: number;
  }
): { claimNodeId: number; sourceNodeId: number; edgeId: number } {
  const claimNodeId = context.insertNodeFixture({ title: 'claim under test' });
  const sourceNodeId = context.insertNodeFixture({
    title: `evidence source ${options.evidenceOriginKey}`,
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
    evidenceOriginKey: options.evidenceOriginKey,
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
    evidenceOriginKey: string;
    trustOriginKey?: string;
    trustScore?: number;
  }
): number {
  const sourceNodeId = context.insertNodeFixture({
    title: `extra evidence source ${options.evidenceOriginKey}-${options.strength}`,
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
    evidenceOriginKey: options.evidenceOriginKey,
  });
}

describe('recomputeNodeBelief grading behavior', () => {
  // 1. Ungraded is a real state: no evidence means belief stays NULL (not
  //    0.5) and no movement is recorded.
  it('leaves an evidence-free node ungraded (belief_value NULL) and records no movement', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'lonely claim' });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    expect(result.beliefValue).toBeNull();
    expect(result.movement).toBeNull();
    expect(db.readNodeBelief(claimNodeId).belief_value).toBeNull();
    expect(db.readBeliefMovements(claimNodeId)).toHaveLength(0);
  });

  // 2a. Any lone support must push belief above the prior.
  it('grades a node with a single supporting edge above the prior', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.6,
      evidenceOriginKey: 'origin-support',
      trustOriginKey: 'origin-support',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    expect(db.readNodeBelief(claimNodeId).belief_value).toBeGreaterThan(PRIOR_BELIEF);
  });

  // 2b. Any lone contradiction must push belief below the prior.
  it('grades a node with a single contradicting edge below the prior', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'against',
      strength: 0.6,
      evidenceOriginKey: 'origin-contra',
      trustOriginKey: 'origin-contra',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    expect(db.readNodeBelief(claimNodeId).belief_value).toBeLessThan(PRIOR_BELIEF);
  });

  // 3. Exact anchor: strength 1.0 at trust 1.0 lands precisely on
  //    PRIOR + (1-PRIOR)(1 - e^-1), pinned to 10 decimal places, and the
  //    computed-at timestamp is stamped.
  it('grades one full-strength, fully-trusted support to the exact formula anchor', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 1.0,
      evidenceOriginKey: 'origin-anchor',
      trustOriginKey: 'origin-anchor',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    const anchor = expectedBelief(1.0, 0);
    expect(result.beliefValue).toBeCloseTo(anchor, 10);
    const persisted = db.readNodeBelief(claimNodeId);
    expect(persisted.belief_value).toBeCloseTo(anchor, 10);
    expect(persisted.belief_computed_at).toBeTruthy();
  });

  // 4a. Monotonic: a second INDEPENDENT support must raise the value.
  it('raises belief when a second independent support is added', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.6,
      evidenceOriginKey: 'origin-first',
      trustOriginKey: 'origin-first',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const valueAfterFirstSupport = db.readNodeBelief(claimNodeId).belief_value;

    addEvidenceEdge(db, claimNodeId, {
      direction: 'for',
      strength: 0.6,
      evidenceOriginKey: 'origin-second',
      trustOriginKey: 'origin-second',
      trustScore: 1.0,
    });
    await recomputeNodeBelief(claimNodeId);
    const valueAfterSecondSupport = db.readNodeBelief(claimNodeId).belief_value;

    expect(valueAfterSecondSupport).toBeGreaterThan(Number(valueAfterFirstSupport));
  });

  // 4b. Saturating: the second support's increment must be smaller than the
  //     first support's increment.
  it('gives the second independent support a smaller increment than the first (saturation)', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.6,
      evidenceOriginKey: 'origin-first',
      trustOriginKey: 'origin-first',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const valueAfterFirstSupport = Number(db.readNodeBelief(claimNodeId).belief_value);

    addEvidenceEdge(db, claimNodeId, {
      direction: 'for',
      strength: 0.6,
      evidenceOriginKey: 'origin-second',
      trustOriginKey: 'origin-second',
      trustScore: 1.0,
    });
    await recomputeNodeBelief(claimNodeId);
    const valueAfterSecondSupport = Number(db.readNodeBelief(claimNodeId).belief_value);

    const firstIncrement = valueAfterFirstSupport - PRIOR_BELIEF;
    const secondIncrement = valueAfterSecondSupport - valueAfterFirstSupport;
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
        evidenceOriginKey: `origin-support-${supportIndex}`,
        trustOriginKey: `origin-support-${supportIndex}`,
        trustScore: 1.0,
      });
    }
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const beliefValue = Number(db.readNodeBelief(claimNodeId).belief_value);
    expect(beliefValue).toBeGreaterThan(PRIOR_BELIEF);
    expect(beliefValue).toBeLessThan(1);
  });

  // 5b. Lower bound: even ten strong independent contradictions never reach 0.
  it('keeps belief strictly above 0 under ten strong independent contradictions', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'heavily contradicted claim' });
    for (let contradictionIndex = 0; contradictionIndex < 10; contradictionIndex += 1) {
      addEvidenceEdge(db, claimNodeId, {
        direction: 'against',
        strength: 1.0,
        evidenceOriginKey: `origin-contra-${contradictionIndex}`,
        trustOriginKey: `origin-contra-${contradictionIndex}`,
        trustScore: 1.0,
      });
    }
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const beliefValue = Number(db.readNodeBelief(claimNodeId).belief_value);
    expect(beliefValue).toBeLessThan(PRIOR_BELIEF);
    expect(beliefValue).toBeGreaterThan(0);
  });

  // 6a. POLICY V1 (provisional): repeating the same evidence (same
  //     independence key, equal strength) must not move the value.
  it('POLICY V1: an equal-strength repeat sharing the independence key leaves belief unchanged', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.7,
      evidenceOriginKey: 'shared-key',
      trustOriginKey: 'origin-x',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const valueBeforeRepeat = Number(db.readNodeBelief(claimNodeId).belief_value);

    addEvidenceEdge(db, claimNodeId, {
      direction: 'for',
      strength: 0.7,
      evidenceOriginKey: 'shared-key',
      trustOriginKey: 'origin-x',
      trustScore: 1.0,
    });
    await recomputeNodeBelief(claimNodeId);
    const valueAfterRepeat = Number(db.readNodeBelief(claimNodeId).belief_value);

    expect(valueAfterRepeat).toBeCloseTo(valueBeforeRepeat, 12);
  });

  // 6b. POLICY V1 (provisional): a stronger same-key contribution REPLACES
  //     the weaker one entirely — the value equals the single-stronger-edge
  //     anchor, not a stack of both.
  it('POLICY V1: a stronger same-key contribution replaces the weaker one entirely', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.7,
      evidenceOriginKey: 'shared-key',
      trustOriginKey: 'origin-x',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);

    addEvidenceEdge(db, claimNodeId, {
      direction: 'for',
      strength: 0.9,
      evidenceOriginKey: 'shared-key',
      trustOriginKey: 'origin-x',
      trustScore: 1.0,
    });
    await recomputeNodeBelief(claimNodeId);

    expect(Number(db.readNodeBelief(claimNodeId).belief_value)).toBeCloseTo(
      expectedBelief(0.9, 0),
      10
    );
  });

  // 7a. Trust weighting: the same-strength support from a 0.9-trust origin
  //     must move belief further than one from an origin with no
  //     source_trust row.
  it('moves belief further for a 0.9-trust origin than for an origin with no trust row', async () => {
    db = await openTempBeliefDatabase();
    const trustedClaim = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 1.0,
      evidenceOriginKey: 'origin-trusted',
      trustOriginKey: 'origin-trusted',
      trustScore: 0.9,
    });
    // Second claim: its source node carries a trustOriginKey that has no
    // source_trust row, so it must fall back to DEFAULT_ORIGIN_TRUST.
    const unknownClaim = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 1.0,
      evidenceOriginKey: 'origin-unknown',
      trustOriginKey: 'origin-unknown',
      // no trustScore: deliberately unseeded
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(trustedClaim.claimNodeId);
    await recomputeNodeBelief(unknownClaim.claimNodeId);

    const trustedValue = Number(db.readNodeBelief(trustedClaim.claimNodeId).belief_value);
    const unknownValue = Number(db.readNodeBelief(unknownClaim.claimNodeId).belief_value);
    expect(trustedValue).toBeGreaterThan(unknownValue);
  });

  // 7b. Trust fallback is exact: a source node with NO trustOriginKey in its
  //     metadata weighs in at exactly DEFAULT_ORIGIN_TRUST.
  it('pins an unknown-origin support to exactly the DEFAULT_ORIGIN_TRUST weight', async () => {
    db = await openTempBeliefDatabase();
    const claimNodeId = db.insertNodeFixture({ title: 'claim with anonymous evidence' });
    // Source node without any trustOriginKey in its metadata.
    const anonymousSourceNodeId = db.insertNodeFixture({ title: 'anonymous evidence source' });
    db.insertEvidenceEdgeFixture({
      fromNodeId: anonymousSourceNodeId,
      toNodeId: claimNodeId,
      direction: 'for',
      strength: 1.0,
      evidenceOriginKey: 'origin-anonymous',
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    expect(Number(db.readNodeBelief(claimNodeId).belief_value)).toBeCloseTo(
      expectedBelief(DEFAULT_ORIGIN_TRUST, 0),
      10
    );
  });

  // 8. A contradiction arriving after support must lower the value below the
  //    support-only level, exactly per the formula.
  it('lowers belief below the support-only level when a contradiction is added', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.8,
      evidenceOriginKey: 'origin-support',
      trustOriginKey: 'origin-support',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const supportOnlyValue = Number(db.readNodeBelief(claimNodeId).belief_value);

    addEvidenceEdge(db, claimNodeId, {
      direction: 'against',
      strength: 0.5,
      evidenceOriginKey: 'origin-contra',
      trustOriginKey: 'origin-contra',
      trustScore: 1.0,
    });
    await recomputeNodeBelief(claimNodeId);
    const mixedEvidenceValue = Number(db.readNodeBelief(claimNodeId).belief_value);

    expect(mixedEvidenceValue).toBeLessThan(supportOnlyValue);
    expect(mixedEvidenceValue).toBeCloseTo(expectedBelief(0.8, 0.5), 10);
  });

  // 9a. Movements: the FIRST grading of a node appends one movement row with
  //     from_value NULL (there was no previous value).
  it('appends one movement row with NULL from_value on first grading', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.6,
      evidenceOriginKey: 'origin-a',
      trustOriginKey: 'origin-a',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const movements = db.readBeliefMovements(claimNodeId);
    expect(movements).toHaveLength(1);
    expect(movements[0].from_value).toBeNull();
    expect(movements[0].to_value).toBeCloseTo(
      Number(db.readNodeBelief(claimNodeId).belief_value),
      10
    );
    expect(movements[0].trigger).toBeTruthy();
    expect(movements[0].occurred_at).toBeTruthy();
  });

  // 9b. Movements: recomputing with nothing changed (within 1e-12) must not
  //     append another row.
  it('appends no movement row when a recompute produces an unchanged value', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.6,
      evidenceOriginKey: 'origin-a',
      trustOriginKey: 'origin-a',
      trustScore: 1.0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);

    const secondResult = await recomputeNodeBelief(claimNodeId);

    expect(secondResult.movement).toBeNull();
    expect(db.readBeliefMovements(claimNodeId)).toHaveLength(1);
  });

  // 10. Edge stamping: after a recompute, every evidence edge carries its
  //     signed effective contribution (strength × trustWeight) in
  //     evidence_effective_contribution, and the result reports the same.
  it('stamps each evidence edge with its signed strength × trustWeight contribution', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId: supportEdgeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 0.8,
      evidenceOriginKey: 'origin-trusted',
      trustOriginKey: 'origin-trusted',
      trustScore: 0.9,
    });
    // Contradicting edge from an unknown origin: weight DEFAULT_ORIGIN_TRUST.
    const contradictionEdgeId = addEvidenceEdge(db, claimNodeId, {
      direction: 'against',
      strength: 0.5,
      evidenceOriginKey: 'origin-unknown',
      trustOriginKey: 'origin-unknown',
      // no trustScore: deliberately unseeded
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    const result = await recomputeNodeBelief(claimNodeId);

    const expectedSupportContribution = 0.8 * 0.9;
    const expectedContradictionContribution = -0.5 * DEFAULT_ORIGIN_TRUST;
    expect(Number(db.readEvidenceStamp(supportEdgeId))).toBeCloseTo(
      expectedSupportContribution,
      10
    );
    expect(Number(db.readEvidenceStamp(contradictionEdgeId))).toBeCloseTo(
      expectedContradictionContribution,
      10
    );
    const reportedByEdgeId = new Map(
      result.contributions.map(entry => [entry.edgeId, entry.effectiveContribution])
    );
    expect(Number(reportedByEdgeId.get(supportEdgeId))).toBeCloseTo(
      expectedSupportContribution,
      10
    );
    expect(Number(reportedByEdgeId.get(contradictionEdgeId))).toBeCloseTo(
      expectedContradictionContribution,
      10
    );
  });

  // 11. Raising an origin's trust and recomputing must raise the value and
  //     append a second movement row recording the change.
  it('raises belief and appends a movement when the origin trust score increases', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimWithOneEvidenceEdge(db, {
      direction: 'for',
      strength: 1.0,
      evidenceOriginKey: 'origin-growing',
      trustOriginKey: 'origin-growing',
      trustScore: 0.2,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    const valueAtLowTrust = Number(db.readNodeBelief(claimNodeId).belief_value);

    // Raise the origin's trust through the real service, then regrade.
    const { upsertTrustScore } = await db.importSourceTrustService();
    await upsertTrustScore('origin-growing', 0.9);
    await recomputeNodeBelief(claimNodeId);
    const valueAtHighTrust = Number(db.readNodeBelief(claimNodeId).belief_value);

    expect(valueAtHighTrust).toBeGreaterThan(valueAtLowTrust);
    const movements = db.readBeliefMovements(claimNodeId);
    expect(movements).toHaveLength(2);
    expect(Number(movements[1].from_value)).toBeCloseTo(valueAtLowTrust, 10);
    expect(movements[1].to_value).toBeCloseTo(valueAtHighTrust, 10);
  });
});
