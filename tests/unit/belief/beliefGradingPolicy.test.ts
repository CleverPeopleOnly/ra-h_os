/**
 * Pure-math tests for beliefGradingPolicyV1 — no database involved.
 *
 * Pins the published policy constants and the v1 grading formula on the
 * OPEN SIGNED (-1, +1) scale:
 *   value = (1 - e^(-RATE*S)) - (1 - e^(-RATE*C)) = e^(-RATE*C) - e^(-RATE*S)
 * where S/C are the plain positive/|negative| sums of ALL contributions —
 * repeated contributions are NOT collapsed, they stack (the old V1
 * largest-|value| collapse rule has been removed from grading, and with it
 * the beliefEvidenceOriginKey field it keyed off: a contribution is now
 * edge id + signed value only).
 * NEUTRAL_BELIEF (0) replaces the old PRIOR_BELIEF (0.5) as the anchor for
 * "balanced/torn" evidence; the range is open and never reaches +/-1.
 *
 * Static import here is safe: beliefGradingPolicy has no side effects and
 * never touches the SQLite client.
 */

import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_BELIEF,
  SATURATION_RATE,
  beliefGradingPolicyV1,
  type BeliefEvidenceContribution,
} from '@/services/belief/beliefGradingPolicy';

// Expected belief for a support mass S and contradiction mass C under the
// pinned v1 OPEN SIGNED saturation formula: e^(-RATE*C) - e^(-RATE*S).
function expectedBelief(supportSum: number, contradictionSum: number): number {
  return (
    Math.exp(-SATURATION_RATE * contradictionSum) - Math.exp(-SATURATION_RATE * supportSum)
  );
}

// Shorthand for building one contribution row in the tests below. A
// contribution is now edge id + signed value only: beliefEvidenceOriginKey
// has been removed from BeliefEvidenceContribution, so this object literal
// must type-check with exactly these two properties.
function contribution(edgeId: number, signedContribution: number): BeliefEvidenceContribution {
  return { edgeId, signedContribution };
}

describe('beliefGradingPolicyV1', () => {
  // Pins the published constant values so implementations and tests agree
  // on the same anchors. NEUTRAL_BELIEF (0) is the open-scale replacement
  // for the removed PRIOR_BELIEF (0.5). (Intentionally green from day one.)
  it('publishes the pinned policy constants', () => {
    expect(NEUTRAL_BELIEF).toBe(0);
    expect(SATURATION_RATE).toBe(1.0);
  });

  // A single independent support contribution must land exactly on the
  // saturation-formula anchor.
  it('grades a single support contribution to the exact formula anchor', () => {
    const value = beliefGradingPolicyV1.gradeBelief([contribution(1, 0.8)]);
    expect(value).toBeCloseTo(expectedBelief(0.8, 0), 10);
  });

  // Mixed independent support and contradiction must combine as
  // S = sum of positives, C = sum of |negatives|.
  it('combines independent support and contradiction masses per the formula', () => {
    const value = beliefGradingPolicyV1.gradeBelief([
      contribution(1, 0.8),
      contribution(2, -0.5),
    ]);
    expect(value).toBeCloseTo(expectedBelief(0.8, 0.5), 10);
  });

  // Collapse is REMOVED from grading: repeated contributions no longer
  // collapse to the strongest one — they all count and their masses SUM.
  // Two supports (0.4 + 0.7) plus one contradiction (0.2) must combine to
  // S = 1.1, C = 0.2, not the old collapsed S = 0.7, C = 0.2. Unchanged by
  // the origin-key removal: the policy never read the key.
  it('repeated contributions stack (no collapse) — masses sum', () => {
    const value = beliefGradingPolicyV1.gradeBelief([
      contribution(1, 0.4),
      contribution(2, 0.7),
      contribution(3, -0.2),
    ]);
    expect(value).toBeCloseTo(expectedBelief(0.4 + 0.7, 0.2), 10);
  });

  // Full-strength (+1.0) single-key support must land exactly on 1 - e^-1
  // and land strictly on the positive side of neutral.
  it('grades a single full-strength (+1.0) support to 1 - e^-1 and stays positive', () => {
    const value = beliefGradingPolicyV1.gradeBelief([contribution(1, 1.0)]);
    expect(value).toBeCloseTo(1 - Math.exp(-1), 10);
    expect(value).toBeGreaterThan(0);
  });

  // Full-strength (-1.0) single-key contradiction must land exactly on
  // e^-1 - 1 and land strictly on the negative side of neutral — this is
  // the open-signed-scale behavior that has no analog on the old 0..1 scale.
  it('grades a single full-strength (-1.0) contradiction to e^-1 - 1 and stays negative', () => {
    const value = beliefGradingPolicyV1.gradeBelief([contribution(1, -1.0)]);
    expect(value).toBeCloseTo(Math.exp(-1) - 1, 10);
    expect(value).toBeLessThan(0);
  });

  // Symmetry: flipping every contribution's sign must exactly negate the
  // graded value — a property only meaningful on a signed, zero-anchored
  // scale (there is no equivalent on the old 0..1 scale).
  it('negating all contributions exactly negates the graded value (sign symmetry)', () => {
    const supportOnly = beliefGradingPolicyV1.gradeBelief([contribution(1, 0.6)]);
    const contradictionOnly = beliefGradingPolicyV1.gradeBelief([
      contribution(1, -0.6),
    ]);
    expect(contradictionOnly).toBeCloseTo(-supportOnly, 10);
  });

  // Balanced evidence (equal support and contradiction mass on independent
  // keys) must land exactly on NEUTRAL_BELIEF (0), not the old 0.5 prior.
  it('grades balanced equal-mass support and contradiction to exactly NEUTRAL_BELIEF', () => {
    const value = beliefGradingPolicyV1.gradeBelief([
      contribution(1, 0.9),
      contribution(2, -0.9),
    ]);
    expect(value).toBeCloseTo(NEUTRAL_BELIEF, 10);
  });

  // An empty contribution list (no evidence collapsed in) must grade to
  // exactly 0 — the pure-math floor for "no signal" distinct from the
  // service-level "ungraded/NULL" state tested elsewhere.
  it('grades an empty contribution list to exactly 0', () => {
    const value = beliefGradingPolicyV1.gradeBelief([]);
    expect(value).toBeCloseTo(0, 12);
  });

  // Strictly bounded above: even a very large support mass must stay
  // strictly below +1 (the scale is open, never reaching the endpoint) while
  // getting arbitrarily close to it.
  it('keeps a very large support mass strictly below +1', () => {
    const value = beliefGradingPolicyV1.gradeBelief([contribution(1, 20)]);
    expect(value).toBeLessThan(1);
    expect(value).toBeGreaterThan(0.999);
  });

  // Strictly bounded below: even a very large contradiction mass must stay
  // strictly above -1 (open scale) while getting arbitrarily close to it.
  it('keeps a very large contradiction mass strictly above -1', () => {
    const value = beliefGradingPolicyV1.gradeBelief([contribution(1, -20)]);
    expect(value).toBeGreaterThan(-1);
    expect(value).toBeLessThan(-0.999);
  });

  // Sign correctness: when contradiction mass outweighs support mass, the
  // graded value must be negative (net-against), exercising the signed
  // scale's directionality rather than just its magnitude.
  it('grades net-against evidence (contradiction outweighs support) to a negative value', () => {
    const value = beliefGradingPolicyV1.gradeBelief([
      contribution(1, 0.2),
      contribution(2, -0.9),
    ]);
    expect(value).toBeLessThan(0);
  });
});
