/**
 * MAP LEGIBILITY, half A — the edge styles the knowledge map hands React Flow.
 *
 * WHY THESE NUMBERS. Measured in a live browser against a real graph, a
 * resting map edge renders at rgb(71, 85, 105) / 1.05px / opacity 0.2. Against
 * the near-black canvas that is invisible: a 1px hairline at one-fifth opacity
 * in a slate that is itself close to the background leaves the map reading as
 * unconnected dots. On the light theme the same hardcoded slate is merely
 * weak rather than absent, which is the second problem — a hex literal cannot
 * follow the theme, so one of the two themes is always wrong.
 *
 * The pinned contract for toRFEdges in src/components/panes/map/utils.ts:
 *  - the RESTING style (overview, no focusedGraph — by far the common case)
 *    strokes from the THEME TOKEN `var(--rah-text-muted)`, declared in both
 *    theme blocks of app/globals.css (#7a7a7a dark, #6b7280 light), so the
 *    edge adapts instead of being pinned to one theme's slate,
 *  - resting opacity is 0.5, and never below a 0.45 floor (0.2 measured
 *    invisible),
 *  - resting strokeWidth is 1.4, and never below a 1.3 floor (1.05 measured
 *    as a vanishing hairline),
 *  - THE EMPHASIS HIERARCHY SURVIVES: raising the resting floor must not
 *    flatten focus mode into one flat weight. An edge touching the selection
 *    stays strictly stronger than a second-hop edge, which stays at least as
 *    strong as a non-touching edge, which stays at least as strong as the
 *    resting style. This is the load-bearing pin: it forces the focused
 *    branches up with the floor rather than letting the floor overtake them,
 *  - no edge style in any of the four branches hard-codes a hex literal. The
 *    selected branch may keep its color-mix, but the colour it blends toward
 *    must be a token too.
 *
 * toRFEdges is pure and node-importable: utils.ts imports @xyflow/react with
 * `import type` only, so nothing pulls React or the DOM into this node-env
 * vitest run.
 */

import { describe, expect, it } from 'vitest';
import { toRFEdges, type FocusedGraph } from '@/components/panes/map/utils';
import type { Edge as DbEdge } from '@/types/database';

// The style object toRFEdges attaches to one React Flow edge, named off the
// function's own return type so this pin cannot drift from the signature.
type MapEdgeStyle = NonNullable<ReturnType<typeof toRFEdges>[number]['style']>;

// The theme token the resting edge must stroke from. Declared in both theme
// blocks of app/globals.css, so it resolves on light and on dark; a hex
// literal in its place can only be correct on one of them.
const mapEdgeRestingStrokeToken = 'var(--rah-text-muted)';

// The measured-invisible resting values, kept here as the reason the floors
// below exist rather than as anything the tests assert directly.
const measuredInvisibleRestingOpacity = 0.2;
const measuredInvisibleRestingStrokeWidthPx = 1.05;

// The intended resting values — the exact contract this change pins.
const intendedRestingOpacity = 0.5;
const intendedRestingStrokeWidthPx = 1.4;

// The floors the intended values sit above. A later tuning pass may move the
// exact values, but never back down through these: below them the resting
// edge stops being visible on the near-black canvas, which is the whole
// defect being fixed.
const minimumLegibleRestingOpacity = 0.45;
const minimumLegibleRestingStrokeWidthPx = 1.3;

// Matches any hex colour literal (#abc through #aabbccdd). Its presence in an
// edge style is the theme-blindness defect itself.
const hexColourLiteralPattern = /#[0-9a-fA-F]{3,8}\b/;

// Matches a reference to any --rah- theme token, which is what a
// theme-following stroke must be built from.
const themeTokenReferencePattern = /var\(\s*--rah-/;

/**
 * Builds one database edge row with only the fields toRFEdges reads — its id,
 * its two endpoints and its context explanation. Everything else on the row
 * is inert for edge styling, so the fixture states the minimum and no more.
 */
function buildDbEdgeFixture(edgeId: number, fromNodeId: number, toNodeId: number): DbEdge {
  return {
    id: edgeId,
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    context: { explanation: `edge ${edgeId}` },
    source: 'user',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

// The fixture graph, sized to exercise all three focused branches at once.
// Node 1 is the selection, 2 and 3 are its first hop, 4 is a second hop, and
// 5 is an outsider that lets one edge touch neither the selection nor a
// second hop.
const selectedFixtureNodeId = 1;
const secondHopFixtureNodeId = 4;
const outsiderFixtureNodeId = 5;

// Edge touching the selection directly: node 1 to its first hop node 2.
const selectionTouchingFixtureEdge = buildDbEdgeFixture(101, selectedFixtureNodeId, 2);
// Edge reaching a second hop without touching the selection: node 2 to node 4.
const secondHopFixtureEdge = buildDbEdgeFixture(102, 2, secondHopFixtureNodeId);
// Edge touching neither the selection nor any second hop: node 3 to node 5.
const nonTouchingFixtureEdge = buildDbEdgeFixture(103, 3, outsiderFixtureNodeId);

// Every fixture node id, as the string set toRFEdges filters endpoints against.
const fixtureMapNodeIds = new Set(
  [selectedFixtureNodeId, 2, 3, secondHopFixtureNodeId, outsiderFixtureNodeId].map(String)
);

// The focus state that puts the map in focused mode around node 1.
const fixtureFocusedGraph: FocusedGraph = {
  selectedNodeId: selectedFixtureNodeId,
  firstHopIds: [2, 3],
  secondHopIds: [secondHopFixtureNodeId],
  nodeIds: new Set([selectedFixtureNodeId, 2, 3, secondHopFixtureNodeId]),
};

/**
 * Runs toRFEdges over one fixture edge and returns the style it produced.
 * `focusedGraph: null` asks for the resting (overview) branch; passing the
 * fixture focus state asks for whichever focused branch that edge falls in.
 */
function readMapEdgeStyle(dbEdge: DbEdge, focusedGraph: FocusedGraph | null): MapEdgeStyle {
  const [builtMapEdge] = toRFEdges({
    dbEdges: [dbEdge],
    nodeIds: fixtureMapNodeIds,
    focusedGraph,
  });
  expect(builtMapEdge, 'toRFEdges must build an edge for a fixture whose endpoints it knows').toBeTruthy();
  expect(builtMapEdge.style, 'every built map edge must carry a style').toBeTruthy();
  return builtMapEdge.style as MapEdgeStyle;
}

/**
 * Reads one numeric style value (opacity or strokeWidth) off an edge style.
 * A missing property, or one expressed as a string, is its own failure mode
 * and is named as such rather than silently comparing as NaN.
 */
function readNumericEdgeStyleValue(
  mapEdgeStyle: MapEdgeStyle,
  styleProperty: 'opacity' | 'strokeWidth'
): number {
  const rawStyleValue = mapEdgeStyle[styleProperty];
  expect(
    typeof rawStyleValue,
    `edge style must declare a numeric ${styleProperty}, got ${JSON.stringify(rawStyleValue)}`
  ).toBe('number');
  return rawStyleValue as number;
}

/**
 * Reads the stroke colour off an edge style as text, so it can be tested for
 * theme tokens and hex literals alike.
 */
function readEdgeStrokeText(mapEdgeStyle: MapEdgeStyle): string {
  const strokeValue = mapEdgeStyle.stroke;
  expect(typeof strokeValue, 'edge style must declare a stroke').toBe('string');
  return String(strokeValue);
}

// The resting style — overview mode, no focus. The common case, and the one
// measured invisible.
const restingMapEdgeStyle = readMapEdgeStyle(selectionTouchingFixtureEdge, null);

// The three focused branches, each from the fixture edge that falls in it.
const selectionTouchingMapEdgeStyle = readMapEdgeStyle(selectionTouchingFixtureEdge, fixtureFocusedGraph);
const secondHopMapEdgeStyle = readMapEdgeStyle(secondHopFixtureEdge, fixtureFocusedGraph);
const nonTouchingMapEdgeStyle = readMapEdgeStyle(nonTouchingFixtureEdge, fixtureFocusedGraph);

describe('map edge visibility (toRFEdges)', () => {
  // THEME-FOLLOWING RESTING STROKE. The measured stroke was the literal
  // #475569, which can only be tuned for one theme; the map is themed, so the
  // resting stroke must name a token that both theme blocks define.
  it(`strokes the resting edge from ${mapEdgeRestingStrokeToken}`, () => {
    const restingStroke = readEdgeStrokeText(restingMapEdgeStyle);
    expect(
      restingStroke,
      `resting edges must stroke from the theme token so they follow light and dark; measured value was the fixed slate #475569`
    ).toBe(mapEdgeRestingStrokeToken);
  });

  // The same pin stated as a guard: no hex may survive anywhere in the
  // resting or the non-touching (unfocused) styles, which are the two states
  // a user spends nearly all their time looking at.
  it('hard-codes no hex literal in the resting or unfocused edge styles', () => {
    expect(
      readEdgeStrokeText(restingMapEdgeStyle),
      'the resting stroke must contain no hex literal'
    ).not.toMatch(hexColourLiteralPattern);
    expect(
      readEdgeStrokeText(nonTouchingMapEdgeStyle),
      'the unfocused (non-touching) stroke must contain no hex literal'
    ).not.toMatch(hexColourLiteralPattern);
  });

  // RESTING OPACITY. 0.5 is the intended value; the 0.45 floor records that
  // the measured 0.2 was invisible against the near-black canvas, so no later
  // tuning may sink back through it.
  it(`sets resting opacity to ${intendedRestingOpacity}, above the ${minimumLegibleRestingOpacity} legibility floor`, () => {
    const restingOpacity = readNumericEdgeStyleValue(restingMapEdgeStyle, 'opacity');
    expect(restingOpacity, 'resting opacity must be the intended value').toBe(intendedRestingOpacity);
    // Floor assertion: the measured 0.2 rendered invisible in a live browser.
    expect(
      restingOpacity,
      `resting opacity must stay at or above ${minimumLegibleRestingOpacity}; ${measuredInvisibleRestingOpacity} measured invisible on the near-black canvas`
    ).toBeGreaterThanOrEqual(minimumLegibleRestingOpacity);
  });

  // RESTING STROKE WIDTH. 1.4 is the intended value; the 1.3 floor records
  // that the measured 1.05px rendered as a vanishing hairline.
  it(`sets resting strokeWidth to ${intendedRestingStrokeWidthPx}, above the ${minimumLegibleRestingStrokeWidthPx} legibility floor`, () => {
    const restingStrokeWidth = readNumericEdgeStyleValue(restingMapEdgeStyle, 'strokeWidth');
    expect(restingStrokeWidth, 'resting strokeWidth must be the intended value').toBe(
      intendedRestingStrokeWidthPx
    );
    // Floor assertion: the measured 1.05px rendered as a vanishing hairline.
    expect(
      restingStrokeWidth,
      `resting strokeWidth must stay at or above ${minimumLegibleRestingStrokeWidthPx}; ${measuredInvisibleRestingStrokeWidthPx} measured as a vanishing hairline`
    ).toBeGreaterThanOrEqual(minimumLegibleRestingStrokeWidthPx);
  });

  // THE LOAD-BEARING PIN. Focus mode says something with weight: the edges
  // touching your selection are loud, the second hop is quieter, everything
  // else recedes. Raising the resting floor eats that hierarchy from below
  // unless the focused branches move up with it — a map where every edge is
  // equally visible has traded one unreadable state for another.
  it('keeps the focused emphasis hierarchy strictly ordered above the raised resting floor', () => {
    const selectionTouchingOpacity = readNumericEdgeStyleValue(selectionTouchingMapEdgeStyle, 'opacity');
    const secondHopOpacity = readNumericEdgeStyleValue(secondHopMapEdgeStyle, 'opacity');
    const nonTouchingOpacity = readNumericEdgeStyleValue(nonTouchingMapEdgeStyle, 'opacity');
    const restingOpacity = readNumericEdgeStyleValue(restingMapEdgeStyle, 'opacity');

    const selectionTouchingStrokeWidth = readNumericEdgeStyleValue(selectionTouchingMapEdgeStyle, 'strokeWidth');
    const secondHopStrokeWidth = readNumericEdgeStyleValue(secondHopMapEdgeStyle, 'strokeWidth');
    const nonTouchingStrokeWidth = readNumericEdgeStyleValue(nonTouchingMapEdgeStyle, 'strokeWidth');
    const restingStrokeWidth = readNumericEdgeStyleValue(restingMapEdgeStyle, 'strokeWidth');

    // An edge touching the selection must be strictly louder than a second
    // hop on BOTH channels — colour alone is not enough at these widths.
    expect(
      selectionTouchingOpacity,
      'an edge touching the selection must be strictly more opaque than a second-hop edge'
    ).toBeGreaterThan(secondHopOpacity);
    expect(
      selectionTouchingStrokeWidth,
      'an edge touching the selection must be strictly thicker than a second-hop edge'
    ).toBeGreaterThan(secondHopStrokeWidth);

    // A second hop must be at least as loud as an edge in neither hop.
    expect(
      secondHopOpacity,
      'a second-hop edge must be at least as opaque as a non-touching edge'
    ).toBeGreaterThanOrEqual(nonTouchingOpacity);
    expect(
      secondHopStrokeWidth,
      'a second-hop edge must be at least as thick as a non-touching edge'
    ).toBeGreaterThanOrEqual(nonTouchingStrokeWidth);

    // And the weakest focused branch must not sink below the resting style —
    // this is the assertion the raised floor threatens, and the reason the
    // focused branches have to be lifted with it.
    expect(
      nonTouchingOpacity,
      'a non-touching focused edge must be at least as opaque as the raised resting style'
    ).toBeGreaterThanOrEqual(restingOpacity);
    expect(
      nonTouchingStrokeWidth,
      'a non-touching focused edge must be at least as thick as the raised resting style'
    ).toBeGreaterThanOrEqual(restingStrokeWidth);
  });

  // The non-touching and second-hop branches are theme-blind today for the
  // same reason the resting branch is: literal slates. Both must name tokens.
  it('strokes the non-touching and second-hop edges from theme tokens', () => {
    expect(
      readEdgeStrokeText(nonTouchingMapEdgeStyle),
      'the non-touching stroke must come from a --rah- theme token'
    ).toMatch(themeTokenReferencePattern);
    expect(
      readEdgeStrokeText(secondHopMapEdgeStyle),
      'the second-hop stroke must come from a --rah- theme token'
    ).toMatch(themeTokenReferencePattern);
  });

  // FILE-WIDE HEX GUARD across all four branches. The selected branch may
  // keep its color-mix — mixing a token toward a neutral is a legitimate way
  // to soften an accent — but the neutral it mixes toward must itself be a
  // token, or half of that colour is still pinned to one theme.
  it('hard-codes no hex literal in any of the four edge styles', () => {
    const everyMapEdgeStyleByBranch: Array<[string, MapEdgeStyle]> = [
      ['resting', restingMapEdgeStyle],
      ['non-touching', nonTouchingMapEdgeStyle],
      ['second-hop', secondHopMapEdgeStyle],
      ['selection-touching', selectionTouchingMapEdgeStyle],
    ];
    for (const [branchName, mapEdgeStyle] of everyMapEdgeStyleByBranch) {
      expect(
        readEdgeStrokeText(mapEdgeStyle),
        `the ${branchName} stroke hard-codes a hex literal, which cannot follow the theme`
      ).not.toMatch(hexColourLiteralPattern);
    }
  });
});
