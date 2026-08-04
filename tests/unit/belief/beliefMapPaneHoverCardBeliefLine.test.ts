/**
 * SLICE 6 of the belief map overlay — the map's node hover preview card
 * (src/components/panes/MapPane.tsx, NOT under map/: the card sits in the
 * pane itself) gains a belief line: the presentation module's
 * beliefAccessibleText ("credence -0.60, uncertainty 0.20" / "belief not
 * assessed" / "…, fixed by hand") rendered as one line of the card.
 *
 * This harness runs node-env vitest with no jsdom, so the pane cannot be
 * rendered; the behaviour is pinned by reading the checked-in source and
 * asserting against the text — the same source-text pinning as
 * beliefMapRahNodeRingConsumption.test.ts and
 * beliefMapRahNodeFixedBadgeRendering.test.ts, with regex tolerance for
 * formatting throughout.
 *
 * WHAT THE HOVER MECHANISM IS TODAY (read before implementing): MapPane
 * stores only `hoveredNodeId: number | null` (set in onNodeMouseEnter from
 * the React Flow node's id) and looks the raw DbNode up in nodesById to
 * render the card's title/description. The FINISHED belief presentation for
 * every visible node already exists in MapPane's own state: toRFNodes
 * (map/utils.ts) derives it exactly once and threads it in as
 * RahNodeData.beliefPresentation on each rfNodes entry — and the
 * onNodeMouseEnter handler is even handed the full RFNode<RahNodeData>.
 *
 * THE DATA-FLOW CONTRACT PINNED HERE (the minimal honest extension): the
 * card's belief line must read beliefAccessibleText off a beliefPresentation
 * — the decision toRFNodes already derived — whether MapPane reaches it by
 * looking the hovered id up in rfNodes, or by widening the hover state to
 * carry the hovered node's RahNodeData / beliefPresentation from the
 * mouse-enter handler. Both routes are accepted; what is pinned is that the
 * words `beliefPresentation` and `beliefAccessibleText` name the flow, and
 * that NO re-derivation happens in the pane (funnel guards below). A route
 * that hid the flow behind a helper exported from utils.ts would fail the
 * beliefPresentation-reference pin — flagged for the Reviewer as a deliberate
 * narrowing.
 *
 * The contract pinned here:
 *  - the hover card region (anchored on its `style={hoverPreviewCard}`
 *    attribute) renders beliefAccessibleText as a JSX interpolation,
 *  - the line's element wears the `rah-map-hover-belief-line` class (the
 *    hook slice 9's visual verification targets), at exactly one site,
 *  - the accessible text is that element's TEXT CONTENT (between its opening
 *    tag and its closing tag),
 *  - the render is NOT gated on hue/credence being present — "belief not
 *    assessed" IS the correct display for an ungraded node, so no ring field
 *    may appear in the card region, no `? null` branch may hide the line,
 *    and MapPane must never compare against the 'belief not assessed'
 *    sentinel to special-case it away,
 *  - styling stays on theme tokens: no hex colour literal in the line's
 *    opening tag or in any belief-named style const,
 *  - FUNNEL RULE (restated from slices 4-5, GUARD pins green today): MapPane
 *    must NOT import deriveBeliefPresentation or the shared MCP mapper, and
 *    must not read any belief_ column anywhere in the file (pinned file-wide,
 *    stricter than the card region alone, because the raw columns stop at
 *    toRFNodes — the pane has no legitimate reader of them).
 *
 * Red today (8): the beliefAccessibleText-in-region, interpolation,
 * beliefPresentation-reference, class-in-region, class-exactly-once,
 * text-content, no-hex-in-opening-tag, and outside-description-conditional
 * pins (the card has no belief code yet — the last two go red via the
 * missing-element throw). Green today, flagged ANCHOR or GUARD (7): the
 * hover-card anchor, the belief-named-style-const hex guard, the two
 * unconditional-render region guards, the sentinel-comparison guard, and the
 * three funnel-rule pins — they exist to stay green.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// Absolute path of the checked-in map pane component, resolved from this
// test file so the read never depends on the process working directory.
const mapPaneComponentPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/components/panes/MapPane.tsx'
);

// The pane source, read once for every assertion in this file.
const mapPaneComponentSource = fs.readFileSync(mapPaneComponentPath, 'utf8');

// The class the belief line's element must wear — the stable hook slice 9's
// visual verification (and any stylesheet rule) targets. House style: the
// rah-map- block, the hover surface, the belief line.
const beliefHoverLineClassName = 'rah-map-hover-belief-line';

// The hover card's anchor: its root div carries style={hoverPreviewCard}
// (a spread like style={{ ...hoverPreviewCard, … }} is tolerated). Anchoring
// on the style const's USE keeps the region pins working even if the hover
// STATE variables are renamed by the data-flow extension.
const hoverCardStyleAnchorPattern = /style=\{\{?[^}]*\bhoverPreviewCard\b/;

// How much source (in characters) after the card's anchor counts as the
// hover-card region. The card's whole JSX block is ~330 characters today;
// 1000 leaves room for the belief line and stays well short of unrelated
// JSX (everything after the card is closing tags and style consts).
const beliefHoverCardRegionLength = 1000;

// The hover-card region: the source from the card's style anchor forward.
// Throws a named error when the card lost its anchor — every region pin
// surfaces that one failure mode identically.
function readBeliefHoverCardRegion(): string {
  const cardAnchorMatch = mapPaneComponentSource.match(hoverCardStyleAnchorPattern);
  if (!cardAnchorMatch || cardAnchorMatch.index === undefined) {
    throw new Error(
      'MapPane.tsx has no hover card anchored on style={hoverPreviewCard} — the region pins have nothing to bound'
    );
  }
  return mapPaneComponentSource.slice(
    cardAnchorMatch.index,
    cardAnchorMatch.index + beliefHoverCardRegionLength
  );
}

// The opening tag of the element wearing the belief-line class: from its `<`
// to its first `>`. `[^<>]*` spans newlines, so attribute order and
// multi-line formatting are both tolerated; the belief line's opening tag
// contains no nested angle brackets (it needs no event handlers whose arrows
// would smuggle a `>` in). Throws when no tag carries the class — the
// primary red of this slice.
function readBeliefHoverLineOpeningTag(): RegExpMatchArray {
  const beliefLineOpeningTagMatch = mapPaneComponentSource.match(
    new RegExp(String.raw`<[a-zA-Z][^<>]*${beliefHoverLineClassName}[^<>]*>`)
  );
  if (!beliefLineOpeningTagMatch || beliefLineOpeningTagMatch.index === undefined) {
    throw new Error(
      `MapPane.tsx has no JSX opening tag carrying the ${beliefHoverLineClassName} class`
    );
  }
  return beliefLineOpeningTagMatch;
}

describe('MapPane.tsx keeps the hover preview card this slice extends (anchor, green today)', () => {
  // ANCHOR: the card's root div is styled by the hoverPreviewCard const.
  // Every region pin below bounds itself on this anchor, so its survival is
  // pinned explicitly with a readable failure of its own.
  it('renders a hover card anchored on style={hoverPreviewCard}', () => {
    expect(
      hoverCardStyleAnchorPattern.test(mapPaneComponentSource),
      'the hover preview card must keep its style={hoverPreviewCard} anchor'
    ).toBe(true);
  });
});

describe('MapPane.tsx renders the belief line in the hover card', () => {
  // The card speaks the presentation module's accessible text — without it
  // the hovered node's belief state is invisible in the preview.
  it('references beliefAccessibleText inside the hover-card region', () => {
    expect(
      readBeliefHoverCardRegion(),
      'the hover card must reference beliefAccessibleText'
    ).toContain('beliefAccessibleText');
  });

  // The text is RENDERED, not merely mentioned: a JSX interpolation
  // ({presentation.beliefAccessibleText}, {beliefAccessibleText},
  // {hovered?.beliefAccessibleText ?? …} — any braced expression) sits in
  // the card region.
  it('renders beliefAccessibleText as a JSX interpolation in the card', () => {
    expect(readBeliefHoverCardRegion()).toMatch(
      /\{[^{}]*beliefAccessibleText[^{}]*\}/
    );
  });
});

describe('MapPane.tsx sources the line from the already-derived presentation', () => {
  // THE DATA-FLOW PIN (see the header): the accessible text must come off a
  // beliefPresentation — the decision toRFNodes derived once onto
  // RahNodeData — so the word beliefPresentation must appear in the pane
  // (an rfNodes lookup, a widened hover state, or a destructure of the
  // hovered node's data all satisfy it; re-derivation cannot, because the
  // funnel guards below ban the derivation imports).
  it('references beliefPresentation (the RahNodeData field toRFNodes filled)', () => {
    expect(
      mapPaneComponentSource,
      'MapPane.tsx must read the hovered node belief text off a beliefPresentation'
    ).toContain('beliefPresentation');
  });
});

describe('MapPane.tsx gives the belief line a distinguishable element', () => {
  // The class slice 9's visual verification targets — without it the line
  // is unaddressable among the card's other divs.
  it(`renders an element with the ${beliefHoverLineClassName} class inside the card region`, () => {
    expect(
      readBeliefHoverCardRegion(),
      `the belief line must wear the ${beliefHoverLineClassName} class inside the hover card`
    ).toContain(beliefHoverLineClassName);
  });

  // Exactly ONE line site file-wide: a second occurrence would be a second
  // belief line the region and content pins cannot see.
  it('renders the belief-line class at exactly one site', () => {
    const beliefLineClassOccurrences =
      mapPaneComponentSource.split(beliefHoverLineClassName).length - 1;
    expect(
      beliefLineClassOccurrences,
      `${beliefHoverLineClassName} must appear exactly once in MapPane.tsx`
    ).toBe(1);
  });

  // The accessible text is that element's TEXT CONTENT: beliefAccessibleText
  // appears between the class-bearing opening tag and the first closing tag
  // after it. This is what makes the class a handle on the LINE rather than
  // on some unrelated wrapper.
  it('puts beliefAccessibleText inside the belief-line element as its text content', () => {
    const beliefLineOpeningTag = readBeliefHoverLineOpeningTag();
    // Where the element's content starts: just past the opening tag.
    const beliefLineContentStartIndex =
      (beliefLineOpeningTag.index as number) + beliefLineOpeningTag[0].length;
    // The element's own close (or, for a directly-nested child, that child's
    // close — either way the text must come before it to be direct content).
    const beliefLineClosingTagIndex = mapPaneComponentSource.indexOf(
      '</',
      beliefLineContentStartIndex
    );
    const beliefAccessibleTextIndex = mapPaneComponentSource.indexOf(
      'beliefAccessibleText',
      beliefLineContentStartIndex
    );
    expect(
      beliefAccessibleTextIndex,
      'beliefAccessibleText must appear after the belief-line opening tag'
    ).toBeGreaterThanOrEqual(beliefLineContentStartIndex);
    expect(
      beliefAccessibleTextIndex,
      'beliefAccessibleText must appear before the belief-line element closes'
    ).toBeLessThan(beliefLineClosingTagIndex);
  });

  // Styling stays on theme tokens: no hex colour literal rides the line's
  // opening tag (an inline style={{ color: '#…' }} would dodge theming).
  // Red today via the missing-element throw; stays green after.
  it('carries no hex colour literal in the belief-line opening tag', () => {
    expect(readBeliefHoverLineOpeningTag()[0]).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  // GUARD (green today, vacuous until a const exists): any style const the
  // implementation names for the belief line (const hoverPreviewBeliefLine…,
  // per the fork naming rule every belief identifier says belief) must use
  // theme tokens, never hex literals. Bounded to belief-named consts so
  // upstream's pre-existing hexes elsewhere in the pane stay out of scope.
  it('uses no hex colour literal in any belief-named style const', () => {
    const beliefNamedStyleConstPattern =
      /const\s+[\w$]*[Bb]elief[\w$]*(?:\s*:\s*CSSProperties)?\s*=\s*\{[^}]*\}/g;
    for (const beliefNamedStyleConst of
      mapPaneComponentSource.match(beliefNamedStyleConstPattern) ?? []) {
      expect(
        beliefNamedStyleConst,
        'belief-named style consts must style with theme tokens, not hex literals'
      ).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe('MapPane.tsx renders the belief line for whatever node is hovered', () => {
  // GUARD (green today): "belief not assessed" IS the correct display for an
  // ungraded node, so no ring field may enter the card region — a
  // `beliefRingHue && line` gate would hide exactly the line the ungraded
  // node needs.
  it('mentions no ring field anywhere in the hover-card region (guard)', () => {
    expect(readBeliefHoverCardRegion()).not.toMatch(
      /beliefRingHue|beliefRingIntensityPercent|beliefRingStyle|beliefUncertainty/
    );
  });

  // GUARD (green today): no `? null` branch inside the card region — a
  // `cond ? null : line` (or any true-branch null) is the inverted-guard
  // shape that blanks the line for some hovered nodes. The card's own outer
  // `) : null` terminator is a COLON-null and stays legal.
  it('hides nothing behind a ? null branch in the card region (guard)', () => {
    expect(readBeliefHoverCardRegion()).not.toMatch(/\?\s*null\b/);
  });

  // GUARD (green today): the 'belief not assessed' sentinel belongs to the
  // presentation module alone. MapPane comparing against it (to suppress or
  // restyle the never-assessed line) would fork the vocabulary into a second
  // owner — so the literal may not appear in the pane at all.
  it('never mentions the belief-not-assessed sentinel text (guard)', () => {
    expect(mapPaneComponentSource).not.toMatch(/belief not assessed/);
  });

  // The belief line sits OUTSIDE the card's description conditional: the
  // card renders description-or-placeholder from a ternary, and a belief
  // line nested in either branch would render for only some hovered nodes.
  // Outside means before the conditional's first `description` mention or
  // after its last one (both placements are unconditional). Red today via
  // the class-missing indexOf. Vacuously green if the card ever stops
  // mentioning description — acceptable, since the hazard disappears with it.
  it('places the belief line outside the description conditional', () => {
    const hoverCardRegion = readBeliefHoverCardRegion();
    const beliefLineClassRegionIndex = hoverCardRegion.indexOf(beliefHoverLineClassName);
    expect(
      beliefLineClassRegionIndex,
      `the ${beliefHoverLineClassName} class must sit inside the hover-card region`
    ).toBeGreaterThanOrEqual(0);
    const firstDescriptionMentionIndex = hoverCardRegion.indexOf('description');
    const lastDescriptionMentionIndex = hoverCardRegion.lastIndexOf('description');
    if (firstDescriptionMentionIndex === -1) return;
    expect(
      beliefLineClassRegionIndex < firstDescriptionMentionIndex ||
        beliefLineClassRegionIndex > lastDescriptionMentionIndex,
      'the belief line must not nest inside the description ternary'
    ).toBe(true);
  });
});

describe('MapPane.tsx honours the derivation funnel (guard pins, green today)', () => {
  // GUARD: the pane consumes the FINISHED decision only. Importing the
  // derivation function here would create a second derivation site that can
  // drift from toRFNodes' — a hover line disagreeing with the ring under it.
  it('does not import deriveBeliefPresentation', () => {
    expect(mapPaneComponentSource).not.toMatch(/\bderiveBeliefPresentation\b/);
  });

  // GUARD: nor may the pane reach past the presentation to the shared MCP
  // mapper — the mapper feeds the derivation module, not components.
  it('does not import the shared belief MCP mapper', () => {
    expect(mapPaneComponentSource).not.toMatch(/beliefMcpToolContract/);
  });

  // GUARD: no direct belief_ column reads anywhere in the pane — pinned
  // FILE-WIDE, stricter than the card region alone, because the raw columns
  // stop at toRFNodes and MapPane has no legitimate reader of them. A card
  // keyed off node.belief_credence would bypass the one derivation site
  // (and its null-vs-0 normalisation).
  it('reads no belief_ column anywhere in the file', () => {
    expect(mapPaneComponentSource).not.toMatch(/\bbelief_[a-z]/);
  });
});
