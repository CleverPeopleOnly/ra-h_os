/**
 * The app stylesheet (app/globals.css) must declare three belief colour
 * tokens in BOTH theme token blocks — the dark block
 * (`:root, html[data-theme="dark"]`) and the light block
 * (`html[data-theme="light"]`) — so every belief-overlay surface reads its
 * colours from theme tokens instead of hard-coding hexes per component.
 *
 * The pinned hexes were validated with a palette validator against both app
 * surfaces as a CVD-safe diverging pair (green/magenta, distinguishable
 * under the common colour-vision deficiencies, unlike green/red):
 *
 *  - --rah-belief-for      #16a34a in both blocks — the believed pole,
 *    deliberately the app's light-mode accent green so "believed" reads as
 *    the app's own affirmative colour;
 *  - --rah-belief-against  #c026d3 in both blocks — the disbelieved pole,
 *    the magenta partner of the validated diverging pair;
 *  - --rah-belief-neutral  #9ca3af (dark block) / #6b7280 (light block) —
 *    the graded-neutral midpoint; the ONE per-theme token, because a single
 *    mid-grey cannot hold contrast against both a near-black and a white
 *    background.
 *
 * A CSS custom property's absence is invisible to the type system and this
 * harness runs node-env vitest with no jsdom, so the pin reads the checked-in
 * stylesheet source and asserts each token: value pair inside the RIGHT theme
 * block — the same source-text pinning used by
 * beliefMapRahNodeRingConsumption.test.ts.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// Absolute path of the checked-in app stylesheet, resolved from this test
// file so the read never depends on the process working directory.
const appGlobalsStylesheetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../app/globals.css'
);

// The stylesheet source, read once for every assertion in this file.
const appGlobalsStylesheetSource = fs.readFileSync(appGlobalsStylesheetPath, 'utf8');

// Extracts the body text of the first CSS rule whose selector matches
// themeBlockSelectorPattern, robust to whitespace between selector and brace.
// Returns the declarations between the braces, or fails the calling test with
// a named error if the block is missing — a missing theme block is its own
// failure mode, distinct from a missing token.
function readThemeBlockDeclarations(themeBlockSelectorPattern: RegExp, themeBlockName: string): string {
  const themeBlockMatch = appGlobalsStylesheetSource.match(
    // The token blocks contain only flat declarations (no nested braces), so
    // "everything up to the first closing brace" is the whole block body.
    new RegExp(themeBlockSelectorPattern.source + String.raw`\s*\{([^}]*)\}`)
  );
  if (!themeBlockMatch) {
    throw new Error(`app/globals.css has no ${themeBlockName} theme token block`);
  }
  return themeBlockMatch[1];
}

// Asserts that one belief token is declared with exactly the pinned hex
// inside the given theme block body, tolerant of whitespace around the colon
// and before the semicolon but strict on the token name and hex value.
function expectBeliefTokenDeclaration(
  themeBlockDeclarations: string,
  beliefTokenName: string,
  pinnedBeliefHex: string
): void {
  expect(themeBlockDeclarations).toMatch(
    new RegExp(String.raw`${beliefTokenName}\s*:\s*${pinnedBeliefHex}\s*;`)
  );
}

describe('belief colour tokens in app/globals.css theme blocks', () => {
  // The dark theme token block: `:root, html[data-theme="dark"]`. :root is
  // part of the selector because dark is the app's default theme.
  const darkThemeBlockDeclarations = readThemeBlockDeclarations(
    /:root\s*,\s*html\[data-theme="dark"\]/,
    'dark'
  );

  // The light theme token block: `html[data-theme="light"]`. The pattern
  // cannot collide with the dark block because its attribute value differs.
  const lightThemeBlockDeclarations = readThemeBlockDeclarations(
    /html\[data-theme="light"\]/,
    'light'
  );

  // Believed pole: the same green in both themes — it is the app's
  // light-mode accent (#16a34a), validated as CVD-safe against #c026d3.
  it('declares --rah-belief-for as #16a34a in the dark block', () => {
    expectBeliefTokenDeclaration(darkThemeBlockDeclarations, '--rah-belief-for', '#16a34a');
  });

  it('declares --rah-belief-for as #16a34a in the light block', () => {
    expectBeliefTokenDeclaration(lightThemeBlockDeclarations, '--rah-belief-for', '#16a34a');
  });

  // Disbelieved pole: the magenta half of the validated diverging pair, the
  // same in both themes so the pair keeps one identity across theme switches.
  it('declares --rah-belief-against as #c026d3 in the dark block', () => {
    expectBeliefTokenDeclaration(darkThemeBlockDeclarations, '--rah-belief-against', '#c026d3');
  });

  it('declares --rah-belief-against as #c026d3 in the light block', () => {
    expectBeliefTokenDeclaration(lightThemeBlockDeclarations, '--rah-belief-against', '#c026d3');
  });

  // Graded-neutral midpoint: the one per-theme token — a lighter grey on the
  // dark surface and a darker grey on the light surface, because no single
  // mid-grey holds contrast against both backgrounds.
  it('declares --rah-belief-neutral as #9ca3af in the dark block', () => {
    expectBeliefTokenDeclaration(darkThemeBlockDeclarations, '--rah-belief-neutral', '#9ca3af');
  });

  it('declares --rah-belief-neutral as #6b7280 in the light block', () => {
    expectBeliefTokenDeclaration(lightThemeBlockDeclarations, '--rah-belief-neutral', '#6b7280');
  });
});
