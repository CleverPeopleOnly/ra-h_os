/**
 * SLICE 7 of the belief map overlay — the MiniMap tint's consumption side.
 * Component under change: src/components/panes/MapPane.tsx, whose React Flow
 * <MiniMap> nodeColor callback must call the pure tint decision
 * beliefMiniMapNodeColor (the new presentation-module export
 * beliefMiniMapNodeColor.test.ts drives red) and use its non-null result in
 * preference to the role colour.
 *
 * This harness runs node-env vitest with no jsdom, so the pane cannot be
 * rendered; the behaviour is pinned by reading the checked-in source and
 * asserting against the text — the same source-text pinning as
 * beliefMapPaneHoverCardBeliefLine.test.ts, with regex tolerance for
 * formatting throughout.
 *
 * WHAT THE CALLBACK IS TODAY (read before implementing): the MiniMap's
 * nodeColor callback receives the RF node, casts node.data to
 * RahNodeData | undefined, and switches on data?.role — returning the role
 * hexes '#16a34a' (selected) / '#22c55e' (first-hop) / '#94a3b8'
 * (second-hop) / '#64748b' (default). Those role colours are upstream's and
 * MUST SURVIVE this slice: they are the fallback for every node the belief
 * system has no say over. The finished belief presentation is already ON the
 * callback's input — toRFNodes threads it in as RahNodeData.beliefPresentation
 * (non-optional) — so no lookup and no re-derivation is needed.
 *
 * THE IMPORT IS LEGAL (read before implementing): MapPane imports nothing
 * from belief modules today, and the slice-6 funnel guards (restated below)
 * ban deriveBeliefPresentation and the shared MCP mapper — but the pure
 * presentation-CONSUMING helpers are exactly what components should import.
 * beliefMiniMapNodeColor takes the finished decision and derives nothing, so
 * importing it keeps the funnel intact.
 *
 * The contract pinned here:
 *  - MapPane imports beliefMiniMapNodeColor (a VALUE import, not type-only)
 *    from '@/services/belief/beliefPresentation',
 *  - the nodeColor callback body (brace-matched from the nodeColor= prop)
 *    references beliefMiniMapNodeColor, fed from a beliefPresentation — the
 *    RahNodeData field toRFNodes filled,
 *  - a null fall-through is present in the body (`??` or an explicit null
 *    check): the helper returns null for a never-assessed node, and the
 *    callback must then fall back to the role colour, never paint belief. A
 *    bare truthy check (`if (beliefColor) …` with no null mention) would
 *    fail this pin — flagged for the Reviewer as a deliberate narrowing (the
 *    helper never returns '', so truthy would be semantically sound, but the
 *    pin demands the null-ness be spoken),
 *  - PRECEDENCE, pinned textually: the helper reference sits BEFORE the
 *    first role hex in the body — the belief tint is consulted first and the
 *    role switch is the fall-through, matching every fall-through shape
 *    (`beliefMiniMapNodeColor(…) ?? role…`, or an early return on non-null),
 *  - the role colours SURVIVE: all four role hexes and the role switch stay
 *    in the body (guard, green today — the implementation must not delete
 *    Brad's role colours),
 *  - FUNNEL RULE (restated from slices 4-6, GUARD pins green today): MapPane
 *    must NOT import deriveBeliefPresentation or the shared MCP mapper, and
 *    must not read any belief_ column anywhere in the file.
 *
 * Red today (5): the import, helper-in-body, beliefPresentation-in-body,
 * null-fall-through, and precedence pins (the callback has no belief code
 * yet — precedence goes red via its helper-present premise assert). Green
 * today, flagged ANCHOR or GUARD (6): the nodeColor anchor, the two
 * role-colour survival guards, and the three funnel-rule pins — they exist
 * to stay green.
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

// The pure tint decision the callback must consume — the new presentation
// export beliefMiniMapNodeColor.test.ts reds into existence.
const beliefMiniMapHelperName = 'beliefMiniMapNodeColor';

// The four role hexes the callback returns today — upstream's MiniMap role
// colours, which the survival guard pins in place.
const MINI_MAP_ROLE_COLOR_HEXES = ['#16a34a', '#22c55e', '#94a3b8', '#64748b'] as const;

/**
 * The nodeColor callback body: the source between the balanced braces of the
 * nodeColor={…} prop, located from its `nodeColor=` anchor. Brace-matching
 * (not a fixed region length) so the pins track the callback exactly however
 * long the implementation makes it, and never spill into the JSX after the
 * MiniMap. Limitation, acceptable here: a brace inside a string literal or
 * comment would miscount — the callback contains none today and the pinned
 * additions (a helper call, a null fall-through) introduce none.
 *
 * Throws a named error when the prop or its braces are missing — every body
 * pin surfaces that one failure mode identically.
 */
function readMiniMapNodeColorCallbackBody(): string {
  const nodeColorAnchorIndex = mapPaneComponentSource.indexOf('nodeColor=');
  if (nodeColorAnchorIndex === -1) {
    throw new Error(
      'MapPane.tsx has no nodeColor= prop — the MiniMap tint pins have nothing to bound'
    );
  }
  // The prop value's opening brace: the first `{` after the anchor.
  const openingBraceIndex = mapPaneComponentSource.indexOf('{', nodeColorAnchorIndex);
  if (openingBraceIndex === -1) {
    throw new Error('MapPane.tsx nodeColor= prop has no opening brace');
  }
  // Scan forward counting brace depth until the opening brace closes.
  let braceDepth = 0;
  for (
    let scanIndex = openingBraceIndex;
    scanIndex < mapPaneComponentSource.length;
    scanIndex += 1
  ) {
    const scannedCharacter = mapPaneComponentSource[scanIndex];
    if (scannedCharacter === '{') braceDepth += 1;
    if (scannedCharacter === '}') braceDepth -= 1;
    if (braceDepth === 0) {
      return mapPaneComponentSource.slice(openingBraceIndex, scanIndex + 1);
    }
  }
  throw new Error('MapPane.tsx nodeColor= prop braces never close');
}

describe('MapPane.tsx keeps the MiniMap nodeColor callback this slice extends (anchor, green today)', () => {
  // ANCHOR: the MiniMap has a nodeColor prop. Every body pin below bounds
  // itself on this anchor, so its survival is pinned explicitly with a
  // readable failure of its own.
  it('renders a MiniMap with a nodeColor callback', () => {
    expect(
      mapPaneComponentSource.includes('nodeColor='),
      'MapPane.tsx must keep its MiniMap nodeColor= prop'
    ).toBe(true);
  });
});

describe('MapPane.tsx imports the MiniMap tint decision from the presentation module', () => {
  // The helper is imported as a VALUE from the presentation module — the
  // one belief import a component should have. `import {` (not
  // `import type {`) pins it callable; the type-only-specifier guard below
  // catches the mixed `{ type beliefMiniMapNodeColor }` dodge.
  it(`imports ${beliefMiniMapHelperName} from @/services/belief/beliefPresentation as a value`, () => {
    const miniMapHelperImportMatch = mapPaneComponentSource.match(
      new RegExp(
        String.raw`import\s*\{[^}]*\b${beliefMiniMapHelperName}\b[^}]*\}\s*from\s*['"]@\/services\/belief\/beliefPresentation['"]`
      )
    );
    expect(
      miniMapHelperImportMatch,
      `MapPane.tsx must import ${beliefMiniMapHelperName} from the presentation module`
    ).not.toBeNull();
    // A `type` keyword on the specifier would make it uncallable at runtime.
    expect(
      (miniMapHelperImportMatch as RegExpMatchArray)[0],
      `${beliefMiniMapHelperName} must be a value import, not a type-only specifier`
    ).not.toMatch(new RegExp(String.raw`\btype\s+${beliefMiniMapHelperName}\b`));
  });
});

describe('MapPane.tsx consults the belief tint inside the nodeColor callback', () => {
  // The callback calls the pure decision — without it the MiniMap ignores
  // belief entirely and every node keeps only its role colour.
  it(`references ${beliefMiniMapHelperName} inside the nodeColor callback body`, () => {
    expect(
      readMiniMapNodeColorCallbackBody(),
      `the nodeColor callback must call ${beliefMiniMapHelperName}`
    ).toContain(beliefMiniMapHelperName);
  });

  // The helper is fed from the FINISHED decision toRFNodes threaded onto the
  // node: the body must reference beliefPresentation (the RahNodeData
  // field), never re-derive — the funnel guards below ban the derivation
  // imports, so this pin plus those guards leaves only the pass-through.
  it('feeds the helper from beliefPresentation (the RahNodeData field toRFNodes filled)', () => {
    expect(
      readMiniMapNodeColorCallbackBody(),
      'the nodeColor callback must read the node beliefPresentation'
    ).toContain('beliefPresentation');
  });

  // The null fall-through: the helper answers null for a never-assessed node
  // and the callback must then fall back to the role colour. Pinned as `??`
  // or an explicit null mention in the body — either fall-through shape
  // satisfies it; today the body has neither.
  it('falls through on a null tint (`??` or an explicit null check in the body)', () => {
    expect(
      readMiniMapNodeColorCallbackBody(),
      'the nodeColor callback must handle the helper null result explicitly'
    ).toMatch(/\?\?|null/);
  });

  // PRECEDENCE, pinned textually: the helper reference comes BEFORE the
  // first role hex in the body — belief is consulted first, the role switch
  // is the fall-through. Every fall-through shape (`?? role`, early return
  // on non-null) puts the helper first; a shape consulting roles first would
  // let a role colour shadow an assessed node's tint.
  it('consults the belief tint before the role colours in the body', () => {
    const nodeColorCallbackBody = readMiniMapNodeColorCallbackBody();
    // Where the helper is consulted — premise assert first, because an
    // absent helper (indexOf -1) would otherwise compare as "before"
    // everything and green this pin falsely.
    const miniMapHelperReferenceIndex = nodeColorCallbackBody.indexOf(beliefMiniMapHelperName);
    expect(
      miniMapHelperReferenceIndex,
      `the nodeColor callback must reference ${beliefMiniMapHelperName}`
    ).toBeGreaterThanOrEqual(0);
    // Where the first role hex sits (any hex literal — the body's only
    // hexes are the four role colours, guarded below).
    const firstRoleHexMatch = nodeColorCallbackBody.match(/#[0-9a-fA-F]{3,8}\b/);
    expect(
      firstRoleHexMatch?.index,
      'the nodeColor callback must keep a role hex to fall back to'
    ).toBeDefined();
    expect(
      miniMapHelperReferenceIndex,
      'the belief tint must be consulted before the role colours'
    ).toBeLessThan(firstRoleHexMatch?.index as number);
  });
});

describe('MapPane.tsx keeps the role colours the tint falls back to (guards, green today)', () => {
  // GUARD: all four role hexes survive in the callback body — they are the
  // fallback for every node belief has no say over, and this slice must not
  // delete Brad's role colours.
  it('keeps all four MiniMap role hexes in the nodeColor callback body', () => {
    const nodeColorCallbackBody = readMiniMapNodeColorCallbackBody();
    for (const miniMapRoleColorHex of MINI_MAP_ROLE_COLOR_HEXES) {
      expect(
        nodeColorCallbackBody,
        `the nodeColor callback must keep the role colour ${miniMapRoleColorHex}`
      ).toContain(miniMapRoleColorHex);
    }
  });

  // GUARD: the role switch survives — the body still branches on the node's
  // role (however the implementation reaches it: data?.role, a destructure).
  it('keeps the role branch in the nodeColor callback body', () => {
    expect(
      readMiniMapNodeColorCallbackBody(),
      'the nodeColor callback must still branch on the node role'
    ).toMatch(/\brole\b/);
  });
});

describe('MapPane.tsx honours the derivation funnel (guard pins, green today)', () => {
  // GUARD (restated from slice 6): the pane consumes finished decisions
  // only. Importing the derivation function here would create a second
  // derivation site that can drift from toRFNodes' — a MiniMap tint
  // disagreeing with the ring on the map itself.
  it('does not import deriveBeliefPresentation', () => {
    expect(mapPaneComponentSource).not.toMatch(/\bderiveBeliefPresentation\b/);
  });

  // GUARD (restated): nor may the pane reach past the presentation to the
  // shared MCP mapper — the mapper feeds the derivation module, not
  // components.
  it('does not import the shared belief MCP mapper', () => {
    expect(mapPaneComponentSource).not.toMatch(/beliefMcpToolContract/);
  });

  // GUARD (restated): no direct belief_ column reads anywhere in the pane —
  // file-wide, because the raw columns stop at toRFNodes and MapPane has no
  // legitimate reader of them. A tint keyed off node.belief_credence would
  // bypass the one derivation site (and its null-vs-0 normalisation).
  it('reads no belief_ column anywhere in the file', () => {
    expect(mapPaneComponentSource).not.toMatch(/\bbelief_[a-z]/);
  });
});
