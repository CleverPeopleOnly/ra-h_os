/**
 * The map stylesheet (src/components/panes/map/map-styles.css) must declare
 * one belief ring class per (hue, intensity) pair the belief presentation
 * module can emit, plus one dashed-style class — slice 2 of the belief map
 * overlay declares the classes only; a later slice composes the class names
 * on the map node from the presentation fields.
 *
 * The pinned class scheme (CLAUDE.md naming: class names must say belief):
 *  - `.rah-map-node--belief-<hue>-<intensity>` for each renderable pair,
 *    with border-color mixed FROM THE BELIEF THEME TOKEN at exactly the
 *    intensity percentage: `color-mix(in srgb, var(--rah-belief-<hue>) N%, …)`
 *    — the mix partner is deliberately unpinned because the codebase mixes
 *    into varying bases (white, --rah-border-strong, …), and extra
 *    declarations (border-width etc.) are tolerated;
 *  - `.rah-map-node--belief-dashed` with `border-style: dashed` — the
 *    high-uncertainty marker, orthogonal to hue and intensity;
 *  - NO belief class may hard-code a hex — every belief colour must come
 *    from the --rah-belief-* theme tokens pinned by beliefThemeTokens.test.ts.
 *
 * The expected (hue, intensity) pairs are DERIVED from
 * BELIEF_RING_INTENSITY_STEPS imported from the presentation module, never
 * hard-coded: if the step table ever changes, this test immediately demands
 * a matching set of classes, so the stylesheet can never silently drift from
 * what the presentation module emits.
 *
 * A CSS class's absence is invisible to the type system and this harness runs
 * node-env vitest with no jsdom, so the pin reads the checked-in stylesheet
 * source and asserts against its text — the same source-text pinning used by
 * beliefThemeTokens.test.ts.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import {
  BELIEF_RING_INTENSITY_STEPS,
  type BeliefRingHue,
} from '@/services/belief/beliefPresentation';

// Absolute path of the checked-in map stylesheet, resolved from this test
// file so the read never depends on the process working directory.
const mapStylesheetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/components/panes/map/map-styles.css'
);

// The map stylesheet source, read once for every assertion in this file.
const mapStylesheetSource = fs.readFileSync(mapStylesheetPath, 'utf8');

// Extracts the body text of the first CSS rule for the given belief class,
// robust to whitespace between selector and brace. The map stylesheet
// contains only flat rules (no nested braces), so "everything up to the
// first closing brace" is the whole rule body. Fails the calling test with a
// named error if the class is missing — a missing class is its own failure
// mode, distinct from a wrong declaration inside an existing class.
function readBeliefClassDeclarations(beliefClassName: string): string {
  const beliefClassRuleMatch = mapStylesheetSource.match(
    new RegExp(String.raw`\.${beliefClassName}\s*\{([^}]*)\}`)
  );
  if (!beliefClassRuleMatch) {
    throw new Error(`map-styles.css declares no .${beliefClassName} class`);
  }
  return beliefClassRuleMatch[1];
}

// The intensity percentages the presentation module can emit, read off the
// pinned step table (one per row) — never hard-coded here, so a table change
// makes this test demand the matching classes.
const beliefRingIntensityPercents = BELIEF_RING_INTENSITY_STEPS.map(
  (beliefRingIntensityStep) => beliefRingIntensityStep.ringIntensityPercent
);

// The one intensity a graded-neutral node can render at: neutral hue means
// credence === 0, so |credence| is 0 and reaches only the table's FIRST step
// (its minAbsoluteCredence is 0; every later row's is above 0). Neutral
// therefore needs exactly one class, at the first row's percentage.
const beliefNeutralRingIntensityPercent = BELIEF_RING_INTENSITY_STEPS[0].ringIntensityPercent;

// Every (hue, intensity) pair the presentation module can emit, and so every
// ring class the stylesheet must declare: 'for' and 'against' at every step
// percentage, 'neutral' at the first step's percentage only.
const expectedBeliefRingClassPairs: ReadonlyArray<{
  beliefRingHue: BeliefRingHue;
  beliefRingIntensityPercent: number;
}> = [
  ...(['for', 'against'] as const).flatMap((beliefRingHue) =>
    beliefRingIntensityPercents.map((beliefRingIntensityPercent) => ({
      beliefRingHue,
      beliefRingIntensityPercent,
    }))
  ),
  {
    beliefRingHue: 'neutral',
    beliefRingIntensityPercent: beliefNeutralRingIntensityPercent,
  },
];

describe('belief ring classes in map-styles.css', () => {
  // Premises of the derived class list, asserted so the list above can never
  // silently mean something else: |0| reaches only the first step exactly
  // when the first row starts at 0 and every later row starts above 0.
  it('derives the neutral intensity from a step table whose first row starts at 0', () => {
    expect(BELIEF_RING_INTENSITY_STEPS[0].minAbsoluteCredence).toBe(0);
    for (const laterBeliefRingIntensityStep of BELIEF_RING_INTENSITY_STEPS.slice(1)) {
      expect(laterBeliefRingIntensityStep.minAbsoluteCredence).toBeGreaterThan(0);
    }
  });

  // One test per renderable (hue, intensity) pair: the class exists and its
  // border-color mixes the matching belief theme token at the matching
  // percentage. Tolerant of the mix partner after the comma and of any extra
  // declarations in the rule (border-width etc.).
  for (const { beliefRingHue, beliefRingIntensityPercent } of expectedBeliefRingClassPairs) {
    const beliefRingClassName = `rah-map-node--belief-${beliefRingHue}-${beliefRingIntensityPercent}`;
    it(`declares .${beliefRingClassName} with border-color color-mix of var(--rah-belief-${beliefRingHue}) at ${beliefRingIntensityPercent}%`, () => {
      const beliefRingClassDeclarations = readBeliefClassDeclarations(beliefRingClassName);
      expect(beliefRingClassDeclarations).toMatch(
        new RegExp(
          String.raw`border-color\s*:\s*color-mix\(\s*in srgb\s*,\s*var\(\s*--rah-belief-${beliefRingHue}\s*\)\s*${beliefRingIntensityPercent}%\s*,`
        )
      );
    });
  }

  // The high-uncertainty marker class: dashed border, orthogonal to hue and
  // intensity (a later slice renders a null ring style as solid, so no
  // solid-style class is required here).
  it('declares .rah-map-node--belief-dashed with border-style: dashed', () => {
    const beliefDashedClassDeclarations = readBeliefClassDeclarations(
      'rah-map-node--belief-dashed'
    );
    expect(beliefDashedClassDeclarations).toMatch(/border-style\s*:\s*dashed\b/);
  });

  // Colour-source guard: no belief class may hard-code a hex — belief colour
  // comes only from the --rah-belief-* theme tokens, so theme switches and
  // token retunes reach every belief surface. The guard also demands at
  // least the full expected class count so it can never pass vacuously
  // (e.g. after a selector-scheme rename that strands this pattern).
  it('hard-codes no hex in any belief class rule', () => {
    // Every rule block whose selector mentions the belief class prefix.
    const beliefClassRuleBlocks = [
      ...mapStylesheetSource.matchAll(/\.rah-map-node--belief[^{}]*\{([^}]*)\}/g),
    ];
    // + 1 for the dashed class alongside the (hue, intensity) ring classes.
    expect(beliefClassRuleBlocks.length).toBeGreaterThanOrEqual(
      expectedBeliefRingClassPairs.length + 1
    );
    for (const beliefClassRuleBlock of beliefClassRuleBlocks) {
      expect(beliefClassRuleBlock[1]).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
