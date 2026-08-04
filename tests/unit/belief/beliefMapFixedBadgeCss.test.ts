/**
 * SLICE 5 of the belief map overlay — the stylesheet half of the
 * fixed-credence badge: a small circular marker worn by map nodes whose
 * credence a human asserted by hand (CLAUDE.md vocabulary: a "fixed
 * credence", nodes.belief_credence_is_fixed).
 *
 * The pinned contract for src/components/panes/map/map-styles.css:
 *  - a `.rah-map-node__belief-fixed-badge` class exists (element-style
 *    naming, like `.rah-map-node__title` / `__icon`, because the badge is a
 *    child element of the node, not a modifier of it),
 *  - it is CIRCULAR: a border-radius declaration is present,
 *  - it has a SMALL FIXED size: width and height in px, equal, and within a
 *    small-badge band (the FocusPanel `.node-processed-indicator` precedent
 *    is 16px; the band tolerates a smaller map-scale badge),
 *  - it is ABSOLUTELY POSITIONED, so it rides on the node instead of taking
 *    part in the node's flow layout,
 *  - its ANCHOR exists: `.rah-map-node` declares `position: relative`, else
 *    the absolute badge would anchor to the pane, not the node,
 *  - its colour comes from the --rah- theme tokens (var(--rah-…)) with NO
 *    hex literal anywhere in a fixed-badge rule — the slice-2 hex guard
 *    extended to this class, so theme switches reach the badge.
 *
 * SLICE 11 tightens the colour pin only. Slice 9's visual verification found
 * the badge drawn from `var(--rah-belief-for)` — the BELIEVED pole — so the
 * seeded demo graph's "discredited origin" source wore a correctly-disbelieved
 * fuchsia ring with a GREEN dot sitting on it, which reads as endorsement of
 * the very node the graph disbelieves. The badge's meaning is provenance ("a
 * human asserted this credence"), never polarity, so its hue must be the
 * neutral token and must encode no belief direction at all:
 *  - the badge colours from `var(--rah-belief-neutral)`, and
 *  - NO polarity token (`--rah-belief-for` / `--rah-belief-against`) appears
 *    in any fixed-badge rule, so neither pole can be reintroduced later.
 * Everything else about the rule is unchanged — circular, absolute, ~10px,
 * token-only, surface-coloured border ring, and any color-mix percentage.
 *
 * A CSS declaration's absence is invisible to the type system and this
 * harness runs node-env vitest with no jsdom, so the pin reads the
 * checked-in stylesheet source and asserts against its text — the same
 * source-text pinning as beliefMapRingClasses.test.ts.
 *
 * Red today (slice 11): the two colour pins — the stylesheet still draws the
 * badge from `var(--rah-belief-for)`. Green today, and expected to stay green:
 * the shape, size, position, anchor and hex-guard pins from slice 5.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// Absolute path of the checked-in map stylesheet, resolved from this test
// file so the read never depends on the process working directory.
const mapStylesheetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/components/panes/map/map-styles.css'
);

// The map stylesheet source, read once for every assertion in this file.
const mapStylesheetSource = fs.readFileSync(mapStylesheetPath, 'utf8');

// The one badge class this slice adds — the exact class the component half
// (beliefMapRahNodeFixedBadgeRendering.test.ts) pins RahNode to render.
const beliefFixedBadgeClassName = 'rah-map-node__belief-fixed-badge';

// The size band a "small fixed size" badge may declare, in px. The FocusPanel
// badge precedent is 16px; anything above 20px stops reading as a badge on a
// map node whose own min-width is 56px, and anything under 4px is invisible.
const beliefFixedBadgeMinPx = 4;
const beliefFixedBadgeMaxPx = 20;

// The one hue the badge may wear: the polarity-free token, already declared
// in both theme blocks (beliefThemeTokens.test.ts pins #9ca3af dark /
// #6b7280 light) and already used by the graded-neutral ring.
const beliefNeutralThemeToken = '--rah-belief-neutral';

// The two tokens that DO encode a belief direction. Either one in a badge
// rule turns a provenance mark into a verdict — the slice-9 finding.
const beliefPolarityThemeTokens = ['--rah-belief-for', '--rah-belief-against'];

// Matches a reference to either polarity token. The trailing boundary keeps
// a future longer token name (e.g. --rah-belief-forecast) from tripping the
// guard, while `--rah-belief-neutral` shares no prefix with either and so is
// never matched.
const beliefPolarityThemeTokenPattern = /--rah-belief-(?:for|against)\b/;

// Every rule block whose selector mentions the fixed-badge class, as body
// text. The badge's colour could be split across a base rule and a later
// override, so the polarity guard must read all of them, not just the first.
function readBeliefFixedBadgeRuleBodies(): string[] {
  return [
    ...mapStylesheetSource.matchAll(
      new RegExp(String.raw`\.${beliefFixedBadgeClassName}[^{}]*\{([^}]*)\}`, 'g')
    ),
  ].map((beliefFixedBadgeRuleMatch) => beliefFixedBadgeRuleMatch[1]);
}

// Extracts the body text of the first CSS rule for the given class, robust
// to whitespace between selector and brace. The map stylesheet contains only
// flat rules (no nested braces), so "everything up to the first closing
// brace" is the whole rule body. Throws a named error when the class is
// missing — a missing class is its own failure mode, distinct from a wrong
// declaration inside an existing class.
function readClassDeclarations(cssClassName: string): string {
  const classRuleMatch = mapStylesheetSource.match(
    new RegExp(String.raw`\.${cssClassName}\s*\{([^}]*)\}`)
  );
  if (!classRuleMatch) {
    throw new Error(`map-styles.css declares no .${cssClassName} class`);
  }
  return classRuleMatch[1];
}

// Parses the px number of a `width:`/`height:`-style declaration out of one
// rule body, or null when the property is missing or not in px — the two
// failure modes ("no width at all" and "width in %/em") both surface as null
// and fail the size pin with the property named in the message.
function readPxDeclaration(ruleDeclarations: string, propertyName: string): number | null {
  const pxDeclarationMatch = ruleDeclarations.match(
    new RegExp(String.raw`(?:^|;|\s)${propertyName}\s*:\s*([\d.]+)px\b`)
  );
  return pxDeclarationMatch ? Number(pxDeclarationMatch[1]) : null;
}

describe('the belief fixed-credence badge class in map-styles.css', () => {
  // The class must exist at all — the component half renders an element
  // wearing exactly this class, and a missing rule leaves it unstyled text.
  it(`declares .${beliefFixedBadgeClassName}`, () => {
    expect(
      readClassDeclarations(beliefFixedBadgeClassName),
      `map-styles.css must declare .${beliefFixedBadgeClassName}`
    ).toBeTruthy();
  });

  // CIRCULAR: a border-radius declaration is present (value unpinned — 50%
  // and the house 999px pill radius both render a circle at equal sides).
  it('gives the badge a border-radius (circular)', () => {
    expect(readClassDeclarations(beliefFixedBadgeClassName)).toMatch(
      /border-radius\s*:/
    );
  });

  // SMALL FIXED SIZE: width and height both declared in px, equal (a circle
  // needs equal sides), and inside the small-badge band.
  it(`gives the badge equal px width and height between ${beliefFixedBadgeMinPx} and ${beliefFixedBadgeMaxPx}px`, () => {
    const badgeDeclarations = readClassDeclarations(beliefFixedBadgeClassName);
    const badgeWidthPx = readPxDeclaration(badgeDeclarations, 'width');
    const badgeHeightPx = readPxDeclaration(badgeDeclarations, 'height');
    expect(badgeWidthPx, 'badge must declare width in px').not.toBeNull();
    expect(badgeHeightPx, 'badge must declare height in px').not.toBeNull();
    expect(badgeWidthPx, 'badge width and height must be equal (circle)').toBe(badgeHeightPx);
    expect(badgeWidthPx!).toBeGreaterThanOrEqual(beliefFixedBadgeMinPx);
    expect(badgeWidthPx!).toBeLessThanOrEqual(beliefFixedBadgeMaxPx);
  });

  // ABSOLUTELY POSITIONED: the badge rides on the node's corner, outside the
  // node's flow layout, so it never pushes the title or grows the node.
  it('positions the badge absolutely', () => {
    expect(readClassDeclarations(beliefFixedBadgeClassName)).toMatch(
      /position\s*:\s*absolute\b/
    );
  });

  // ANCHOR: an absolute badge anchors to its nearest positioned ancestor.
  // Without `position: relative` on `.rah-map-node`, the badge would anchor
  // to the pane and float away from its node.
  it('anchors the absolute badge by declaring position: relative on .rah-map-node', () => {
    expect(readClassDeclarations('rah-map-node')).toMatch(
      /position\s*:\s*relative\b/
    );
  });

  // THEME-TOKEN COLOUR, NARROWED IN SLICE 11: the badge's colour must come
  // from the --rah- theme tokens, never a literal — and specifically from the
  // NEUTRAL token. Slice 9's visual check caught the badge drawn from the
  // believed pole, which put a green dot on a deliberately disbelieved
  // "discredited origin" node: a disbelieved anchor must not wear a
  // believed-green mark. The badge says a human fixed this credence; it does
  // not say the credence is positive, so its hue is polarity-free.
  it(`colours the badge from var(${beliefNeutralThemeToken})`, () => {
    const badgeDeclarations = readClassDeclarations(beliefFixedBadgeClassName);
    expect(badgeDeclarations, 'badge colour must come from a theme token').toMatch(
      /var\(\s*--rah-/
    );
    expect(
      badgeDeclarations,
      `badge must colour from var(${beliefNeutralThemeToken}) — provenance, not polarity`
    ).toMatch(new RegExp(String.raw`var\(\s*${beliefNeutralThemeToken}\s*\)`));
  });

  // THE SAME PIN STATED POSITIVELY, and file-wide across the badge's rules:
  // no polarity token appears at all, so neither pole can be reintroduced
  // later by a follow-up rule or an override the pin above would not read.
  it('mentions no belief-polarity token in any fixed-badge rule', () => {
    const beliefFixedBadgeRuleBodies = readBeliefFixedBadgeRuleBodies();
    expect(
      beliefFixedBadgeRuleBodies.length,
      `at least one .${beliefFixedBadgeClassName} rule must exist for the polarity guard to bite`
    ).toBeGreaterThanOrEqual(1);
    for (const beliefFixedBadgeRuleBody of beliefFixedBadgeRuleBodies) {
      expect(
        beliefFixedBadgeRuleBody,
        `a fixed-badge rule names a polarity token (${beliefPolarityThemeTokens.join(' / ')}); the badge marks who set the credence, not which way it points`
      ).not.toMatch(beliefPolarityThemeTokenPattern);
    }
  });

  // HEX GUARD (the slice-2 guard extended to this class): no rule whose
  // selector mentions the fixed-badge class may hard-code a hex literal. The
  // count floor keeps the guard from passing vacuously if the class were
  // renamed out from under the pattern.
  it('hard-codes no hex in any fixed-badge rule', () => {
    // Every rule block whose selector mentions the fixed-badge class name.
    const beliefFixedBadgeRuleBlocks = [
      ...mapStylesheetSource.matchAll(
        new RegExp(String.raw`\.${beliefFixedBadgeClassName}[^{}]*\{([^}]*)\}`, 'g')
      ),
    ];
    expect(
      beliefFixedBadgeRuleBlocks.length,
      `at least one .${beliefFixedBadgeClassName} rule must exist for the hex guard to bite`
    ).toBeGreaterThanOrEqual(1);
    for (const beliefFixedBadgeRuleBlock of beliefFixedBadgeRuleBlocks) {
      expect(beliefFixedBadgeRuleBlock[1]).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
