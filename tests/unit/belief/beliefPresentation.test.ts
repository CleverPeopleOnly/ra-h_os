/**
 * Pure presentation mapping for a node's belief fields — the module under
 * test is src/services/belief/beliefPresentation.ts (new, this is the red).
 * No React, no database, no DOM: pure functions from the four belief node
 * fields to the presentation decisions the belief UI (MR-B) will render.
 *
 * The contract pinned here:
 *  - RING HUE: 'for' when credence > 0, 'against' when credence < 0,
 *    'neutral' when credence === 0 (graded and balanced), and null when
 *    credence is null — never assessed means NO belief treatment at all,
 *  - RING INTENSITY: a stepped color-mix percentage, monotonically
 *    non-decreasing in |credence| and bounded (the exact step table below is
 *    the reviewable design decision),
 *  - RING STYLE: dashed when the derived uncertainty is >= 0.5, solid below;
 *    the uncertainty must agree EXACTLY with the shared node-read mapper
 *    beliefFieldsForNodeRead (src/services/belief/beliefMcpToolContract.js),
 *  - FIXED BADGE: shown iff belief_credence_is_fixed is 1,
 *  - ACCESSIBLE TEXT: a short human-readable belief summary in the enforced
 *    vocabulary — never the banned credence synonyms, and a never-assessed
 *    node says it has not been assessed rather than showing 0,
 *  - NO `?? 0` SEMANTICS: a null credence never renders as 0 anywhere.
 *
 * Import style: the module does not exist yet, so a static import (even a
 * namespace one) would fail `tsc --noEmit` with TS2307 and take the file down
 * at link time. The specifier therefore lives in a VARIABLE: TypeScript types
 * the dynamic import as `any` (cast to the pinned surface below), and vitest
 * resolves the alias at runtime — today every test reds with a readable
 * "Cannot find module" rejection, the missing-feature analogue of the
 * namespace-cast pattern in beliefGradingPolicyV2SubjectiveLogic.test.ts.
 *
 * The shared mapper IS imported statically: beliefMcpToolContract exists,
 * has no side effects and never touches the SQLite client.
 */

import { describe, expect, it } from 'vitest';
import * as beliefMcpToolContract from '@/services/belief/beliefMcpToolContract';

// The four belief fields of one node as the presentation module takes them —
// the exact column names of the nodes row, so the same row object that feeds
// the shared node-read mapper feeds this module too. A type alias rather than
// an interface so a value of it is assignable to the mapper's
// Record<string, unknown> parameter without a cast.
type BeliefPresentationNodeFields = {
  belief_credence: number | null;
  belief_credence_is_fixed: number;
  belief_evidence_for_mass: number | null;
  belief_evidence_against_mass: number | null;
};

// Which way the ring reads: toward the node ('for'), against it, or graded
// and balanced ('neutral'). null hue means no ring at all.
type BeliefRingHue = 'for' | 'against' | 'neutral';

// One row of the pinned intensity step table: every |credence| at or above
// minAbsoluteCredence (and below the next row's) renders at ringIntensityPercent.
interface BeliefRingIntensityStep {
  minAbsoluteCredence: number;
  ringIntensityPercent: number;
}

// The full presentation decision for one node, as MR-B's components will
// consume it. Every ring field is null exactly when the node was never
// assessed — a plain node with no belief treatment at all.
interface BeliefPresentation {
  beliefRingHue: BeliefRingHue | null;
  beliefRingIntensityPercent: number | null;
  beliefRingStyle: 'solid' | 'dashed' | null;
  beliefFixedBadgeShown: boolean;
  beliefUncertainty: number | null;
  beliefAccessibleText: string;
}

// The module surface under test, typed locally because the module does not
// exist yet — that missing surface is the red this file drives.
interface BeliefPresentationModuleSurface {
  // The single pure entry: node belief fields in, presentation decision out.
  deriveBeliefPresentation: (
    nodeBeliefFields: BeliefPresentationNodeFields
  ) => BeliefPresentation;
  // The pinned intensity step table, exported so MR-B and this test share it.
  BELIEF_RING_INTENSITY_STEPS: ReadonlyArray<BeliefRingIntensityStep>;
}

// The module path as a VARIABLE (see module comment): a literal specifier of
// a not-yet-existing module would fail tsc, so the miss must surface at await
// time inside each test instead.
const beliefPresentationModulePath = '@/services/belief/beliefPresentation';

// Import the presentation module under test, cast to the pinned surface.
async function importBeliefPresentationModule(): Promise<BeliefPresentationModuleSurface> {
  return (await import(beliefPresentationModulePath)) as BeliefPresentationModuleSurface;
}

/**
 * THE STEP TABLE IS THE REVIEWABLE DESIGN DECISION of this file. Chosen
 * steps: intensity is the ringIntensityPercent of the LAST row whose
 * minAbsoluteCredence <= |credence|.
 *
 *   |credence| in [0,    0.15) -> 15   barely leaning: the smallest visible step
 *   |credence| in [0.15, 0.4 ) -> 30   leaning
 *   |credence| in [0.4,  0.7 ) -> 55   committed
 *   |credence| in [0.7,  1   ) -> 80   strongly committed
 *
 * Bounded at 80, never 100: credence lives in the OPEN interval (-1, +1), so
 * total certainty is not expressible and the ring must never render as if it
 * were. Monotonically non-decreasing by construction (rows ascend).
 */
const EXPECTED_BELIEF_RING_INTENSITY_STEPS: ReadonlyArray<BeliefRingIntensityStep> = [
  { minAbsoluteCredence: 0, ringIntensityPercent: 15 },
  { minAbsoluteCredence: 0.15, ringIntensityPercent: 30 },
  { minAbsoluteCredence: 0.4, ringIntensityPercent: 55 },
  { minAbsoluteCredence: 0.7, ringIntensityPercent: 80 },
];

// W of belief model v2, restated by hand so the expected uncertainties below
// are an independent calculation, not an import of the constant under test.
const HAND_CALCULATED_BELIEF_PRIOR_MASS = 2;

// Expected derived uncertainty W/(r+s+W) for a graded node's masses.
function handCalculatedBeliefUncertainty(forMass: number, againstMass: number): number {
  return (
    HAND_CALCULATED_BELIEF_PRIOR_MASS /
    (forMass + againstMass + HAND_CALCULATED_BELIEF_PRIOR_MASS)
  );
}

// Expected credence projection (r-s)/(r+s+W): fixtures below store the cached
// belief_credence CONSISTENT with their masses, the way the engine writes it.
function handCalculatedBeliefCredenceProjection(forMass: number, againstMass: number): number {
  return (
    (forMass - againstMass) /
    (forMass + againstMass + HAND_CALCULATED_BELIEF_PRIOR_MASS)
  );
}

// Build a graded (engine-derived) node's belief fields from its two masses,
// with the cached credence being the projection — exactly what the v2 engine
// persists.
function gradedNodeBeliefFields(forMass: number, againstMass: number): BeliefPresentationNodeFields {
  return {
    belief_credence: handCalculatedBeliefCredenceProjection(forMass, againstMass),
    belief_credence_is_fixed: 0,
    belief_evidence_for_mass: forMass,
    belief_evidence_against_mass: againstMass,
  };
}

// A node whose credence a human asserted by hand: flag 1, masses NULL —
// there is no evidence ledger behind an assertion.
function fixedCredenceNodeBeliefFields(assertedCredence: number): BeliefPresentationNodeFields {
  return {
    belief_credence: assertedCredence,
    belief_credence_is_fixed: 1,
    belief_evidence_for_mass: null,
    belief_evidence_against_mass: null,
  };
}

// A node nobody has ever assessed: credence NULL, masses NULL, flag 0.
const NEVER_ASSESSED_NODE_BELIEF_FIELDS: BeliefPresentationNodeFields = {
  belief_credence: null,
  belief_credence_is_fixed: 0,
  belief_evidence_for_mass: null,
  belief_evidence_against_mass: null,
};

describe('BELIEF_RING_INTENSITY_STEPS', () => {
  // The exported table must BE the pinned design decision, row for row — the
  // UI (MR-B) reads its steps from this export, so drift here is drift on
  // screen.
  it('exports the exact pinned step table', async () => {
    const { BELIEF_RING_INTENSITY_STEPS } = await importBeliefPresentationModule();
    expect(BELIEF_RING_INTENSITY_STEPS).toEqual(EXPECTED_BELIEF_RING_INTENSITY_STEPS);
  });
});

describe('deriveBeliefPresentation ring hue', () => {
  // Positive credence reads for the node.
  it("gives hue 'for' when credence is positive", async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    // r=2, s=0 -> credence +0.5.
    expect(deriveBeliefPresentation(gradedNodeBeliefFields(2, 0)).beliefRingHue).toBe('for');
  });

  // Negative credence reads against the node — credence is the only signed
  // quantity in the system and the sign must survive into the hue.
  it("gives hue 'against' when credence is negative", async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    // r=1, s=7 -> credence -0.6.
    expect(deriveBeliefPresentation(gradedNodeBeliefFields(1, 7)).beliefRingHue).toBe('against');
  });

  // Credence exactly 0 is graded-and-balanced: a REAL assessment, so it gets
  // a ring — the neutral hue — and must never collapse into "no ring".
  it("gives hue 'neutral' when credence is exactly 0 (graded, balanced)", async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    // Heavy conflict, r=3 s=3: credence 0, confidently assessed.
    expect(deriveBeliefPresentation(gradedNodeBeliefFields(3, 3)).beliefRingHue).toBe('neutral');
  });

  // NULL credence means never assessed: no hue at all — and explicitly not
  // 'neutral', which would claim the node had been graded to a balance.
  it('gives hue null — not neutral — when credence is null', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    const neverAssessedPresentation = deriveBeliefPresentation(NEVER_ASSESSED_NODE_BELIEF_FIELDS);
    expect(neverAssessedPresentation.beliefRingHue).toBeNull();
    expect(neverAssessedPresentation.beliefRingHue).not.toBe('neutral');
  });
});

describe('deriveBeliefPresentation never-assessed nodes get no belief treatment', () => {
  // The whole presentation for a never-assessed node must be visually
  // indistinguishable from a plain node: every ring field null, no badge.
  it('returns null for every ring field and no badge when the node was never assessed', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    const neverAssessedPresentation = deriveBeliefPresentation(NEVER_ASSESSED_NODE_BELIEF_FIELDS);
    expect(neverAssessedPresentation.beliefRingHue).toBeNull();
    expect(neverAssessedPresentation.beliefRingIntensityPercent).toBeNull();
    expect(neverAssessedPresentation.beliefRingStyle).toBeNull();
    expect(neverAssessedPresentation.beliefFixedBadgeShown).toBe(false);
    expect(neverAssessedPresentation.beliefUncertainty).toBeNull();
  });
});

describe('deriveBeliefPresentation ring intensity', () => {
  // Every band of the pinned table, including both edges of each boundary:
  // a boundary |credence| belongs to the HIGHER band (>= semantics).
  it('maps |credence| onto the pinned steps, boundaries included', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    // [|credence| probed, expected intensity %] pairs covering every band
    // and both sides of every boundary of the pinned table.
    const intensityExpectations: Array<[number, number]> = [
      [0, 15],
      [0.14, 15],
      [0.15, 30],
      [0.39, 30],
      [0.4, 55],
      [0.69, 55],
      [0.7, 80],
      [0.99, 80],
    ];
    for (const [absoluteCredence, expectedIntensityPercent] of intensityExpectations) {
      // Masses consistent enough for a graded row; hue/intensity read the
      // cached credence field, so it is set directly here.
      const gradedFields: BeliefPresentationNodeFields = {
        belief_credence: absoluteCredence,
        belief_credence_is_fixed: 0,
        belief_evidence_for_mass: 1,
        belief_evidence_against_mass: 0,
      };
      expect(
        deriveBeliefPresentation(gradedFields).beliefRingIntensityPercent,
        `|credence| ${absoluteCredence} must render at ${expectedIntensityPercent}%`
      ).toBe(expectedIntensityPercent);
    }
  });

  // Intensity depends on |credence|: a disbelieved node rings as strongly as
  // an equally believed one — the hue, not the intensity, carries the sign.
  it('uses the absolute credence, so -0.5 renders as strongly as +0.5', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    // r=1, s=7 -> credence -0.6, |credence| in the 55% band.
    expect(
      deriveBeliefPresentation(gradedNodeBeliefFields(1, 7)).beliefRingIntensityPercent
    ).toBe(55);
  });

  // The monotonicity and boundedness contract, swept over the whole credence
  // range: more credence never renders fainter, and the percentage never
  // leaves the pinned table's range.
  it('is monotonically non-decreasing in |credence| and bounded by the pinned steps', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    // The intensity of the previous grid point, for the monotonicity check.
    let previousIntensityPercent = -Infinity;
    for (let absoluteCredence = 0; absoluteCredence < 1; absoluteCredence += 0.01) {
      const sweptFields: BeliefPresentationNodeFields = {
        belief_credence: absoluteCredence,
        belief_credence_is_fixed: 0,
        belief_evidence_for_mass: 1,
        belief_evidence_against_mass: 0,
      };
      const sweptIntensityPercent =
        deriveBeliefPresentation(sweptFields).beliefRingIntensityPercent;
      expect(sweptIntensityPercent, `|credence| ${absoluteCredence} must have an intensity`).not.toBeNull();
      expect(sweptIntensityPercent!).toBeGreaterThanOrEqual(previousIntensityPercent);
      expect(sweptIntensityPercent!).toBeGreaterThanOrEqual(15);
      expect(sweptIntensityPercent!).toBeLessThanOrEqual(80);
      previousIntensityPercent = sweptIntensityPercent!;
    }
  });
});

describe('deriveBeliefPresentation ring style', () => {
  // Little evidence behind the credence -> dashed. r=s=0.5 gives u = 2/3.
  it('is dashed when the derived uncertainty is above 0.5', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    expect(deriveBeliefPresentation(gradedNodeBeliefFields(0.5, 0.5)).beliefRingStyle).toBe('dashed');
  });

  // The boundary belongs to dashed: uncertainty EXACTLY 0.5 (r+s = W = 2)
  // still reads as "questionable".
  it('is dashed at uncertainty exactly 0.5', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    // r=2, s=0 -> u = 2/4 = 0.5 exactly.
    expect(deriveBeliefPresentation(gradedNodeBeliefFields(2, 0)).beliefRingStyle).toBe('dashed');
  });

  // Heavy evidence -> solid. r=6, s=2 gives u = 2/10 = 0.2.
  it('is solid when the derived uncertainty is below 0.5', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    expect(deriveBeliefPresentation(gradedNodeBeliefFields(6, 2)).beliefRingStyle).toBe('solid');
  });

  // A fixed credence is the dogmatic opinion: uncertainty 0 by definition,
  // even though its masses are NULL — so its ring is always solid.
  it('is solid for a fixed-credence node (uncertainty 0 by definition)', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    const fixedPresentation = deriveBeliefPresentation(fixedCredenceNodeBeliefFields(-0.4));
    expect(fixedPresentation.beliefUncertainty).toBe(0);
    expect(fixedPresentation.beliefRingStyle).toBe('solid');
  });

  // The vacuous opinion — assessed and carrying nothing, r=s=0 — is maximal
  // uncertainty (u=1): a neutral, dashed ring, never "no ring".
  it('renders the vacuous opinion (both masses 0) as a dashed neutral ring', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    const vacuousPresentation = deriveBeliefPresentation(gradedNodeBeliefFields(0, 0));
    expect(vacuousPresentation.beliefRingHue).toBe('neutral');
    expect(vacuousPresentation.beliefRingStyle).toBe('dashed');
    expect(vacuousPresentation.beliefUncertainty).toBe(1);
  });
});

describe('deriveBeliefPresentation uncertainty agrees with the shared node-read mapper', () => {
  // The AGREEMENT test: for every node state the presentation module's
  // uncertainty must equal beliefFieldsForNodeRead's belief_uncertainty
  // EXACTLY (toBe, not toBeCloseTo) — derivation-beats-stored, one formula,
  // one owner. The same row object feeds both sides.
  it('equals beliefFieldsForNodeRead(row).belief_uncertainty exactly for graded, fixed and never-assessed rows', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    // One row per node state the mapper distinguishes: engine-graded,
    // vacuous, fixed (masses NULL, flag 1), and never assessed.
    const nodeRowsToAgreeOn: BeliefPresentationNodeFields[] = [
      gradedNodeBeliefFields(6, 2),
      gradedNodeBeliefFields(0.5, 0.5),
      gradedNodeBeliefFields(0, 0),
      fixedCredenceNodeBeliefFields(-0.4),
      NEVER_ASSESSED_NODE_BELIEF_FIELDS,
    ];
    for (const nodeRow of nodeRowsToAgreeOn) {
      const mapperBeliefFields = beliefMcpToolContract.beliefFieldsForNodeRead(nodeRow);
      expect(
        deriveBeliefPresentation(nodeRow).beliefUncertainty,
        `presentation and mapper must agree on the row ${JSON.stringify(nodeRow)}`
      ).toBe(mapperBeliefFields.belief_uncertainty);
    }
  });

  // Fixed -> 0 -> solid; never assessed -> null -> no ring at all. The two
  // ends of the mapper's contract, restated as presentation outcomes.
  it('turns the mapper\'s 0 into solid and its null into no ring', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    expect(deriveBeliefPresentation(fixedCredenceNodeBeliefFields(0.9)).beliefRingStyle).toBe('solid');
    expect(deriveBeliefPresentation(NEVER_ASSESSED_NODE_BELIEF_FIELDS).beliefRingStyle).toBeNull();
  });

  // Derivation beats stored, at the presentation layer too: a bogus
  // belief_uncertainty key riding on the row must be ignored in favour of
  // the derivation from the masses — a stored uncertainty is exactly the
  // stale cache the belief model refuses to create.
  it('ignores a belief_uncertainty key riding on the row and derives from the masses', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    // Masses say u = 0.2 (solid); the stowaway key claims 0.99 (dashed).
    const rowWithStowawayUncertainty = {
      ...gradedNodeBeliefFields(6, 2),
      belief_uncertainty: 0.99,
    };
    const derivedPresentation = deriveBeliefPresentation(rowWithStowawayUncertainty);
    expect(derivedPresentation.beliefUncertainty).toBe(handCalculatedBeliefUncertainty(6, 2));
    expect(derivedPresentation.beliefRingStyle).toBe('solid');
  });
});

describe('deriveBeliefPresentation fixed badge', () => {
  // The badge is the fixed flag, nothing else: 1 shows it, 0 hides it.
  it('shows the badge iff belief_credence_is_fixed is 1', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    expect(deriveBeliefPresentation(fixedCredenceNodeBeliefFields(0.7)).beliefFixedBadgeShown).toBe(true);
    expect(deriveBeliefPresentation(gradedNodeBeliefFields(2, 0)).beliefFixedBadgeShown).toBe(false);
    expect(deriveBeliefPresentation(NEVER_ASSESSED_NODE_BELIEF_FIELDS).beliefFixedBadgeShown).toBe(false);
  });
});

describe('deriveBeliefPresentation accessible text', () => {
  // The exact wording is a design decision pinned here: "credence <n>,
  // uncertainty <n>" with both numbers to two decimals — the enforced
  // vocabulary, nothing else.
  it('summarises a graded node as "credence <n>, uncertainty <n>"', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    // r=1, s=7 -> credence -0.60, uncertainty 0.20.
    expect(deriveBeliefPresentation(gradedNodeBeliefFields(1, 7)).beliefAccessibleText).toBe(
      'credence -0.60, uncertainty 0.20'
    );
    // r=0.4, s=0 -> credence 0.4/2.4 = 0.17, uncertainty 2/2.4 = 0.83.
    expect(deriveBeliefPresentation(gradedNodeBeliefFields(0.4, 0)).beliefAccessibleText).toBe(
      'credence 0.17, uncertainty 0.83'
    );
    // Balanced heavy conflict r=3, s=3: an assessed 0 IS spoken as 0 — that
    // is the one place "credence 0.00" is the truth.
    expect(deriveBeliefPresentation(gradedNodeBeliefFields(3, 3)).beliefAccessibleText).toBe(
      'credence 0.00, uncertainty 0.25'
    );
  });

  // A fixed credence names itself: the human assertion is part of the story.
  it('summarises a fixed node as "credence <n>, uncertainty 0.00, fixed by hand"', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    expect(deriveBeliefPresentation(fixedCredenceNodeBeliefFields(-0.4)).beliefAccessibleText).toBe(
      'credence -0.40, uncertainty 0.00, fixed by hand'
    );
  });

  // A never-assessed node SAYS it has not been assessed — no number at all,
  // because any number (0 above all) would claim an assessment that never
  // happened.
  it('says a never-assessed node has not been assessed, with no number', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    const neverAssessedText = deriveBeliefPresentation(
      NEVER_ASSESSED_NODE_BELIEF_FIELDS
    ).beliefAccessibleText;
    expect(neverAssessedText).toBe('belief not assessed');
    expect(neverAssessedText).toMatch(/not assessed/);
    // No digit anywhere: "credence 0" for an unassessed node is the lie the
    // whole NULL-vs-0 rule exists to prevent.
    expect(neverAssessedText).not.toMatch(/\d/);
  });

  // The vocabulary guard: the banned credence synonyms must never appear in
  // any produced string, whatever the node state.
  it('never uses the banned words trust/standing/score/weight/value', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    // Every node state the module distinguishes, in one battery.
    const nodeStateBattery: BeliefPresentationNodeFields[] = [
      gradedNodeBeliefFields(6, 2),
      gradedNodeBeliefFields(1, 7),
      gradedNodeBeliefFields(0, 0),
      gradedNodeBeliefFields(3, 3),
      fixedCredenceNodeBeliefFields(0.9),
      fixedCredenceNodeBeliefFields(-0.4),
      NEVER_ASSESSED_NODE_BELIEF_FIELDS,
    ];
    // Whole-word match, case-insensitive: these five words are banned as
    // credence synonyms everywhere in belief code (CLAUDE.md vocabulary rule).
    const bannedCredenceSynonyms = /\b(trust|standing|score|weight|value)\b/i;
    for (const nodeState of nodeStateBattery) {
      const producedText = deriveBeliefPresentation(nodeState).beliefAccessibleText;
      expect(producedText, `"${producedText}" must not use a banned credence synonym`).not.toMatch(
        bannedCredenceSynonyms
      );
    }
  });
});

describe('deriveBeliefPresentation null credence never renders as 0', () => {
  // The explicit `?? 0` pin: every place a lazy implementation could coerce a
  // null credence into 0 — hue (neutral), intensity (the smallest step), text
  // ("credence 0.00") — must instead carry the never-assessed state.
  it('gives a never-assessed node none of the outputs a credence-0 node gets', async () => {
    const { deriveBeliefPresentation } = await importBeliefPresentationModule();
    const neverAssessedPresentation = deriveBeliefPresentation(NEVER_ASSESSED_NODE_BELIEF_FIELDS);
    // What an ACTUAL credence-0 node (vacuous opinion) renders as, for contrast.
    const gradedZeroPresentation = deriveBeliefPresentation(gradedNodeBeliefFields(0, 0));

    expect(neverAssessedPresentation.beliefRingHue).toBeNull();
    expect(neverAssessedPresentation.beliefRingHue).not.toBe(gradedZeroPresentation.beliefRingHue);
    expect(neverAssessedPresentation.beliefRingIntensityPercent).toBeNull();
    expect(neverAssessedPresentation.beliefRingIntensityPercent).not.toBe(
      gradedZeroPresentation.beliefRingIntensityPercent
    );
    expect(neverAssessedPresentation.beliefAccessibleText).not.toContain('credence 0');
  });
});
