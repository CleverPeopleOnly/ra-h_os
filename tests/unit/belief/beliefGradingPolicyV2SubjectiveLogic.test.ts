/**
 * Pure-math tests for the belief-model-v2 grading policy — no database
 * involved. Spec: docs/belief-model-subjective-logic.md §2 (model) and §3
 * (worked examples; those rows ARE the expected values here).
 *
 * V2 replaces the home-made saturation `e^(−C) − e^(−S)` with Subjective
 * Logic evidence masses: contributions (source credence × support, signed)
 * are split BY SIGN into an unsigned for-mass r and against-mass s, and the
 * credence is the signed projection
 *
 *   credence    = (r − s) / (r + s + W)     open (−1, +1)
 *   uncertainty = W / (r + s + W)           (0, 1]
 *
 * with W exposed as BELIEF_PRIOR_MASS = 2 — the principled tuning knob that
 * REPLACES SATURATION_RATE (spec §7).
 *
 * Import style: the module is imported as a namespace and cast, exactly like
 * tests/unit/belief/beliefMcpToolContractNodeReadFields.test.ts did for its
 * red — the v2 exports do not exist yet, so a static named import would fail
 * at module link time; the cast keeps every failure a readable assertion or
 * TypeError instead.
 *
 * §3 row 7 ("never assessed → NULL") is a SERVICE decision (zero counted
 * contributions leave the node ungraded) and is pinned in
 * beliefServiceEvidenceMassPersistenceV2.test.ts; the pure policy grades the
 * empty list to the vacuous opinion (r = s = 0 → credence 0), pinned below.
 *
 * Static import of the module is safe: beliefGradingPolicy has no side
 * effects and never touches the SQLite client.
 */

import { describe, expect, it } from 'vitest';
import * as beliefGradingPolicyModule from '@/services/belief/beliefGradingPolicy';
import type { BeliefEvidenceContribution } from '@/services/belief/beliefGradingPolicy';

// The prior mass W of spec §2, restated by hand: these expectations are the
// INDEPENDENT hand calculation the spec's §3 table says must reproduce every
// number, so they must not import the constant they are checking. (Inlined
// from the deleted helpers/beliefEvidenceMassExpectations.ts in the
// display-belief-door-writable slice — the helper's database reader died
// with the mass columns, and this file was its last importer.)
const HAND_CALCULATED_BELIEF_PRIOR_MASS = 2;

// Expected cached credence for evidence masses r (for) and s (against) under
// the v2 projection formula of spec §2.
function expectedBeliefCredenceProjection(forMass: number, againstMass: number): number {
  return (forMass - againstMass) / (forMass + againstMass + HAND_CALCULATED_BELIEF_PRIOR_MASS);
}

// Expected derived uncertainty for evidence masses r and s under spec §2.
function expectedBeliefUncertainty(forMass: number, againstMass: number): number {
  return (
    HAND_CALCULATED_BELIEF_PRIOR_MASS /
    (forMass + againstMass + HAND_CALCULATED_BELIEF_PRIOR_MASS)
  );
}

// The two unsigned evidence masses one accumulation pass produces: r (for)
// and s (against), named with the belief namespace like every belief export.
type BeliefEvidenceMasses = {
  beliefEvidenceForMass: number;
  beliefEvidenceAgainstMass: number;
};

// The v2 surface under test, typed locally because the module does not export
// it yet — that missing surface is the red this file drives.
const {
  BELIEF_PRIOR_MASS,
  accumulateBeliefEvidenceMasses,
  projectBeliefCredenceFromEvidenceMasses,
  deriveBeliefUncertaintyFromEvidenceMasses,
  beliefGradingPolicyV2,
} = beliefGradingPolicyModule as unknown as {
  // W of spec §2: the non-informative prior mass, replacing SATURATION_RATE.
  BELIEF_PRIOR_MASS: number;
  // Split a contribution list by sign into the two unsigned masses (spec §2).
  accumulateBeliefEvidenceMasses: (
    contributions: BeliefEvidenceContribution[]
  ) => BeliefEvidenceMasses;
  // The signed projection (r − s)/(r + s + W) of spec §2.
  projectBeliefCredenceFromEvidenceMasses: (forMass: number, againstMass: number) => number;
  // The derived uncertainty W/(r + s + W) of spec §2 — never stored.
  deriveBeliefUncertaintyFromEvidenceMasses: (forMass: number, againstMass: number) => number;
  // The v2 policy: accumulate then project, same gradeBelief contract as v1.
  beliefGradingPolicyV2: {
    gradeBelief: (contributions: BeliefEvidenceContribution[]) => number;
  };
};

// Shorthand for building one contribution row: edge id + signed value only,
// same shape the v1 policy tests pinned.
function contribution(edgeId: number, signedContribution: number): BeliefEvidenceContribution {
  return { edgeId, signedContribution };
}

// Grade one contribution list through every v2 door at once and check the
// projection and the uncertainty against the hand formulas — the shared body
// of the §3 row tests below.
function expectGradedRow(
  contributions: BeliefEvidenceContribution[],
  expectedForMass: number,
  expectedAgainstMass: number
): void {
  const masses = accumulateBeliefEvidenceMasses(contributions);
  expect(masses.beliefEvidenceForMass).toBeCloseTo(expectedForMass, 10);
  expect(masses.beliefEvidenceAgainstMass).toBeCloseTo(expectedAgainstMass, 10);
  expect(
    projectBeliefCredenceFromEvidenceMasses(
      masses.beliefEvidenceForMass,
      masses.beliefEvidenceAgainstMass
    )
  ).toBeCloseTo(expectedBeliefCredenceProjection(expectedForMass, expectedAgainstMass), 10);
  expect(
    deriveBeliefUncertaintyFromEvidenceMasses(
      masses.beliefEvidenceForMass,
      masses.beliefEvidenceAgainstMass
    )
  ).toBeCloseTo(expectedBeliefUncertainty(expectedForMass, expectedAgainstMass), 10);
  expect(beliefGradingPolicyV2.gradeBelief(contributions)).toBeCloseTo(
    expectedBeliefCredenceProjection(expectedForMass, expectedAgainstMass),
    10
  );
}

describe('beliefGradingPolicyV2 constants', () => {
  // Spec §2: W = 2 is the non-informative Beta prior (two virtual
  // observations, one each way) — a named constant with a documented meaning.
  it('publishes BELIEF_PRIOR_MASS = 2', () => {
    expect(BELIEF_PRIOR_MASS).toBe(2);
  });

  // Spec §7: BELIEF_PRIOR_MASS REPLACES SATURATION_RATE — the accidental
  // tuning knob must be gone from the module surface, not left beside its
  // replacement for someone to reach for.
  it('no longer exports SATURATION_RATE', () => {
    expect(
      (beliefGradingPolicyModule as Record<string, unknown>).SATURATION_RATE
    ).toBeUndefined();
  });
});

describe('accumulateBeliefEvidenceMasses splits contributions by sign', () => {
  // Spec §2: contribution ≥ 0 adds to the for-mass, contribution < 0 adds its
  // magnitude to the against-mass — masses are unsigned, the sign lives only
  // on the contribution (i.e. on the source's credence).
  it('routes positive contributions to the for mass and |negative| to the against mass', () => {
    const masses = accumulateBeliefEvidenceMasses([
      contribution(1, 0.45),
      contribution(2, -0.36),
      contribution(3, 0.2),
    ]);
    expect(masses.beliefEvidenceForMass).toBeCloseTo(0.45 + 0.2, 10);
    expect(masses.beliefEvidenceAgainstMass).toBeCloseTo(0.36, 10);
  });

  // A counted contribution of exactly 0 (support 0, or a source at credence
  // 0) adds nothing to either mass but IS an assessment: masses (0, 0), the
  // vacuous opinion of spec §2 — assessed and carrying nothing, u = 1.
  it('grades counted zero contributions to the vacuous opinion (0, 0)', () => {
    const masses = accumulateBeliefEvidenceMasses([contribution(1, 0), contribution(2, 0)]);
    expect(masses.beliefEvidenceForMass).toBe(0);
    expect(masses.beliefEvidenceAgainstMass).toBe(0);
    expect(projectBeliefCredenceFromEvidenceMasses(0, 0)).toBe(0);
    expect(deriveBeliefUncertaintyFromEvidenceMasses(0, 0)).toBe(1);
  });
});

describe('beliefGradingPolicyV2 grades the §3 worked-examples table', () => {
  // §3 row 1 — lone weak vote (source 0.9, support 0.5): one contribution of
  // +0.45 → credence 0.45/2.45 ≈ 0.1837, uncertainty 2/2.45 ≈ 0.8163.
  it('§3 row 1: lone weak vote (+0.45) grades to 0.45/2.45 with uncertainty 2/2.45', () => {
    expectGradedRow([contribution(1, 0.45)], 0.45, 0);
    expect(beliefGradingPolicyV2.gradeBelief([contribution(1, 0.45)])).toBeCloseTo(
      0.45 / 2.45,
      10
    );
  });

  // §3 row 2 — lone maximal edge (source 0.9, support 1.0): +0.9 →
  // credence 0.9/2.9 ≈ 0.310, uncertainty 2/2.9 ≈ 0.690. A single edge cannot
  // buy high credence, however strong — that is W doing openly what
  // SATURATION_RATE did by accident.
  it('§3 row 2: lone maximal edge (+0.9) grades to 0.9/2.9 with uncertainty 2/2.9', () => {
    expectGradedRow([contribution(1, 0.9)], 0.9, 0);
    expect(beliefGradingPolicyV2.gradeBelief([contribution(1, 0.9)])).toBeCloseTo(0.9 / 2.9, 10);
  });

  // §3 row 3 — heavy conflict (five at +0.6, five at −0.6): r = s = 3 →
  // credence 0 and a CONFIDENT uncertainty of 2/8 = 0.25. This row and row 4
  // are the point of the whole change: both are credence 0, but the model now
  // stores the difference between heavily contested and barely assessed.
  it('§3 row 3: heavy conflict (five +0.6, five −0.6) grades to credence 0, uncertainty 0.25', () => {
    // Ten edges, alternating sign, all at magnitude 0.6.
    const heavyConflictContributions = Array.from({ length: 10 }, (_, index) =>
      contribution(index + 1, index % 2 === 0 ? 0.6 : -0.6)
    );
    expectGradedRow(heavyConflictContributions, 3, 3);
    expect(beliefGradingPolicyV2.gradeBelief(heavyConflictContributions)).toBeCloseTo(0, 10);
    expect(deriveBeliefUncertaintyFromEvidenceMasses(3, 3)).toBeCloseTo(0.25, 10);
  });

  // §3 row 4 — tiny conflict (one +0.05, one −0.05): r = s = 0.05 → credence
  // 0 but a SHRUG uncertainty of 2/2.1 ≈ 0.952 — the barely-assessed twin of
  // row 3 that v1 could not tell apart from it.
  it('§3 row 4: tiny conflict (+0.05, −0.05) grades to credence 0, uncertainty 2/2.1 ≈ 0.952', () => {
    const tinyConflictContributions = [contribution(1, 0.05), contribution(2, -0.05)];
    expectGradedRow(tinyConflictContributions, 0.05, 0.05);
    expect(beliefGradingPolicyV2.gradeBelief(tinyConflictContributions)).toBeCloseTo(0, 10);
    expect(deriveBeliefUncertaintyFromEvidenceMasses(0.05, 0.05)).toBeCloseTo(2 / 2.1, 10);
  });

  // §3 row 5 — repetition (ten edges at +0.9): r = 9 → credence 9/11 ≈ 0.818,
  // uncertainty 2/11 ≈ 0.182. Repetition still reinforces (the standing
  // decision survives) but asymptotically — never 0.9999-after-ten-copies.
  it('§3 row 5: ten-edge repetition (+0.9 each) grades to 9/11 with uncertainty 2/11', () => {
    const repeatedContributions = Array.from({ length: 10 }, (_, index) =>
      contribution(index + 1, 0.9)
    );
    expectGradedRow(repeatedContributions, 9, 0);
    expect(beliefGradingPolicyV2.gradeBelief(repeatedContributions)).toBeCloseTo(9 / 11, 10);
  });

  // §3 row 6 — disbelieved source (source −0.8, support 0.75): −0.6 →
  // credence −0.6/2.6 ≈ −0.231, uncertainty 2/2.6 ≈ 0.769. The
  // opposite-belief-favouring discounting decision carries over: a
  // disbelieved source's evidence counts AGAINST what it talks about.
  it('§3 row 6: disbelieved source (−0.6) grades to −0.6/2.6 with uncertainty 2/2.6', () => {
    expectGradedRow([contribution(1, -0.6)], 0, 0.6);
    expect(beliefGradingPolicyV2.gradeBelief([contribution(1, -0.6)])).toBeCloseTo(
      -0.6 / 2.6,
      10
    );
  });

  // §3 row 7's NULL belongs to the service (no counted contributions leaves
  // the node ungraded); the PURE policy grades the empty list to the vacuous
  // opinion — masses (0, 0), credence 0, exactly like counted zeros. The
  // service test file pins the NULL half of the row.
  it('grades an empty contribution list to the vacuous opinion (credence 0)', () => {
    expect(beliefGradingPolicyV2.gradeBelief([])).toBe(0);
  });
});

describe('beliefGradingPolicyV2 projection properties', () => {
  // The projection lives in the OPEN interval (−1, +1): even an enormous
  // one-sided mass approaches the endpoint and never reaches it (spec §2 —
  // the exact range belief_credence already enforces).
  it('keeps a very large for mass strictly below +1 and a very large against mass strictly above −1', () => {
    expect(projectBeliefCredenceFromEvidenceMasses(1e6, 0)).toBeLessThan(1);
    expect(projectBeliefCredenceFromEvidenceMasses(1e6, 0)).toBeGreaterThan(0.999);
    expect(projectBeliefCredenceFromEvidenceMasses(0, 1e6)).toBeGreaterThan(-1);
    expect(projectBeliefCredenceFromEvidenceMasses(0, 1e6)).toBeLessThan(-0.999);
  });

  // Sign symmetry: swapping the two masses negates the projection and leaves
  // the uncertainty untouched — uncertainty measures how much evidence there
  // is, never which way it points.
  it('negating all contributions negates the credence and preserves the uncertainty', () => {
    const forOnlyContributions = [contribution(1, 0.6), contribution(2, 0.3)];
    const againstOnlyContributions = [contribution(1, -0.6), contribution(2, -0.3)];
    expect(beliefGradingPolicyV2.gradeBelief(againstOnlyContributions)).toBeCloseTo(
      -beliefGradingPolicyV2.gradeBelief(forOnlyContributions),
      10
    );
    expect(deriveBeliefUncertaintyFromEvidenceMasses(0.9, 0)).toBeCloseTo(
      deriveBeliefUncertaintyFromEvidenceMasses(0, 0.9),
      10
    );
  });
});
