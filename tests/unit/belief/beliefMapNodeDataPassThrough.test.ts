/**
 * SLICE 3 of the belief map overlay — the red for threading a node's belief
 * presentation into the React Flow node data. Module under change:
 * src/components/panes/map/utils.ts. Pure functions only: no React render,
 * no database, no DOM — toRFNodes and deriveBeliefPresentation are both
 * node-env importable.
 *
 * The contract pinned here:
 *  - RahNodeData gains `beliefPresentation: BeliefPresentation`, and
 *    toRFNodes() populates it for EVERY emitted node by deriving from the
 *    node's four belief columns,
 *  - the emitted presentation deep-equals deriveBeliefPresentation() of the
 *    same fields — the derivation module is the one owner, so a hand-rolled
 *    divergent copy inside toRFNodes fails these tests,
 *  - a node object WITHOUT any belief keys (older fixtures/callers) behaves
 *    exactly like an all-NULL row: the never-assessed decision, never a
 *    crash, never a credence rendered as 0,
 *  - the existing RahNodeData fields (label, edgeCount, dbNode, role,
 *    connectionCount, prominence) survive untouched beside the new field.
 *
 * Red pattern: `beliefPresentation` is missing from RahNodeData today. A
 * static property access on the emitted data would not break tsc here —
 * RahNodeData carries a `[key: string]: unknown` index signature — but it
 * would type the field as `unknown`. So, exactly like the namespace-cast
 * precedent in beliefGradingPolicyV2SubjectiveLogic.test.ts, the pinned
 * surface lives in a LOCAL type (BeliefAwareRahNodeData) and the emitted
 * data is cast to it: `npx tsc --noEmit` stays clean while every test reds
 * at runtime on the missing field.
 *
 * Static imports are safe: utils.ts only type-imports @xyflow/react and the
 * database types (erased at runtime), and beliefPresentation.ts is pure.
 */

import { describe, expect, it } from 'vitest';
import type { Node as RFNode } from '@xyflow/react';
import { toRFNodes } from '@/components/panes/map/utils';
import type { RahNodeData } from '@/components/panes/map/utils';
import { deriveBeliefPresentation } from '@/services/belief/beliefPresentation';
import type {
  BeliefPresentation,
  BeliefPresentationNodeFields,
} from '@/services/belief/beliefPresentation';
import type { Node as DbNode } from '@/types/database';

// The belief-aware node data surface this slice drives: today's RahNodeData
// plus the beliefPresentation field toRFNodes must populate. Declared locally
// because RahNodeData does not carry the field yet — that missing field is
// the red of this file.
type BeliefAwareRahNodeData = RahNodeData & {
  beliefPresentation: BeliefPresentation;
};

// Read the belief presentation off one emitted React Flow node, through the
// locally-pinned surface (see the red-pattern note in the header).
function beliefPresentationOfEmittedNode(
  emittedNode: RFNode<RahNodeData>
): BeliefPresentation {
  return (emittedNode.data as BeliefAwareRahNodeData).beliefPresentation;
}

// W of belief model v2, restated by hand so the graded fixtures below store a
// cached credence that is an independent calculation, not an import of the
// constant under test.
const HAND_CALCULATED_BELIEF_PRIOR_MASS = 2;

// The cached credence the v2 engine persists for the two masses: the signed
// projection (r - s) / (r + s + W).
function handCalculatedBeliefCredenceProjection(forMass: number, againstMass: number): number {
  return (
    (forMass - againstMass) /
    (forMass + againstMass + HAND_CALCULATED_BELIEF_PRIOR_MASS)
  );
}

// Build a graded (engine-derived) node's four belief columns from its two
// masses, with the cached credence being the projection — exactly what the
// v2 engine persists onto the nodes row.
function gradedNodeBeliefFields(forMass: number, againstMass: number): BeliefPresentationNodeFields {
  return {
    belief_credence: handCalculatedBeliefCredenceProjection(forMass, againstMass),
    belief_credence_is_fixed: 0,
    belief_evidence_for_mass: forMass,
    belief_evidence_against_mass: againstMass,
  };
}

// A node whose credence a human asserted by hand: flag 1, masses NULL —
// there is no evidence ledger behind an assertion.
function fixedCredenceNodeBeliefFields(assertedCredence: number): BeliefPresentationNodeFields {
  return {
    belief_credence: assertedCredence,
    belief_credence_is_fixed: 1,
    belief_evidence_for_mass: null,
    belief_evidence_against_mass: null,
  };
}

// A node nobody has ever assessed, with the belief columns EXPLICITLY null —
// the row shape the database reports.
const NEVER_ASSESSED_NODE_BELIEF_FIELDS: BeliefPresentationNodeFields = {
  belief_credence: null,
  belief_credence_is_fixed: 0,
  belief_evidence_for_mass: null,
  belief_evidence_against_mass: null,
};

// One DbNode-shaped fixture carrying only what toRFNodes reads: id and title
// (label), edge_count (degree fallback), plus the belief columns under test.
// created_at/updated_at exist only to satisfy the DbNode type. Passing no
// beliefFields builds the older-caller shape with NO belief keys at all.
function beliefMapDbNodeFixture(params: {
  nodeId: number;
  nodeTitle: string;
  nodeEdgeCount?: number;
  beliefFields?: BeliefPresentationNodeFields;
}): DbNode {
  return {
    id: params.nodeId,
    title: params.nodeTitle,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...(params.nodeEdgeCount !== undefined ? { edge_count: params.nodeEdgeCount } : {}),
    ...(params.beliefFields ?? {}),
  };
}

// Run toRFNodes over the given nodes in the simplest overview configuration:
// no focus, empty adjacency/degree structures, origin-centred layout. The
// layout coordinates are irrelevant to this file — only the emitted data is.
function emitBeliefMapNodes(dbNodes: DbNode[]): RFNode<RahNodeData>[] {
  return toRFNodes({
    nodes: dbNodes,
    viewMode: 'overview',
    degreeMap: new Map<number, number>(),
    adjacency: new Map<number, Set<number>>(),
    focusedGraph: null,
    centerX: 0,
    centerY: 0,
  });
}

// The four exemplar belief states threaded through toRFNodes below, built
// once so the agreement battery and the literal pins share fixtures.
// Believed with solid evidence: r=6, s=2 -> credence +0.4, uncertainty 0.2.
const BELIEVED_SOLID_BELIEF_FIELDS = gradedNodeBeliefFields(6, 2);
// Disbelieved on sparse evidence: r=0, s=0.5 -> credence -0.2, uncertainty 0.8.
const DISBELIEVED_SPARSE_BELIEF_FIELDS = gradedNodeBeliefFields(0, 0.5);
// Fixed by hand at -0.4: flag 1, masses NULL, uncertainty 0 by definition.
const FIXED_CREDENCE_BELIEF_FIELDS = fixedCredenceNodeBeliefFields(-0.4);
// Graded and balanced: r=3, s=3 -> credence exactly 0, uncertainty 0.25.
const GRADED_NEUTRAL_BELIEF_FIELDS = gradedNodeBeliefFields(3, 3);

describe('toRFNodes populates beliefPresentation from the derivation module', () => {
  // The AGREEMENT pin: for a graded node the emitted presentation must
  // deep-equal deriveBeliefPresentation() of the same four fields — the
  // derivation happens once, in the presentation module, and any hand-rolled
  // divergent copy inside toRFNodes diverges from this expectation.
  it('emits data.beliefPresentation deep-equal to deriveBeliefPresentation of the same belief fields', () => {
    const gradedDbNode = beliefMapDbNodeFixture({
      nodeId: 1,
      nodeTitle: 'Graded node',
      beliefFields: BELIEVED_SOLID_BELIEF_FIELDS,
    });
    const [emittedGradedNode] = emitBeliefMapNodes([gradedDbNode]);
    expect(beliefPresentationOfEmittedNode(emittedGradedNode)).toEqual(
      deriveBeliefPresentation(BELIEVED_SOLID_BELIEF_FIELDS)
    );
  });

  // Every emitted node carries the field — populated for EVERY node, not
  // just the ones with belief columns, and each agrees with the derivation
  // of its own row.
  it('populates beliefPresentation on every emitted node, each agreeing with its own derivation', () => {
    // One node per belief state the derivation module distinguishes, plus an
    // older-caller node with no belief keys at all.
    const beliefStateBatteryDbNodes = [
      beliefMapDbNodeFixture({ nodeId: 1, nodeTitle: 'Believed', beliefFields: BELIEVED_SOLID_BELIEF_FIELDS }),
      beliefMapDbNodeFixture({ nodeId: 2, nodeTitle: 'Disbelieved', beliefFields: DISBELIEVED_SPARSE_BELIEF_FIELDS }),
      beliefMapDbNodeFixture({ nodeId: 3, nodeTitle: 'Fixed', beliefFields: FIXED_CREDENCE_BELIEF_FIELDS }),
      beliefMapDbNodeFixture({ nodeId: 4, nodeTitle: 'Neutral', beliefFields: GRADED_NEUTRAL_BELIEF_FIELDS }),
      beliefMapDbNodeFixture({ nodeId: 5, nodeTitle: 'No belief keys' }),
    ];
    // What each row derives to on its own, keyed the same way as the battery.
    const expectedPresentationsByNodeId = new Map<string, BeliefPresentation>([
      ['1', deriveBeliefPresentation(BELIEVED_SOLID_BELIEF_FIELDS)],
      ['2', deriveBeliefPresentation(DISBELIEVED_SPARSE_BELIEF_FIELDS)],
      ['3', deriveBeliefPresentation(FIXED_CREDENCE_BELIEF_FIELDS)],
      ['4', deriveBeliefPresentation(GRADED_NEUTRAL_BELIEF_FIELDS)],
      ['5', deriveBeliefPresentation(NEVER_ASSESSED_NODE_BELIEF_FIELDS)],
    ]);
    const emittedBatteryNodes = emitBeliefMapNodes(beliefStateBatteryDbNodes);
    expect(emittedBatteryNodes).toHaveLength(beliefStateBatteryDbNodes.length);
    for (const emittedNode of emittedBatteryNodes) {
      expect(
        beliefPresentationOfEmittedNode(emittedNode),
        `node ${emittedNode.id} must carry the derivation of its own belief fields`
      ).toEqual(expectedPresentationsByNodeId.get(emittedNode.id));
    }
  });
});

describe('toRFNodes exemplar belief states arrive intact in the node data', () => {
  // Believed node: positive credence (+0.4) on real evidence (u = 0.2) —
  // 'for' hue, solid ring, the committed 55% band, no badge. Literal pins,
  // independent of the derivation call, so a broken derivation AND a
  // divergent copy both fail.
  it("threads a believed node through as a solid 'for' ring", () => {
    const [emittedBelievedNode] = emitBeliefMapNodes([
      beliefMapDbNodeFixture({ nodeId: 1, nodeTitle: 'Believed', beliefFields: BELIEVED_SOLID_BELIEF_FIELDS }),
    ]);
    const believedPresentation = beliefPresentationOfEmittedNode(emittedBelievedNode);
    expect(believedPresentation.beliefRingHue).toBe('for');
    expect(believedPresentation.beliefRingStyle).toBe('solid');
    expect(believedPresentation.beliefRingIntensityPercent).toBe(55);
    expect(believedPresentation.beliefFixedBadgeShown).toBe(false);
    expect(believedPresentation.beliefUncertainty).toBe(0.2);
  });

  // Disbelieved high-uncertainty node: negative credence (-0.2) on sparse
  // masses (u = 0.8) — 'against' hue, dashed ring, the leaning 30% band.
  it("threads a disbelieved sparse-evidence node through as a dashed 'against' ring", () => {
    const [emittedDisbelievedNode] = emitBeliefMapNodes([
      beliefMapDbNodeFixture({ nodeId: 1, nodeTitle: 'Disbelieved', beliefFields: DISBELIEVED_SPARSE_BELIEF_FIELDS }),
    ]);
    const disbelievedPresentation = beliefPresentationOfEmittedNode(emittedDisbelievedNode);
    expect(disbelievedPresentation.beliefRingHue).toBe('against');
    expect(disbelievedPresentation.beliefRingStyle).toBe('dashed');
    expect(disbelievedPresentation.beliefRingIntensityPercent).toBe(30);
    expect(disbelievedPresentation.beliefUncertainty).toBe(0.8);
  });

  // Fixed node: flag 1 shows the badge and pins uncertainty to 0 (the
  // dogmatic opinion), so its ring is always solid.
  it('threads a fixed-credence node through with the badge and uncertainty 0', () => {
    const [emittedFixedNode] = emitBeliefMapNodes([
      beliefMapDbNodeFixture({ nodeId: 1, nodeTitle: 'Fixed', beliefFields: FIXED_CREDENCE_BELIEF_FIELDS }),
    ]);
    const fixedPresentation = beliefPresentationOfEmittedNode(emittedFixedNode);
    expect(fixedPresentation.beliefFixedBadgeShown).toBe(true);
    expect(fixedPresentation.beliefUncertainty).toBe(0);
    expect(fixedPresentation.beliefRingHue).toBe('against');
    expect(fixedPresentation.beliefRingStyle).toBe('solid');
  });

  // Graded-neutral node: credence exactly 0 is a REAL assessment — the
  // neutral hue, never collapsed into "no ring".
  it("threads a graded credence-0 node through as a 'neutral' ring, not as unassessed", () => {
    const [emittedNeutralNode] = emitBeliefMapNodes([
      beliefMapDbNodeFixture({ nodeId: 1, nodeTitle: 'Neutral', beliefFields: GRADED_NEUTRAL_BELIEF_FIELDS }),
    ]);
    const neutralPresentation = beliefPresentationOfEmittedNode(emittedNeutralNode);
    expect(neutralPresentation.beliefRingHue).toBe('neutral');
    expect(neutralPresentation.beliefUncertainty).toBe(0.25);
    expect(neutralPresentation.beliefAccessibleText).toBe('credence 0.00, uncertainty 0.25');
  });
});

describe('toRFNodes nodes without belief keys get the never-assessed decision', () => {
  // Older fixtures and callers produce node objects with NO belief keys at
  // all (undefined, not null). toRFNodes must treat undefined exactly like
  // null: the never-assessed decision — every ring field null, no badge,
  // the not-assessed text — and never crash.
  it('emits the never-assessed presentation for a node object carrying no belief keys', () => {
    const [emittedKeylessNode] = emitBeliefMapNodes([
      beliefMapDbNodeFixture({ nodeId: 1, nodeTitle: 'Older caller shape' }),
    ]);
    const keylessPresentation = beliefPresentationOfEmittedNode(emittedKeylessNode);
    expect(keylessPresentation).toEqual({
      beliefRingHue: null,
      beliefRingIntensityPercent: null,
      beliefRingStyle: null,
      beliefFixedBadgeShown: false,
      beliefUncertainty: null,
      beliefAccessibleText: 'belief not assessed',
    });
  });

  // Undefined must behave EXACTLY like explicit null: the keyless node's
  // presentation deep-equals the derivation of the explicit all-NULL row.
  it('makes undefined belief keys indistinguishable from explicit nulls', () => {
    const [emittedKeylessNode] = emitBeliefMapNodes([
      beliefMapDbNodeFixture({ nodeId: 1, nodeTitle: 'Older caller shape' }),
    ]);
    expect(beliefPresentationOfEmittedNode(emittedKeylessNode)).toEqual(
      deriveBeliefPresentation(NEVER_ASSESSED_NODE_BELIEF_FIELDS)
    );
  });

  // The `?? 0` pin at the map layer: a missing credence must never surface
  // as an assessed 0 — no neutral hue, no smallest-step intensity, and no
  // digit anywhere in the accessible text.
  it('never renders a missing credence as 0', () => {
    const [emittedKeylessNode] = emitBeliefMapNodes([
      beliefMapDbNodeFixture({ nodeId: 1, nodeTitle: 'Older caller shape' }),
    ]);
    const keylessPresentation = beliefPresentationOfEmittedNode(emittedKeylessNode);
    expect(keylessPresentation.beliefRingHue).not.toBe('neutral');
    expect(keylessPresentation.beliefRingIntensityPercent).not.toBe(15);
    expect(keylessPresentation.beliefAccessibleText).not.toMatch(/\d/);
  });
});

describe('toRFNodes existing node data fields survive beside beliefPresentation', () => {
  // The full-shape pin: one emitted node's data (minus layout position) must
  // be EXACTLY the six existing fields plus beliefPresentation — nothing
  // renamed, nothing dropped, nothing extra. toEqual on the whole object
  // catches all three.
  it('emits the full data shape: every existing field intact plus the new one', () => {
    // Two connected nodes so degree, connection count and prominence are all
    // non-trivial: node 1 has degree 3 (the maximum), node 2 has degree 1.
    const primaryDbNode = beliefMapDbNodeFixture({
      nodeId: 1,
      nodeTitle: 'Primary node',
      beliefFields: BELIEVED_SOLID_BELIEF_FIELDS,
    });
    const neighbourDbNode = beliefMapDbNodeFixture({ nodeId: 2, nodeTitle: 'Neighbour node' });
    // Degree per node id, as the map pane precomputes it from the edges.
    const degreeByNodeId = new Map<number, number>([
      [1, 3],
      [2, 1],
    ]);
    // Undirected neighbour sets matching those degrees' one shared edge.
    const neighboursByNodeId = new Map<number, Set<number>>([
      [1, new Set([2])],
      [2, new Set([1])],
    ]);
    const [emittedPrimaryNode] = toRFNodes({
      nodes: [primaryDbNode, neighbourDbNode],
      viewMode: 'overview',
      degreeMap: degreeByNodeId,
      adjacency: neighboursByNodeId,
      focusedGraph: null,
      centerX: 0,
      centerY: 0,
    });

    // The node identity fields around the data are untouched too.
    expect(emittedPrimaryNode.id).toBe('1');
    expect(emittedPrimaryNode.type).toBe('rahNode');

    expect(emittedPrimaryNode.data).toEqual({
      label: 'Primary node',
      edgeCount: 3,
      dbNode: primaryDbNode,
      role: 'overview',
      connectionCount: 1,
      // Degree 3 over the maximum degree 3 -> full prominence.
      prominence: 1,
      beliefPresentation: deriveBeliefPresentation(BELIEVED_SOLID_BELIEF_FIELDS),
    });
  });

  // The same check from the other end: adding beliefPresentation must not
  // perturb the derived numbers on a second, lower-degree node.
  it('keeps label, edgeCount, role, connectionCount and prominence correct on a second node', () => {
    const primaryDbNode = beliefMapDbNodeFixture({ nodeId: 1, nodeTitle: 'Primary node' });
    const neighbourDbNode = beliefMapDbNodeFixture({ nodeId: 2, nodeTitle: 'Neighbour node' });
    // Same degree and neighbour structures as the full-shape pin above.
    const degreeByNodeId = new Map<number, number>([
      [1, 3],
      [2, 1],
    ]);
    const neighboursByNodeId = new Map<number, Set<number>>([
      [1, new Set([2])],
      [2, new Set([1])],
    ]);
    const emittedNodes = toRFNodes({
      nodes: [primaryDbNode, neighbourDbNode],
      viewMode: 'overview',
      degreeMap: degreeByNodeId,
      adjacency: neighboursByNodeId,
      focusedGraph: null,
      centerX: 0,
      centerY: 0,
    });
    // The second emitted node, found by id rather than order.
    const emittedNeighbourNode = emittedNodes.find((emittedNode) => emittedNode.id === '2');
    expect(emittedNeighbourNode).toBeDefined();
    expect(emittedNeighbourNode!.data.label).toBe('Neighbour node');
    expect(emittedNeighbourNode!.data.edgeCount).toBe(1);
    expect(emittedNeighbourNode!.data.role).toBe('overview');
    expect(emittedNeighbourNode!.data.connectionCount).toBe(1);
    // Degree 1 over the maximum degree 3.
    expect(emittedNeighbourNode!.data.prominence).toBe(1 / 3);
    // And the new field rides beside them: this keyless node carries the
    // never-assessed decision (also what makes this test red today).
    expect(beliefPresentationOfEmittedNode(emittedNeighbourNode!)).toEqual(
      deriveBeliefPresentation(NEVER_ASSESSED_NODE_BELIEF_FIELDS)
    );
  });
});
