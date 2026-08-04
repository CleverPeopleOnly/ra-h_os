/**
 * SLICE 5 of the belief map overlay — the component half of the
 * fixed-credence badge: the visual map node
 * (src/components/panes/map/RahNode.tsx) renders a small marker on nodes
 * whose credence a human asserted by hand (CLAUDE.md vocabulary: a "fixed
 * credence").
 *
 * This harness runs node-env vitest with no jsdom, so a component cannot be
 * rendered; the component's behaviour is pinned by reading its checked-in
 * source and asserting against the text — the same source-text pinning as
 * beliefMapRahNodeRingConsumption.test.ts, with regex tolerance for
 * formatting throughout.
 *
 * The contract pinned here:
 *  - RahNode renders exactly ONE element wearing the
 *    `rah-map-node__belief-fixed-badge` class (the class the stylesheet half,
 *    beliefMapFixedBadgeCss.test.ts, pins in map-styles.css),
 *  - that element carries a `title` attribute whose text contains the phrase
 *    "fixed credence" — the enforced vocabulary, so hovering the badge
 *    explains what it marks,
 *  - the badge sits INSIDE the node's root <div> (after the root's className
 *    composition, before the component's final closing tag),
 *  - the badge renders CONDITIONALLY on beliefFixedBadgeShown — `&&` or a
 *    true-branch ternary, un-negated, and never `cond ? null : badge` —
 *    and on THAT FIELD SPECIFICALLY: no ring field (hue, intensity, style,
 *    uncertainty) may stand in as a proxy anywhere in the condition. The
 *    badge and the ring are orthogonal: an ungraded node whose row smuggled
 *    in a stowaway hue must never grow a badge, and a fixed node shows its
 *    badge whatever its ring state,
 *  - FUNNEL RULE (restated from slice 4, GUARD pins green today): RahNode
 *    must NOT import deriveBeliefPresentation or the shared MCP mapper, and
 *    must not read any belief_ column off the row — the badge decision
 *    arrives finished on data.beliefPresentation, derived exactly once in
 *    toRFNodes (utils.ts).
 *
 * Red today: the badge-element, title, placement, and conditional pins (the
 * component has no badge code yet). Green today, flagged as GUARD: the
 * no-ring-field-reads pin and the three funnel-rule pins — they exist to
 * stay green.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// Absolute path of the checked-in visual map node component, resolved from
// this test file so the read never depends on the process working directory.
const rahNodeComponentPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/components/panes/map/RahNode.tsx'
);

// The component source, read once for every assertion in this file.
const rahNodeComponentSource = fs.readFileSync(rahNodeComponentPath, 'utf8');

// The badge class the component must render — the exact class the
// stylesheet half pins in map-styles.css.
const beliefFixedBadgeClassName = 'rah-map-node__belief-fixed-badge';

// How far (in source characters) the beliefFixedBadgeShown reference may sit
// before the badge class it guards. Bounds the condition-segment search so a
// stray beliefFixedBadgeShown mention elsewhere in the file can never
// vouch for an unconditional badge rendered much later.
const beliefFixedBadgeConditionMaxDistance = 500;

// Index of the badge class in the component source. Throws a named error
// when the component renders no badge at all — the primary red of this
// slice, surfaced identically by every pin that needs the badge's position.
function beliefFixedBadgeClassIndex(): number {
  const badgeClassIndex = rahNodeComponentSource.indexOf(beliefFixedBadgeClassName);
  if (badgeClassIndex === -1) {
    throw new Error(`RahNode.tsx renders no element with the ${beliefFixedBadgeClassName} class`);
  }
  return badgeClassIndex;
}

// The opening tag of the element wearing the badge class: from its `<` to
// its first `>`. `[^<>]*` spans newlines, so attribute order and multi-line
// formatting are both tolerated; a badge element's opening tag contains no
// nested angle brackets. Throws when the class exists only outside a tag.
function readBeliefFixedBadgeOpeningTag(): string {
  const badgeOpeningTagMatch = rahNodeComponentSource.match(
    new RegExp(String.raw`<[a-zA-Z][^<>]*${beliefFixedBadgeClassName}[^<>]*>`)
  );
  if (!badgeOpeningTagMatch) {
    throw new Error(
      `RahNode.tsx has no JSX opening tag carrying the ${beliefFixedBadgeClassName} class`
    );
  }
  return badgeOpeningTagMatch[0];
}

// The source text between the LAST beliefFixedBadgeShown reference before
// the badge class and the badge class itself — the rendering condition and
// whatever sits between it and the element it guards. Throws (the
// missing-conditional red) when no reference precedes the badge within the
// distance bound.
function readBeliefFixedBadgeConditionSegment(): string {
  const badgeClassIndex = beliefFixedBadgeClassIndex();
  const conditionReferenceIndex = rahNodeComponentSource.lastIndexOf(
    'beliefFixedBadgeShown',
    badgeClassIndex
  );
  if (
    conditionReferenceIndex === -1 ||
    badgeClassIndex - conditionReferenceIndex > beliefFixedBadgeConditionMaxDistance
  ) {
    throw new Error(
      'no beliefFixedBadgeShown reference guards the badge element (none precedes it within range)'
    );
  }
  return rahNodeComponentSource.slice(conditionReferenceIndex, badgeClassIndex);
}

describe('RahNode.tsx renders the fixed-credence badge element', () => {
  // The badge element exists and wears the stylesheet's class — without it
  // a fixed credence is visually indistinguishable from a derived one.
  it(`renders an element with the ${beliefFixedBadgeClassName} class`, () => {
    expect(beliefFixedBadgeClassIndex()).toBeGreaterThanOrEqual(0);
  });

  // Exactly ONE badge site: a second occurrence would be a second,
  // possibly-unconditional badge the conditional pins below cannot see.
  it('renders the badge class at exactly one site', () => {
    const badgeClassOccurrences = rahNodeComponentSource.split(beliefFixedBadgeClassName).length - 1;
    expect(
      badgeClassOccurrences,
      `${beliefFixedBadgeClassName} must appear exactly once in RahNode.tsx`
    ).toBe(1);
  });

  // The hover explanation, in the enforced vocabulary: the badge's opening
  // tag carries a title attribute whose text says "fixed credence". String
  // or JSX-expression title values are both accepted.
  it('gives the badge a title attribute containing "fixed credence"', () => {
    const badgeOpeningTag = readBeliefFixedBadgeOpeningTag();
    expect(badgeOpeningTag, 'badge must carry a title attribute').toMatch(/\btitle\s*=/);
    expect(badgeOpeningTag, 'badge title must speak the vocabulary').toMatch(
      /\btitle\s*=\s*(?:"[^"]*[Ff]ixed credence[^"]*"|'[^']*[Ff]ixed credence[^']*'|\{[^}]*[Ff]ixed credence[^}]*\})/
    );
  });

  // PLACEMENT: the badge sits inside the node's ROOT div — after the root's
  // className composition (the file's first `className={`, pinned as the
  // root by beliefMapRahNodeRingConsumption.test.ts) and before the
  // component's last closing </div> (the root's own close).
  it('places the badge inside the node root div', () => {
    const badgeClassIndex = beliefFixedBadgeClassIndex();
    const rootClassNameIndex = rahNodeComponentSource.indexOf('className={');
    const rootClosingDivIndex = rahNodeComponentSource.lastIndexOf('</div>');
    expect(rootClassNameIndex, 'RahNode.tsx must keep its root className={ composition').toBeGreaterThanOrEqual(0);
    expect(badgeClassIndex, 'badge must come after the root div opens').toBeGreaterThan(rootClassNameIndex);
    expect(badgeClassIndex, 'badge must come before the root div closes').toBeLessThan(rootClosingDivIndex);
  });
});

describe('RahNode.tsx renders the badge conditionally on beliefFixedBadgeShown', () => {
  // The badge is guarded by the presentation's beliefFixedBadgeShown field:
  // a reference to it precedes the badge element, joined by `&&` or a
  // ternary's `?` (the `(?!\.)` keeps optional chaining's `?.` from
  // impersonating a ternary).
  it('guards the badge with beliefFixedBadgeShown via && or a ternary', () => {
    const conditionSegment = readBeliefFixedBadgeConditionSegment();
    expect(
      /&&|\?(?!\.)/.test(conditionSegment),
      'the beliefFixedBadgeShown reference must connect to the badge by && or ?'
    ).toBe(true);
  });

  // The guard must be the field itself, not its negation: `!…shown && badge`
  // would invert the contract. The regex walks back over any property chain
  // (data.beliefPresentation., optional chaining included) to catch a `!` in
  // front of the whole read.
  it('does not negate the beliefFixedBadgeShown guard', () => {
    const badgeClassIndex = beliefFixedBadgeClassIndex();
    const conditionReferenceIndex = rahNodeComponentSource.lastIndexOf(
      'beliefFixedBadgeShown',
      badgeClassIndex
    );
    // Up to 80 chars before the reference — enough for any property chain.
    const textBeforeConditionReference = rahNodeComponentSource.slice(
      Math.max(0, conditionReferenceIndex - 80),
      conditionReferenceIndex
    );
    expect(
      /!\s*(?:[\w$]+\s*\??\.\s*)*$/.test(textBeforeConditionReference),
      'the beliefFixedBadgeShown guard must not be negated'
    ).toBe(false);
  });

  // A ternary is accepted only with the badge in its TRUE branch:
  // `shown ? null : badge` renders the badge for the un-fixed node, so a
  // `? null` between the guard and the badge is banned.
  it('keeps the badge in the true branch of any ternary', () => {
    expect(readBeliefFixedBadgeConditionSegment()).not.toMatch(/\?\s*null\b/);
  });

  // ORTHOGONALITY, in the condition: no ring field may ride along in the
  // guard — `shown && hue && badge` would hide a fixed node's badge whenever
  // its ring is off, coupling two independent facts.
  it('mentions no ring field between the guard and the badge', () => {
    expect(readBeliefFixedBadgeConditionSegment()).not.toMatch(
      /beliefRingHue|beliefRingIntensityPercent|beliefRingStyle|beliefUncertainty/
    );
  });

  // ORTHOGONALITY, file-wide (GUARD, green today): RahNode's only belief
  // reads are the class-name helper call and beliefFixedBadgeShown — it
  // never touches a raw ring field anywhere, so no proxy condition (a
  // stowaway hue standing in for "fixed") can ever be written.
  it('reads no belief ring field anywhere in the component (guard)', () => {
    expect(rahNodeComponentSource).not.toMatch(
      /beliefRingHue|beliefRingIntensityPercent|beliefRingStyle|beliefUncertainty/
    );
  });
});

describe('RahNode.tsx honours the derivation funnel (guard pins, green today)', () => {
  // GUARD: the component consumes the FINISHED decision only. Importing the
  // derivation function here would create a second derivation site that can
  // drift from toRFNodes' — a badge disagreeing with the ring beside it.
  it('does not import deriveBeliefPresentation', () => {
    expect(rahNodeComponentSource).not.toMatch(/\bderiveBeliefPresentation\b/);
  });

  // GUARD: nor may it reach past the presentation to the shared MCP mapper —
  // the mapper feeds the derivation module, not components.
  it('does not import the shared belief MCP mapper', () => {
    expect(rahNodeComponentSource).not.toMatch(/beliefMcpToolContract/);
  });

  // GUARD: no direct belief column reads (belief_credence_is_fixed above
  // all, for this slice) — the raw columns stop at toRFNodes, and a badge
  // keyed off the raw flag would bypass the one derivation site.
  it('reads no belief_ column directly', () => {
    expect(rahNodeComponentSource).not.toMatch(/\bbelief_[a-z]/);
  });
});
