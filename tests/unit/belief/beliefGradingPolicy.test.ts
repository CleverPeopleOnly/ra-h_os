/**
 * Pure-math tests for beliefGradingPolicyV1 — no database involved.
 *
 * Pins the published policy constants and the v1 grading formula:
 *   value = PRIOR + (1 - PRIOR)(1 - e^(-RATE*S)) - PRIOR(1 - e^(-RATE*C))
 * where S/C are the positive/|negative| sums AFTER same-independence-key
 * contributions collapse to the single largest-|value| one (POLICY V1,
 * provisional — repeated/derivative evidence weighting is unsettled).
 *
 * Static import here is safe: beliefGradingPolicy has no side effects and
 * never touches the SQLite client.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORIGIN_TRUST,
  PRIOR_BELIEF,
  SATURATION_RATE,
  beliefGradingPolicyV1,
  type EvidenceContribution,
} from '@/services/belief/beliefGradingPolicy';

// Expected belief for a support mass S and contradiction mass C under the
// pinned v1 saturation formula.
function expectedBelief(supportSum: number, contradictionSum: number): number {
  return (
    PRIOR_BELIEF +
    (1 - PRIOR_BELIEF) * (1 - Math.exp(-SATURATION_RATE * supportSum)) -
    PRIOR_BELIEF * (1 - Math.exp(-SATURATION_RATE * contradictionSum))
  );
}

// Shorthand for building one contribution row in the tests below.
function contribution(
  edgeId: number,
  signedContribution: number,
  independenceKey: string | null
): EvidenceContribution {
  return { edgeId, signedContribution, independenceKey };
}

describe('beliefGradingPolicyV1', () => {
  // Pins the published constant values so implementations and tests agree
  // on the same anchors. (Intentionally green from day one.)
  it('publishes the pinned policy constants', () => {
    expect(PRIOR_BELIEF).toBe(0.5);
    expect(DEFAULT_ORIGIN_TRUST).toBe(0.3);
    expect(SATURATION_RATE).toBe(1.0);
  });

  // A single independent support contribution must land exactly on the
  // saturation-formula anchor.
  it('grades a single support contribution to the exact formula anchor', () => {
    const value = beliefGradingPolicyV1.gradeBelief([contribution(1, 0.8, 'origin-a')]);
    expect(value).toBeCloseTo(expectedBelief(0.8, 0), 10);
  });

  // Mixed independent support and contradiction must combine as
  // S = sum of positives, C = sum of |negatives|.
  it('combines independent support and contradiction masses per the formula', () => {
    const value = beliefGradingPolicyV1.gradeBelief([
      contribution(1, 0.8, 'origin-a'),
      contribution(2, -0.5, 'origin-b'),
    ]);
    expect(value).toBeCloseTo(expectedBelief(0.8, 0.5), 10);
  });

  // POLICY V1 (provisional): contributions sharing an independence key
  // collapse to the single largest-|value| one instead of stacking.
  it('POLICY V1: same-independence-key contributions collapse to the largest-magnitude one', () => {
    const value = beliefGradingPolicyV1.gradeBelief([
      contribution(1, 0.4, 'shared-key'),
      contribution(2, 0.7, 'shared-key'),
      contribution(3, -0.2, 'other-key'),
    ]);
    expect(value).toBeCloseTo(expectedBelief(0.7, 0.2), 10);
  });
});
