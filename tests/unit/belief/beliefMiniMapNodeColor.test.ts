/**
 * SLICE 7 of the belief map overlay — the red for the pure MiniMap tint
 * decision. Module under change: src/services/belief/beliefPresentation.ts,
 * which must gain the export
 *
 *   beliefMiniMapNodeColor(beliefPresentation: BeliefPresentation): string | null
 *
 * — from one finished presentation decision to the CSS colour string the
 * React Flow MiniMap paints that node with. Pure function only: no React,
 * no DOM, no database.
 *
 * The contract pinned here:
 *  - hue 'for'     -> EXACTLY the string `var(--rah-belief-for)`,
 *  - hue 'against' -> EXACTLY the string `var(--rah-belief-against)`,
 *  - hue 'neutral' -> EXACTLY the string `var(--rah-belief-neutral)`,
 *  - hue null (never assessed) -> NULL — belief must never repaint an
 *    unassessed node; the caller (MapPane's nodeColor callback, pinned by
 *    beliefMapPaneMiniMapBeliefTint.test.ts) falls back to the existing
 *    role colour on null,
 *  - the MiniMap tint is HUE-ONLY: intensity and ring style never enter it —
 *    a barely-leaning node and a strongly-committed node of the same hue get
 *    the same MiniMap colour string, and the null-style
 *    credence-without-masses row tints exactly like a solid one,
 *  - NO HEX: every emitted string is a `var(--rah-belief-…)` token reference
 *    (the three tokens shipped in slice 1, pinned by
 *    beliefThemeTokens.test.ts), never a hex literal — the MiniMap must
 *    follow the theme like every other belief surface,
 *  - token cross-pin: every custom-property name the function emits is
 *    declared in app/globals.css, so the function can never reference a
 *    token the stylesheet lacks.
 *
 * Import style: the presentation module exists but the MiniMap export does
 * not yet, so a static named import would fail `tsc --noEmit` (TS2305). The
 * module is imported as a namespace and cast to the pinned surface — the
 * namespace-cast red pattern of beliefMapNodeRingClassNames.test.ts — so
 * today every test in this file reds with a readable TypeError.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import * as beliefPresentationModule from '@/services/belief/beliefPresentation';
import { deriveBeliefPresentation } from '@/services/belief/beliefPresentation';
import type {
  BeliefPresentation,
  BeliefPresentationNodeFields,
} from '@/services/belief/beliefPresentation';

// The surface under test, typed locally because the export does not exist
// yet — that missing export is the red this file drives. The cast keeps
// `tsc --noEmit` clean; at runtime today the function is undefined and every
// call site reds with a readable TypeError.
const { beliefMiniMapNodeColor } = beliefPresentationModule as unknown as {
  // One presentation decision in; the MiniMap colour string out, or null for
  // a never-assessed node the caller must leave on its role colour.
  beliefMiniMapNodeColor: (beliefPresentation: BeliefPresentation) => string | null;
};

// Absolute path of the checked-in app stylesheet, resolved from this test
// file so the read never depends on the process working directory — the
// token cross-pin below reads it.
const appGlobalsStylesheetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../app/globals.css'
);

// The app stylesheet source, read once, for the token cross-pin.
const appGlobalsStylesheetSource = fs.readFileSync(appGlobalsStylesheetPath, 'utf8');

// W of belief model v2, restated by hand so the graded fixtures below cache
// a credence that is an independent calculation, not an import of the
// constant under test.
const HAND_CALCULATED_BELIEF_PRIOR_MASS = 2;

// Build a graded (engine-derived) node's four belief columns from its two
// masses, with the cached credence being the signed projection
// (r - s) / (r + s + W) — exactly what the v2 engine persists.
function gradedNodeBeliefFields(
  forMass: number,
  againstMass: number
): BeliefPresentationNodeFields {
  return {
    belief_credence:
      (forMass - againstMass) / (forMass + againstMass + HAND_CALCULATED_BELIEF_PRIOR_MASS),
    belief_credence_is_fixed: 0,
    belief_evidence_for_mass: forMass,
    belief_evidence_against_mass: againstMass,
  };
}

// A node nobody has ever assessed: credence NULL, masses NULL, flag 0 —
// derives to the all-null presentation, the no-tint case.
const NEVER_ASSESSED_NODE_BELIEF_FIELDS: BeliefPresentationNodeFields = {
  belief_credence: null,
  belief_credence_is_fixed: 0,
  belief_evidence_for_mass: null,
  belief_evidence_against_mass: null,
};

// The illegitimate credence-without-masses row: credence set, fixed flag 0,
// masses NULL — derives to a non-null hue with a NULL ring style. The
// MiniMap tint is hue-only, so this row must tint exactly like a solid one.
const CREDENCE_WITHOUT_MASSES_NODE_BELIEF_FIELDS: BeliefPresentationNodeFields = {
  belief_credence: 0.5,
  belief_credence_is_fixed: 0,
  belief_evidence_for_mass: null,
  belief_evidence_against_mass: null,
};

// Build one literal presentation decision for the defensive stowaway pin,
// where the ring fields are set directly. The uncorrelated fields (badge,
// uncertainty, accessible text) are filled with plausible constants the
// MiniMap tint function must ignore.
function beliefPresentationFixture(params: {
  beliefRingHue: BeliefPresentation['beliefRingHue'];
  beliefRingIntensityPercent: number | null;
  beliefRingStyle: 'solid' | 'dashed' | null;
}): BeliefPresentation {
  return {
    beliefRingHue: params.beliefRingHue,
    beliefRingIntensityPercent: params.beliefRingIntensityPercent,
    beliefRingStyle: params.beliefRingStyle,
    beliefFixedBadgeShown: false,
    beliefUncertainty: params.beliefRingStyle === 'dashed' ? 0.8 : null,
    beliefAccessibleText: 'fixture accessible text',
  };
}

describe('beliefMiniMapNodeColor maps each hue to its exact theme token string', () => {
  // Believed: r=6, s=2 -> credence +0.4, hue 'for'. The MiniMap paints the
  // believed pole's token — the exact string, no wrapper, no hex.
  it("returns exactly 'var(--rah-belief-for)' for a believed node", () => {
    const believedPresentation = deriveBeliefPresentation(gradedNodeBeliefFields(6, 2));
    // Premise of this case, so a fixture drift cannot silently retarget it.
    expect(believedPresentation.beliefRingHue).toBe('for');
    expect(beliefMiniMapNodeColor(believedPresentation)).toBe('var(--rah-belief-for)');
  });

  // Disbelieved: r=0, s=0.5 -> credence -0.2, hue 'against'. The magenta
  // partner of the validated diverging pair, via its token.
  it("returns exactly 'var(--rah-belief-against)' for a disbelieved node", () => {
    const disbelievedPresentation = deriveBeliefPresentation(gradedNodeBeliefFields(0, 0.5));
    // Premise of this case, as above.
    expect(disbelievedPresentation.beliefRingHue).toBe('against');
    expect(beliefMiniMapNodeColor(disbelievedPresentation)).toBe('var(--rah-belief-against)');
  });

  // Graded and balanced: r=3, s=3 -> credence exactly 0, hue 'neutral'. A
  // REAL assessment: it tints (with the neutral token), never null.
  it("returns exactly 'var(--rah-belief-neutral)' for a graded-neutral node", () => {
    const gradedNeutralPresentation = deriveBeliefPresentation(gradedNodeBeliefFields(3, 3));
    // Premise of this case, as above.
    expect(gradedNeutralPresentation.beliefRingHue).toBe('neutral');
    expect(beliefMiniMapNodeColor(gradedNeutralPresentation)).toBe('var(--rah-belief-neutral)');
  });
});

describe('beliefMiniMapNodeColor leaves a never-assessed node untinted', () => {
  // Never assessed: hue null -> NULL, not a colour. Belief must never
  // repaint an unassessed node — the caller keeps the role colour, and a
  // neutral tint here would fabricate an assessment nobody made.
  it('returns null for a never-assessed node', () => {
    const neverAssessedPresentation = deriveBeliefPresentation(NEVER_ASSESSED_NODE_BELIEF_FIELDS);
    expect(beliefMiniMapNodeColor(neverAssessedPresentation)).toBeNull();
  });

  // Defensive pin: hue null means NULL even if stowaway ring fields ride on
  // the presentation — the never-assessed decision is total, exactly as it
  // is for the ring class names.
  it('returns null for a null hue even with stowaway intensity and style fields', () => {
    const nullHueStowawayPresentation = beliefPresentationFixture({
      beliefRingHue: null,
      beliefRingIntensityPercent: 55,
      beliefRingStyle: 'dashed',
    });
    expect(beliefMiniMapNodeColor(nullHueStowawayPresentation)).toBeNull();
  });
});

describe('beliefMiniMapNodeColor tints by hue alone', () => {
  // HUE-ONLY: a barely-committed and a strongly-committed 'for' node — and
  // the null-style credence-without-masses row — all emit the IDENTICAL
  // string. Intensity bands and ring style belong to the map node's ring;
  // the MiniMap flattens them to the hue.
  it('emits one identical string across intensity bands and ring styles of one hue', () => {
    // Committed band: r=6, s=2 -> credence +0.4, solid.
    const committedForPresentation = deriveBeliefPresentation(gradedNodeBeliefFields(6, 2));
    // Strongly-committed band: r=20, s=0 -> credence ~+0.91, solid.
    const stronglyCommittedForPresentation = deriveBeliefPresentation(
      gradedNodeBeliefFields(20, 0)
    );
    // The null-style carry-forward row: hue 'for', ring style null.
    const nullStyleForPresentation = deriveBeliefPresentation(
      CREDENCE_WITHOUT_MASSES_NODE_BELIEF_FIELDS
    );
    // Premises of this case: same hue, different bands, one null style.
    expect(committedForPresentation.beliefRingHue).toBe('for');
    expect(stronglyCommittedForPresentation.beliefRingHue).toBe('for');
    expect(nullStyleForPresentation.beliefRingHue).toBe('for');
    expect(stronglyCommittedForPresentation.beliefRingIntensityPercent).not.toBe(
      committedForPresentation.beliefRingIntensityPercent
    );
    expect(nullStyleForPresentation.beliefRingStyle).toBeNull();

    // The tint decision collapses all three to the one 'for' string.
    const committedForColor = beliefMiniMapNodeColor(committedForPresentation);
    expect(beliefMiniMapNodeColor(stronglyCommittedForPresentation)).toBe(committedForColor);
    expect(beliefMiniMapNodeColor(nullStyleForPresentation)).toBe(committedForColor);
  });
});

describe('beliefMiniMapNodeColor emits only declared theme tokens, never hexes', () => {
  // THE TOKEN CROSS-PIN: run the function over one derived presentation per
  // hue, demand every emitted string is a single well-formed
  // var(--rah-belief-…) reference with no hex literal anywhere in it, and
  // demand the referenced custom property is DECLARED in app/globals.css —
  // the function can never reference a token the stylesheet lacks.
  it('emits var(--rah-belief-…) strings whose tokens app/globals.css declares', () => {
    // One derivable presentation per hue — the whole assessed input space of
    // the hue-only tint.
    const oneDerivedPresentationPerHue = [
      deriveBeliefPresentation(gradedNodeBeliefFields(6, 2)), // 'for'
      deriveBeliefPresentation(gradedNodeBeliefFields(0, 0.5)), // 'against'
      deriveBeliefPresentation(gradedNodeBeliefFields(3, 3)), // 'neutral'
    ];
    for (const derivedPresentation of oneDerivedPresentationPerHue) {
      const emittedMiniMapColor = beliefMiniMapNodeColor(derivedPresentation);
      // Assessed hue: the emitted string exists …
      expect(emittedMiniMapColor).not.toBeNull();
      // … is exactly one token reference of the pinned shape …
      expect(emittedMiniMapColor).toMatch(/^var\(--rah-belief-[a-z]+\)$/);
      // … carries no hex literal (no-hex, restated as its own guard) …
      expect(emittedMiniMapColor).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      // … and its custom property is declared in the app stylesheet. Token
      // names contain only letters and hyphens, so raw interpolation is
      // regex-safe.
      const emittedTokenName = (emittedMiniMapColor as string).slice(
        'var('.length,
        -')'.length
      );
      expect(
        appGlobalsStylesheetSource,
        `app/globals.css must declare ${emittedTokenName}`
      ).toMatch(new RegExp(String.raw`${emittedTokenName}\s*:`));
    }
  });
});
