/**
 * Pure-math tests for the published grading-policy surface — no database
 * involved. REWRITTEN for belief model v2 (docs/belief-model-subjective-logic.md
 * §2/§3, replacing the v1 exponential whose premise these tests used to pin):
 * the policy is now the Subjective Logic mass model
 *
 *   credence = (r − s) / (r + s + W),   W = BELIEF_PRIOR_MASS = 2
 *
 * where r/s are the plain positive/|negative| sums of ALL contributions —
 * repeated contributions are NOT collapsed, they stack (unchanged from v1).
 * NEUTRAL_BELIEF_CREDENCE (0) remains the anchor for "balanced/torn"
 * evidence; the range is open and never reaches ±1. Each rewritten
 * expectation cites its spec anchor; the §3 worked-examples rows themselves
 * are pinned in beliefGradingPolicyV2SubjectiveLogic.test.ts — this file
 * keeps one test per POLICY PROPERTY the v1 suite pinned.
 *
 * Static import here is safe: beliefGradingPolicy has no side effects and
 * never touches the SQLite client.
 */

import { describe, expect, it } from 'vitest';
import {
  BELIEF_PRIOR_MASS,
  NEUTRAL_BELIEF_CREDENCE,
  beliefGradingPolicyV2,
  type BeliefEvidenceContribution,
} from '@/services/belief/beliefGradingPolicy';

// Expected credence for a for mass r and against mass s under the pinned v2
// projection formula (spec §2): (r − s)/(r + s + W).
function expectedBelief(forMassSum: number, againstMassSum: number): number {
  return (forMassSum - againstMassSum) / (forMassSum + againstMassSum + BELIEF_PRIOR_MASS);
}

// Shorthand for building one contribution row in the tests below. A
// contribution is edge id + signed value only: beliefEvidenceOriginKey
// has been removed from BeliefEvidenceContribution, so this object literal
// must type-check with exactly these two properties.
function contribution(edgeId: number, signedContribution: number): BeliefEvidenceContribution {
  return { edgeId, signedContribution };
}

describe('beliefGradingPolicyV2', () => {
  // Pins the published constant values so implementations and tests agree on
  // the same anchors. BELIEF_PRIOR_MASS (2, spec §2's W) REPLACES the retired
  // SATURATION_RATE per spec §7; NEUTRAL_BELIEF_CREDENCE (0) is unchanged.
  it('publishes the pinned policy constants', () => {
    expect(NEUTRAL_BELIEF_CREDENCE).toBe(0);
    expect(BELIEF_PRIOR_MASS).toBe(2);
  });

  // A single independent support contribution must land exactly on the
  // projection-formula anchor (spec §2: r = 0.8, s = 0 → 0.8/2.8).
  it('grades a single support contribution to the exact formula anchor', () => {
    const value = beliefGradingPolicyV2.gradeBelief([contribution(1, 0.8)]);
    expect(value).toBeCloseTo(expectedBelief(0.8, 0), 10);
  });

  // Mixed independent support and contradiction must combine as
  // r = sum of positives, s = sum of |negatives| (spec §2's split by sign).
  it('combines independent support and contradiction masses per the formula', () => {
    const value = beliefGradingPolicyV2.gradeBelief([
      contribution(1, 0.8),
      contribution(2, -0.5),
    ]);
    expect(value).toBeCloseTo(expectedBelief(0.8, 0.5), 10);
  });

  // Collapse is REMOVED from grading: repeated contributions no longer
  // collapse to the strongest one — they all count and their masses SUM
  // (spec §2 cumulative fusion). Two supports (0.4 + 0.7) plus one
  // contradiction (0.2) must combine to r = 1.1, s = 0.2.
  it('repeated contributions stack (no collapse) — masses sum', () => {
    const value = beliefGradingPolicyV2.gradeBelief([
      contribution(1, 0.4),
      contribution(2, 0.7),
      contribution(3, -0.2),
    ]);
    expect(value).toBeCloseTo(expectedBelief(0.4 + 0.7, 0.2), 10);
  });

  // Full-strength (+1.0) single support must land exactly on the projection
  // anchor 1/3 (spec §2: 1/(1+2)) and land strictly on the positive side of
  // neutral. Under v2 a single edge cannot buy high credence — that is W
  // doing openly what SATURATION_RATE did by accident (spec §3 row 2 note).
  it('grades a single full-strength (+1.0) support to 1/(1 + W) and stays positive', () => {
    const value = beliefGradingPolicyV2.gradeBelief([contribution(1, 1.0)]);
    expect(value).toBeCloseTo(1 / (1 + BELIEF_PRIOR_MASS), 10);
    expect(value).toBeGreaterThan(0);
  });

  // Full-strength (-1.0) single contradiction must land exactly on −1/3 and
  // land strictly on the negative side of neutral — the signed-scale mirror.
  it('grades a single full-strength (-1.0) contradiction to −1/(1 + W) and stays negative', () => {
    const value = beliefGradingPolicyV2.gradeBelief([contribution(1, -1.0)]);
    expect(value).toBeCloseTo(-1 / (1 + BELIEF_PRIOR_MASS), 10);
    expect(value).toBeLessThan(0);
  });

  // Symmetry: flipping every contribution's sign must exactly negate the
  // graded value — swapping r and s negates the projection (spec §2).
  it('negating all contributions exactly negates the graded value (sign symmetry)', () => {
    const supportOnly = beliefGradingPolicyV2.gradeBelief([contribution(1, 0.6)]);
    const contradictionOnly = beliefGradingPolicyV2.gradeBelief([
      contribution(1, -0.6),
    ]);
    expect(contradictionOnly).toBeCloseTo(-supportOnly, 10);
  });

  // Balanced evidence (equal support and contradiction mass) must land
  // exactly on NEUTRAL_BELIEF_CREDENCE: r = s makes the numerator 0.
  it('grades balanced equal-mass support and contradiction to exactly NEUTRAL_BELIEF_CREDENCE', () => {
    const value = beliefGradingPolicyV2.gradeBelief([
      contribution(1, 0.9),
      contribution(2, -0.9),
    ]);
    expect(value).toBeCloseTo(NEUTRAL_BELIEF_CREDENCE, 10);
  });

  // An empty contribution list must grade to exactly 0 — the vacuous opinion
  // (r = s = 0, spec §2), the pure-math floor for "no signal" distinct from
  // the service-level "ungraded/NULL" state tested elsewhere.
  it('grades an empty contribution list to exactly 0', () => {
    const value = beliefGradingPolicyV2.gradeBelief([]);
    expect(value).toBeCloseTo(0, 12);
  });

  // Strictly bounded above: even a very large support mass must stay
  // strictly below +1 (the scale is open — W is always in the denominator)
  // while getting arbitrarily close to it.
  it('keeps a very large support mass strictly below +1', () => {
    const value = beliefGradingPolicyV2.gradeBelief([contribution(1, 20000)]);
    expect(value).toBeLessThan(1);
    expect(value).toBeGreaterThan(0.999);
  });

  // Strictly bounded below: even a very large contradiction mass must stay
  // strictly above -1 (open scale) while getting arbitrarily close to it.
  it('keeps a very large contradiction mass strictly above -1', () => {
    const value = beliefGradingPolicyV2.gradeBelief([contribution(1, -20000)]);
    expect(value).toBeGreaterThan(-1);
    expect(value).toBeLessThan(-0.999);
  });

  // Sign correctness: when contradiction mass outweighs support mass, the
  // graded value must be negative (net-against), exercising the signed
  // scale's directionality rather than just its magnitude.
  it('grades net-against evidence (contradiction outweighs support) to a negative value', () => {
    const value = beliefGradingPolicyV2.gradeBelief([
      contribution(1, 0.2),
      contribution(2, -0.9),
    ]);
    expect(value).toBeLessThan(0);
  });
});
