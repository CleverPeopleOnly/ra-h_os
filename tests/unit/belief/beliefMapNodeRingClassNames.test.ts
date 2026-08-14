/**
 * SLICE 4 of the belief map overlay — the red for the pure class-name
 * composition the map node wears. Module under change:
 * src/services/belief/beliefPresentation.ts, which must gain the export
 *
 *   beliefMapNodeRingClassNames(beliefPresentation: BeliefPresentation): string[]
 *
 * — from one finished presentation decision to the exact CSS class names of
 * the map node's belief ring. Pure function only: no React, no DOM, no
 * database.
 *
 * The contract pinned here:
 *  - hue non-null -> EXACTLY ONE ring class,
 *    `rah-map-node--belief-<hue>-<intensityPercent>`; hue null (never
 *    assessed) -> the EMPTY array — no belief classes at all, whatever the
 *    other fields claim,
 *  - style 'dashed' -> additionally `rah-map-node--belief-dashed`; style
 *    'solid' -> no dashed class,
 *  - style null -> no dashed class either: the ring RENDERS SOLID. This is
 *    the carry-forward rule for the illegitimate credence-without-uncertainty
 *    state (credence set, fixed flag 0, stored uncertainty NULL — a row the
 *    display write never produces): the shared node-read mapper answers a
 *    null uncertainty there, the presentation module carries that through as
 *    a null ring style, and the class layer resolves it to the solid default
 *    rather than inventing a third visual state for an illegitimate row,
 *  - CSS cross-pin: every class name the function can emit for a derivable
 *    presentation exists in src/components/panes/map/map-styles.css, so the
 *    function can never emit a class the stylesheet lacks.
 *
 * Expected class names are DERIVED from BELIEF_RING_INTENSITY_STEPS, never
 * hard-coded percentages: a step-table change must immediately demand
 * matching class names here (and matching classes in the stylesheet, via
 * beliefMapRingClasses.test.ts).
 *
 * Import style: the presentation module exists but the class-name export
 * does not yet, so a static named import would fail `tsc --noEmit` (TS2305).
 * The module is imported as a namespace and cast to the pinned surface — the
 * namespace-cast red pattern of beliefGradingPolicyV2SubjectiveLogic.test.ts
 * — so today every test that calls the function reds with a readable
 * TypeError. The one test marked PREMISE below pins only already-shipped
 * behaviour and is green today.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import * as beliefPresentationModule from '@/services/belief/beliefPresentation';
import {
  BELIEF_RING_INTENSITY_STEPS,
  deriveBeliefPresentation,
} from '@/services/belief/beliefPresentation';
import type {
  BeliefPresentation,
  BeliefPresentationNodeFields,
  BeliefRingHue,
} from '@/services/belief/beliefPresentation';

// The surface under test, typed locally because the export does not exist
// yet — that missing export is the red this file drives. The cast keeps
// `tsc --noEmit` clean; at runtime today the function is undefined and every
// call site reds with a readable TypeError.
const { beliefMapNodeRingClassNames } = beliefPresentationModule as unknown as {
  // One presentation decision in, the map node's belief class names out.
  beliefMapNodeRingClassNames: (beliefPresentation: BeliefPresentation) => string[];
};

// Absolute path of the checked-in map stylesheet, resolved from this test
// file so the read never depends on the process working directory.
const mapStylesheetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/components/panes/map/map-styles.css'
);

// The map stylesheet source, read once, for the CSS cross-pin below.
const mapStylesheetSource = fs.readFileSync(mapStylesheetPath, 'utf8');

// The intensity percent the pinned step table assigns to one |credence|: the
// LAST row whose minAbsoluteCredence the |credence| reaches (>= semantics at
// boundaries) — restated over the EXPORTED table so every expected class
// name below is derived from BELIEF_RING_INTENSITY_STEPS, never a
// hard-coded percentage.
function beliefRingIntensityPercentFromStepsTable(absoluteCredence: number): number {
  // The percent of the deepest row reached so far; the first row starts at
  // 0 (the PREMISE test pins this), so every |credence| reaches at least it.
  let reachedIntensityPercent = BELIEF_RING_INTENSITY_STEPS[0].ringIntensityPercent;
  for (const beliefRingIntensityStep of BELIEF_RING_INTENSITY_STEPS) {
    if (absoluteCredence >= beliefRingIntensityStep.minAbsoluteCredence) {
      reachedIntensityPercent = beliefRingIntensityStep.ringIntensityPercent;
    }
  }
  return reachedIntensityPercent;
}

// The expected single ring class for one hue at one table-derived percent —
// the pinned `rah-map-node--belief-<hue>-<intensityPercent>` scheme.
function expectedBeliefRingClassName(
  beliefRingHue: BeliefRingHue,
  beliefRingIntensityPercent: number
): string {
  return `rah-map-node--belief-${beliefRingHue}-${beliefRingIntensityPercent}`;
}

// The dashed-style marker class, orthogonal to hue and intensity.
const EXPECTED_BELIEF_DASHED_CLASS_NAME = 'rah-map-node--belief-dashed';

// W of the retired belief model v2, restated by hand: the graded fixtures
// below still speak in (r, s) evidence pairs so the original expectations
// survive, but what they BUILD is a stored-column row (reshaped in the
// display-belief-door-writable slice — the mass columns are gone).
const HAND_CALCULATED_BELIEF_PRIOR_MASS = 2;

// Build a graded node's STORED belief columns from an (r, s) fixture pair:
// credence (r - s) / (r + s + W) and uncertainty W / (r + s + W) are stored
// directly, exactly as samai's engine writes them through the display write.
function gradedNodeBeliefFields(
  forMass: number,
  againstMass: number
): BeliefPresentationNodeFields {
  return {
    belief_credence:
      (forMass - againstMass) / (forMass + againstMass + HAND_CALCULATED_BELIEF_PRIOR_MASS),
    belief_credence_is_fixed: 0,
    belief_uncertainty:
      HAND_CALCULATED_BELIEF_PRIOR_MASS /
      (forMass + againstMass + HAND_CALCULATED_BELIEF_PRIOR_MASS),
  };
}

// A node nobody has ever assessed: credence NULL, uncertainty NULL, flag 0 —
// derives to the all-null presentation, the no-ring case.
const NEVER_ASSESSED_NODE_BELIEF_FIELDS: BeliefPresentationNodeFields = {
  belief_credence: null,
  belief_credence_is_fixed: 0,
  belief_uncertainty: null,
};

// The illegitimate credence-without-uncertainty row: credence set, fixed flag
// 0, stored uncertainty NULL. The display write never produces it, but the
// mapper answers it with a null uncertainty and the presentation module with
// a null ring style — the carry-forward state the null-style pin below
// exercises.
const CREDENCE_WITHOUT_STORED_UNCERTAINTY_NODE_BELIEF_FIELDS: BeliefPresentationNodeFields = {
  belief_credence: 0.5,
  belief_credence_is_fixed: 0,
  belief_uncertainty: null,
};

// Build one literal presentation decision for the defensive pins and the
// CSS cross-pin, where the (hue, intensity, style) triple is set directly.
// The uncorrelated fields (badge, uncertainty, accessible text) are filled
// with plausible constants the class-name function must ignore.
function beliefPresentationFixture(params: {
  beliefRingHue: BeliefRingHue | null;
  beliefRingIntensityPercent: number | null;
  beliefRingStyle: 'solid' | 'dashed' | null;
}): BeliefPresentation {
  return {
    beliefRingHue: params.beliefRingHue,
    beliefRingIntensityPercent: params.beliefRingIntensityPercent,
    beliefRingStyle: params.beliefRingStyle,
    beliefFixedBadgeShown: false,
    beliefUncertainty: params.beliefRingStyle === 'dashed' ? 0.8 : params.beliefRingStyle === 'solid' ? 0.2 : null,
    beliefAccessibleText: 'fixture accessible text',
  };
}

describe('beliefMapNodeRingClassNames premise', () => {
  // PREMISE (green today): the derived-pairs enumeration in the cross-pin
  // below assumes |0| reaches only the FIRST table row — true exactly when
  // the first row starts at 0 and every later row starts above 0.
  it('reads a step table whose first row starts at 0 and later rows above 0', () => {
    expect(BELIEF_RING_INTENSITY_STEPS[0].minAbsoluteCredence).toBe(0);
    for (const laterBeliefRingIntensityStep of BELIEF_RING_INTENSITY_STEPS.slice(1)) {
      expect(laterBeliefRingIntensityStep.minAbsoluteCredence).toBeGreaterThan(0);
    }
  });
});

describe('beliefMapNodeRingClassNames on derived presentations', () => {
  // Believed on solid evidence: r=6, s=2 -> credence +0.4, uncertainty 0.2 —
  // 'for' hue, solid style. Exactly ONE class: the hue-intensity ring class
  // at the table-derived percent, and no dashed class.
  it("gives a believed solid node exactly one class: the 'for' ring at its table-derived percent", () => {
    const believedSolidPresentation = deriveBeliefPresentation(gradedNodeBeliefFields(6, 2));
    // Premise of this case, so a fixture drift cannot silently retarget it.
    expect(believedSolidPresentation.beliefRingHue).toBe('for');
    expect(believedSolidPresentation.beliefRingStyle).toBe('solid');
    expect(beliefMapNodeRingClassNames(believedSolidPresentation)).toEqual([
      expectedBeliefRingClassName('for', beliefRingIntensityPercentFromStepsTable(0.4)),
    ]);
  });

  // Disbelieved on sparse evidence: r=0, s=0.5 -> credence -0.2,
  // uncertainty 0.8 — 'against' hue, dashed style. Two classes: the ring
  // class AND the dashed marker (order not pinned; the set is).
  it("gives a disbelieved dashed node its 'against' ring class plus the dashed class", () => {
    const disbelievedDashedPresentation = deriveBeliefPresentation(gradedNodeBeliefFields(0, 0.5));
    // Premise of this case, as above.
    expect(disbelievedDashedPresentation.beliefRingHue).toBe('against');
    expect(disbelievedDashedPresentation.beliefRingStyle).toBe('dashed');
    const disbelievedClassNames = beliefMapNodeRingClassNames(disbelievedDashedPresentation);
    expect(disbelievedClassNames).toHaveLength(2);
    expect(disbelievedClassNames).toContain(
      expectedBeliefRingClassName('against', beliefRingIntensityPercentFromStepsTable(0.2))
    );
    expect(disbelievedClassNames).toContain(EXPECTED_BELIEF_DASHED_CLASS_NAME);
  });

  // Graded and balanced: r=3, s=3 -> credence exactly 0, uncertainty 0.25 —
  // 'neutral' hue at the first band (|0| reaches only the first row), solid.
  // A REAL assessment: one class, never the empty array.
  it('gives a graded-neutral node exactly the neutral ring class at the first band', () => {
    const gradedNeutralPresentation = deriveBeliefPresentation(gradedNodeBeliefFields(3, 3));
    // Premise of this case, as above.
    expect(gradedNeutralPresentation.beliefRingHue).toBe('neutral');
    expect(gradedNeutralPresentation.beliefRingStyle).toBe('solid');
    expect(beliefMapNodeRingClassNames(gradedNeutralPresentation)).toEqual([
      expectedBeliefRingClassName('neutral', BELIEF_RING_INTENSITY_STEPS[0].ringIntensityPercent),
    ]);
  });

  // Never assessed: hue null -> the EMPTY array. A plain node with no belief
  // treatment at all — not one class, not a neutral ring.
  it('gives a never-assessed node no belief classes at all', () => {
    const neverAssessedPresentation = deriveBeliefPresentation(NEVER_ASSESSED_NODE_BELIEF_FIELDS);
    expect(beliefMapNodeRingClassNames(neverAssessedPresentation)).toEqual([]);
  });

  // THE NULL-STYLE CARRY-FORWARD: the illegitimate
  // credence-without-uncertainty row derives to a non-null hue with a NULL
  // ring style. The class layer resolves null to the solid default — the
  // ring class is worn, the dashed class is NOT — rather than inventing a
  // third visual state for a row the display write never produces.
  it('renders a null ring style as solid: ring class present, dashed class absent', () => {
    const nullStylePresentation = deriveBeliefPresentation(
      CREDENCE_WITHOUT_STORED_UNCERTAINTY_NODE_BELIEF_FIELDS
    );
    // Premise: this row really is the null-style state (hue set, style null).
    expect(nullStylePresentation.beliefRingHue).toBe('for');
    expect(nullStylePresentation.beliefRingStyle).toBeNull();
    expect(beliefMapNodeRingClassNames(nullStylePresentation)).toEqual([
      expectedBeliefRingClassName('for', beliefRingIntensityPercentFromStepsTable(0.5)),
    ]);
  });
});

describe('beliefMapNodeRingClassNames null hue gates everything', () => {
  // Defensive pin: hue null means NO belief classes even if a stowaway
  // dashed style rides on the presentation — the never-assessed decision is
  // total, and a dashed class with no ring class would style a border the
  // node does not wear.
  it('returns the empty array for a null hue even with a stowaway dashed style', () => {
    const nullHueDashedStowawayPresentation = beliefPresentationFixture({
      beliefRingHue: null,
      beliefRingIntensityPercent: null,
      beliefRingStyle: 'dashed',
    });
    expect(beliefMapNodeRingClassNames(nullHueDashedStowawayPresentation)).toEqual([]);
  });
});

describe('beliefMapNodeRingClassNames agrees with map-styles.css', () => {
  // Every (hue, intensity) pair a DERIVABLE presentation can carry: 'for'
  // and 'against' at every table percent, 'neutral' at the first band only
  // (credence 0 is the only neutral credence, and |0| reaches only the first
  // row — the PREMISE test above). The class-name function is pure over its
  // input, so its legitimate input space is exactly what
  // deriveBeliefPresentation can produce.
  const derivableBeliefRingPairs: ReadonlyArray<{
    beliefRingHue: BeliefRingHue;
    beliefRingIntensityPercent: number;
  }> = [
    ...(['for', 'against'] as const).flatMap((beliefRingHue) =>
      BELIEF_RING_INTENSITY_STEPS.map((beliefRingIntensityStep) => ({
        beliefRingHue,
        beliefRingIntensityPercent: beliefRingIntensityStep.ringIntensityPercent,
      }))
    ),
    {
      beliefRingHue: 'neutral',
      beliefRingIntensityPercent: BELIEF_RING_INTENSITY_STEPS[0].ringIntensityPercent,
    },
  ];

  // THE CROSS-PIN: run the function over every derivable pair in both the
  // solid and the dashed style, collect every class name it emits, and
  // demand each one exists as a selector in the checked-in stylesheet — the
  // function can never emit a class the stylesheet lacks. The collected set
  // must also have the full expected size (one ring class per pair plus the
  // one dashed class), so the pin can never pass vacuously on an
  // empty-returning stub.
  it('emits only class names that map-styles.css declares, covering every derivable pair', () => {
    // Every distinct class name emitted across the whole derivable space.
    const emittedBeliefClassNames = new Set<string>();
    for (const { beliefRingHue, beliefRingIntensityPercent } of derivableBeliefRingPairs) {
      for (const beliefRingStyle of ['solid', 'dashed'] as const) {
        const emittedForPair = beliefMapNodeRingClassNames(
          beliefPresentationFixture({ beliefRingHue, beliefRingIntensityPercent, beliefRingStyle })
        );
        for (const emittedClassName of emittedForPair) {
          emittedBeliefClassNames.add(emittedClassName);
        }
      }
    }
    // One ring class per derivable pair + the one dashed class.
    expect(emittedBeliefClassNames.size).toBe(derivableBeliefRingPairs.length + 1);
    for (const emittedClassName of emittedBeliefClassNames) {
      // Each emitted name is a single well-formed belief class token …
      expect(emittedClassName).toMatch(/^rah-map-node--belief-[a-z0-9-]+$/);
      // … and the stylesheet declares a rule for it. Class names contain
      // only letters, digits and hyphens, so raw interpolation is
      // regex-safe.
      expect(
        mapStylesheetSource,
        `map-styles.css must declare .${emittedClassName}`
      ).toMatch(new RegExp(String.raw`\.${emittedClassName}\s*\{`));
    }
  });
});
