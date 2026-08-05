/**
 * MAP HEADER BADGE BORDERS — the view-mode badge in the map pane header must
 * not mix a border shorthand with a border longhand across its two style
 * objects.
 *
 * THE DEFECT, reproduced in the browser. Leaving focused mode logs:
 *
 *   "Removing a style property during rerender (borderColor) when a
 *    conflicting property is set (border) can lead to styling bugs. To avoid
 *    this, don't mix shorthand and non-shorthand properties for the same
 *    value."
 *
 * The cause is in src/components/panes/MapPane.tsx. One <span> in the pane
 * header swaps its whole style object as the view mode changes:
 *
 *   style={viewMode === 'focused' ? focusedBadge : overviewBadge}
 *
 * `overviewBadge` declares the SHORTHAND `border: '1px solid …'`.
 * `focusedBadge` spreads `...overviewBadge` and adds the LONGHAND
 * `borderColor: '…'`. Swapping from focused back to overview therefore hands
 * React a style object from which `borderColor` has been REMOVED while the
 * `border` shorthand is still set — precisely the mix the warning names.
 *
 * THE PINNED CONTRACT: both badge style objects express their border with
 * LONGHANDS ONLY (borderColor / borderWidth / borderStyle, no `border`), and
 * both end up carrying the SAME SET of border property names, so swapping
 * between them in either direction removes no border property at all.
 *
 * Both style objects are module-private consts — not exported, and this
 * harness runs node-env vitest with no jsdom, so there is nothing to import
 * and render. The pin therefore reads the checked-in component source and
 * asserts against its text, the same source-text pinning used by
 * tests/unit/map/mapNodeLabelSize.test.ts and
 * tests/unit/belief/beliefMapFixedBadgeCss.test.ts.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// Absolute path of the checked-in map pane component, resolved from this test
// file so the read never depends on the process working directory.
const mapPaneComponentPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/components/panes/MapPane.tsx'
);

// The map pane component source, read once for every assertion in this file.
const mapPaneComponentSource = fs.readFileSync(mapPaneComponentPath, 'utf8');

// The two style objects this pin owns: the badge worn in overview mode and
// the badge worn in focused mode.
const overviewBadgeStyleName = 'overviewBadge';
const focusedBadgeStyleName = 'focusedBadge';

// The border longhands that together replace the `border` shorthand. Stating
// all three keeps the rendered ring identical to the shorthand it replaces.
const requiredBorderLonghandNames = ['borderColor', 'borderWidth', 'borderStyle'];

// The one property name that must never appear: the shorthand whose presence
// alongside a removed longhand is what React warns about.
const forbiddenBorderShorthandName = 'border';

/**
 * Extracts the body text of a module-level `const <name> … = { … }` object
 * literal. Both badge objects are flat (no nested braces), so "everything up
 * to the first closing brace" is the whole literal. The optional type
 * annotation is tolerated so a change from `: CSSProperties` to an inferred
 * or aliased type does not silently stop the pin from matching. Throws a
 * named error when the const is missing, because a renamed or deleted style
 * object is a different failure from a wrong declaration inside one.
 */
function readStyleObjectDeclarations(styleObjectName: string): string {
  const styleObjectMatch = mapPaneComponentSource.match(
    new RegExp(String.raw`const\s+${styleObjectName}\s*(?::[^=]*)?=\s*\{([^}]*)\}`)
  );
  if (!styleObjectMatch) {
    throw new Error(`MapPane.tsx declares no const ${styleObjectName} object literal`);
  }
  return styleObjectMatch[1];
}

/**
 * Lists the property NAMES declared directly in one object-literal body, in
 * source order. Matching on the name-then-colon shape and requiring the name
 * to start at the literal's opening brace, a comma, or whitespace is what
 * makes the names exact rather than substrings: `borderRadius: 999` yields
 * the name "borderRadius", never "border", so the shorthand guard below
 * cannot be tripped by borderRadius / borderColor / borderWidth. The helper
 * self-check test proves this rather than leaving it as a claim.
 */
function listDeclaredPropertyNames(styleObjectDeclarations: string): string[] {
  return [
    ...styleObjectDeclarations.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:/g),
  ].map((declaredPropertyMatch) => declaredPropertyMatch[1]);
}

/**
 * Narrows a list of property names to the border-related ones: the `border`
 * shorthand itself plus every `border…` longhand. This is the set React
 * compares between rerenders, so it is the set the invariant test below
 * reasons about.
 */
function listBorderPropertyNames(declaredPropertyNames: string[]): string[] {
  return declaredPropertyNames.filter((declaredPropertyName) =>
    /^border($|[A-Z])/.test(declaredPropertyName)
  );
}

/**
 * True when the given object-literal body spreads the named object, e.g.
 * `...overviewBadge`. The focused badge inherits its width and style through
 * such a spread, so the spread's continued presence is itself part of the
 * contract — without it the two objects can drift apart silently.
 */
function spreadsStyleObject(styleObjectDeclarations: string, spreadStyleObjectName: string): boolean {
  return new RegExp(String.raw`\.\.\.\s*${spreadStyleObjectName}\b`).test(styleObjectDeclarations);
}

/**
 * The border property names a style object EFFECTIVELY carries at render
 * time: those it declares itself plus, when it spreads the overview badge,
 * those the overview badge declares. React sees the effective set, not the
 * source text, so the removal invariant must be stated over this.
 */
function listEffectiveBorderPropertyNames(styleObjectName: string): string[] {
  const styleObjectDeclarations = readStyleObjectDeclarations(styleObjectName);
  const ownBorderPropertyNames = listBorderPropertyNames(
    listDeclaredPropertyNames(styleObjectDeclarations)
  );
  const spreadBorderPropertyNames =
    styleObjectName !== overviewBadgeStyleName &&
    spreadsStyleObject(styleObjectDeclarations, overviewBadgeStyleName)
      ? listBorderPropertyNames(
          listDeclaredPropertyNames(readStyleObjectDeclarations(overviewBadgeStyleName))
        )
      : [];
  return [...new Set([...spreadBorderPropertyNames, ...ownBorderPropertyNames])];
}

describe('map header badge border styles in MapPane.tsx', () => {
  // HELPER SELF-CHECK, and the proof of the word-boundary claim above: on a
  // body that declares only borderRadius / borderColor / borderWidth, the
  // extracted names must be exactly those three, with no bare "border"
  // among them. Without this, the shorthand guard could pass or fail for the
  // wrong reason and nobody would know.
  it('extracts exact property names, so borderRadius and friends never read as the border shorthand', () => {
    const borderLonghandOnlyFixture = " borderRadius: 999,\n  borderColor: 'x',\n  borderWidth: 1,\n";
    const extractedPropertyNames = listDeclaredPropertyNames(borderLonghandOnlyFixture);
    expect(extractedPropertyNames).toEqual(['borderRadius', 'borderColor', 'borderWidth']);
    expect(
      extractedPropertyNames,
      'a name-exact extractor must not report the border shorthand for borderRadius/borderColor/borderWidth'
    ).not.toContain(forbiddenBorderShorthandName);
  });

  // THE PIN, half one: the overview badge declares NO `border` shorthand. The
  // shorthand is the "conflicting property is set (border)" half of the React
  // warning; with it gone there is nothing for a removed longhand to conflict
  // with.
  it(`declares no ${forbiddenBorderShorthandName} shorthand on ${overviewBadgeStyleName}`, () => {
    const overviewBadgePropertyNames = listDeclaredPropertyNames(
      readStyleObjectDeclarations(overviewBadgeStyleName)
    );
    expect(
      overviewBadgePropertyNames,
      `${overviewBadgeStyleName} must express its ring in longhands; the ${forbiddenBorderShorthandName} shorthand conflicts with the borderColor ${focusedBadgeStyleName} adds`
    ).not.toContain(forbiddenBorderShorthandName);
  });

  // THE PIN, half two: the ring the shorthand used to draw is spelled out as
  // three longhands, so the badge still renders a 1px solid ring in the
  // border-strong colour rather than losing its outline.
  it(`declares ${requiredBorderLonghandNames.join(', ')} on ${overviewBadgeStyleName}`, () => {
    const overviewBadgePropertyNames = listDeclaredPropertyNames(
      readStyleObjectDeclarations(overviewBadgeStyleName)
    );
    for (const requiredBorderLonghandName of requiredBorderLonghandNames) {
      expect(
        overviewBadgePropertyNames,
        `${overviewBadgeStyleName} must declare ${requiredBorderLonghandName} so the ring survives dropping the shorthand`
      ).toContain(requiredBorderLonghandName);
    }
  });

  // THE PIN, half three: the focused badge declares its own borderColor (that
  // is the only thing it changes about the ring), still inherits width and
  // style through the spread — pinned so the two objects cannot drift apart —
  // and carries no `border` shorthand, neither of its own nor via the spread.
  it(`keeps ${focusedBadgeStyleName} spreading ${overviewBadgeStyleName}, with borderColor and no shorthand`, () => {
    const focusedBadgeDeclarations = readStyleObjectDeclarations(focusedBadgeStyleName);
    const focusedBadgePropertyNames = listDeclaredPropertyNames(focusedBadgeDeclarations);
    expect(
      spreadsStyleObject(focusedBadgeDeclarations, overviewBadgeStyleName),
      `${focusedBadgeStyleName} must keep spreading ${overviewBadgeStyleName}, else the two badges drift apart`
    ).toBe(true);
    expect(
      focusedBadgePropertyNames,
      `${focusedBadgeStyleName} must declare its own borderColor — the one border property it overrides`
    ).toContain('borderColor');
    expect(
      focusedBadgePropertyNames,
      `${focusedBadgeStyleName} must declare no ${forbiddenBorderShorthandName} shorthand`
    ).not.toContain(forbiddenBorderShorthandName);
    expect(
      listEffectiveBorderPropertyNames(focusedBadgeStyleName),
      `${focusedBadgeStyleName} must inherit no ${forbiddenBorderShorthandName} shorthand through the spread either`
    ).not.toContain(forbiddenBorderShorthandName);
  });

  // THE INVARIANT, and the actual React rule behind the warning: swapping one
  // element's style object must never REMOVE a border property. React diffs
  // the two objects and clears whatever the incoming one omits; when the
  // omitted property is a longhand and a conflicting shorthand remains set,
  // it warns and the result is order-dependent. Stating it as supersets in
  // BOTH directions — focused's effective border names cover overview's, and
  // overview's cover focused's — is the same as requiring identical sets, and
  // it is what makes each swap safe:
  //  - overview → focused removes nothing (the spread guarantees this half),
  //  - focused → overview removes nothing (this is the half that fired the
  //    warning today, because focused adds borderColor on top of border).
  it('removes no border property when the element swaps between the two badges', () => {
    const overviewBadgeBorderPropertyNames = listEffectiveBorderPropertyNames(overviewBadgeStyleName);
    const focusedBadgeBorderPropertyNames = listEffectiveBorderPropertyNames(focusedBadgeStyleName);
    expect(
      overviewBadgeBorderPropertyNames.length,
      'the overview badge must declare at least one border property for this invariant to mean anything'
    ).toBeGreaterThan(0);
    for (const overviewBadgeBorderPropertyName of overviewBadgeBorderPropertyNames) {
      expect(
        focusedBadgeBorderPropertyNames,
        `entering focused mode would remove ${overviewBadgeBorderPropertyName}`
      ).toContain(overviewBadgeBorderPropertyName);
    }
    for (const focusedBadgeBorderPropertyName of focusedBadgeBorderPropertyNames) {
      expect(
        overviewBadgeBorderPropertyNames,
        `leaving focused mode would remove ${focusedBadgeBorderPropertyName} — the exact shape React warns about`
      ).toContain(focusedBadgeBorderPropertyName);
    }
  });

  // PREMISE GUARD: everything above matters only because ONE element swaps
  // between the two objects on a single style attribute. If a future edit
  // splits the badges onto different elements, React never diffs one against
  // the other, the shared-element premise dies, and this whole file should be
  // revisited rather than quietly kept passing.
  it('still renders both badges through one style attribute on one element', () => {
    expect(
      mapPaneComponentSource,
      `MapPane.tsx must still choose between ${focusedBadgeStyleName} and ${overviewBadgeStyleName} in one style attribute; if that changed, revisit this file`
    ).toMatch(
      new RegExp(
        String.raw`style=\{[^}]*\?\s*${focusedBadgeStyleName}\s*:\s*${overviewBadgeStyleName}\s*\}`
      )
    );
  });
});
