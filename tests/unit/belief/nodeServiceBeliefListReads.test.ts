/**
 * LIST reads must carry the node's belief columns: nodeService.getNodes
 * (src/services/database/nodes.ts, getNodesSQLite) is the read behind
 * GET /api/nodes — the list every belief UI surface (MR-B) will render from —
 * and its SELECT today names every column EXCEPT the five belief ones:
 * belief_credence, belief_computed_at, belief_credence_is_fixed,
 * belief_evidence_for_mass and belief_evidence_against_mass. The by-id read
 * (getNodeByIdSQLite) already carries all five; this file pins the same
 * surface onto the list read, against a real temp database:
 *
 *  - a node graded VIA THE REAL ENGINE (recomputeNodeBelief over a seeded
 *    fixed-credence source and one evidence edge) reports its cached credence
 *    projection, its grading timestamp, and both persisted evidence masses —
 *    including an against-mass of exactly 0, which must never collapse into
 *    the NULL that means never assessed,
 *  - an ungraded node reports all of credence, computed_at and both masses as
 *    explicit nulls (present-and-null, never a missing key) with the fixed
 *    flag 0,
 *  - a fixed-credence node reports its asserted credence with flag 1 and
 *    masses NULL — there is no evidence ledger behind a human assertion.
 *
 * Seam: tests/unit/belief/helpers/tempBeliefDatabase.ts — the node service is
 * imported dynamically AFTER the temp database opens, so it binds to the same
 * fresh sqlite-client generation and can never touch the real database.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';
import {
  expectedBeliefCredenceProjection,
} from './helpers/beliefEvidenceMassExpectations';

// The five belief columns of one listed node as the list read must report
// them. Declared locally because the Node type does not carry the two mass
// columns yet — that missing surface is pinned separately in
// beliefNodeTypeEvidenceMassColumns.test.ts.
interface BeliefNodeListReadFields {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  belief_evidence_for_mass: number | null;
  belief_evidence_against_mass: number | null;
}

// The exact key set the list read must carry per node — asserted as PRESENT
// keys so a caller can tell "ungraded" (null) from "not reported" (absent).
const BELIEF_NODE_LIST_READ_COLUMN_NAMES = [
  'belief_credence',
  'belief_computed_at',
  'belief_credence_is_fixed',
  'belief_evidence_for_mass',
  'belief_evidence_against_mass',
] as const;

// The timestamp tempBeliefDatabase stamps on every node it seeds WITH a
// credence, so a seeded fixed-credence fixture looks already graded.
const SEEDED_BELIEF_COMPUTED_AT = '2026-07-01T00:00:00.000Z';

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

// Read the whole node list through the real service and hand back one node's
// belief fields by id, cast locally because the Node type does not declare
// the mass columns yet.
async function readListedNodeBeliefFieldsThroughNodeService(
  nodeId: number
): Promise<BeliefNodeListReadFields & { id: number }> {
  // The node service bound to THIS temp-database generation.
  const { nodeService } = await import('@/services/database/nodes');
  const listedNodes = (await nodeService.getNodes({})) as unknown as Array<
    BeliefNodeListReadFields & { id: number }
  >;
  const listedNode = listedNodes.find(nodeRow => nodeRow.id === nodeId);
  expect(listedNode, `node #${nodeId} must appear in the list read`).toBeDefined();
  return listedNode!;
}

// Seed the smallest gradeable graph — a fixed-credence source (0.8) talking
// about a target through one evidence edge (support 0.5) — and grade the
// target through the REAL engine, so the listed row carries exactly what the
// engine persisted: r = 0.8 x 0.5 = 0.4, s = 0, credence = 0.4/2.4.
async function seedAndGradeTargetNodeThroughRealEngine(): Promise<number> {
  // The bootstrap source: its human-asserted credence is the credence its
  // evidence carries.
  const fixedCredenceSourceNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
    title: 'Fixed-credence source node for the list read',
    beliefCredence: 0.8,
  });
  // The node the engine will grade and the list read must report.
  const gradedTargetNodeId = tempBeliefDb.insertNodeFixture({
    title: 'Engine-graded target node the list read must report belief for',
  });
  tempBeliefDb.insertEvidenceEdgeFixture({
    fromNodeId: fixedCredenceSourceNodeId,
    toNodeId: gradedTargetNodeId,
    support: 0.5,
  });
  // Grade through the real engine bound to this database generation, so the
  // masses and the cached projection are the engine's own writes.
  const { recomputeNodeBelief } = await tempBeliefDb.importBeliefService();
  await recomputeNodeBelief(gradedTargetNodeId);
  return gradedTargetNodeId;
}

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('nodeService.getNodes belief columns (list read behind GET /api/nodes)', () => {
  // The core gap: the list SELECT omits all five belief columns, so nothing
  // rendered from the list can show belief at all.
  it('reports all five belief columns for a node graded via the real engine', async () => {
    const gradedTargetNodeId = await seedAndGradeTargetNodeThroughRealEngine();

    const listedGradedNode =
      await readListedNodeBeliefFieldsThroughNodeService(gradedTargetNodeId);

    // The engine's persisted masses: one positive contribution of 0.4.
    expect(listedGradedNode.belief_evidence_for_mass).toBeCloseTo(0.4, 10);
    // An against-mass of exactly 0 is a graded state — never NULL.
    expect(listedGradedNode.belief_evidence_against_mass).toBe(0);
    expect(listedGradedNode.belief_evidence_against_mass).not.toBeNull();
    // The cached credence is the v2 projection of those masses.
    expect(listedGradedNode.belief_credence).toBeCloseTo(
      expectedBeliefCredenceProjection(0.4, 0),
      10
    );
    // The engine stamped its own grading timestamp.
    expect(typeof listedGradedNode.belief_computed_at).toBe('string');
    // Nobody asserted this credence by hand: the column default is 0.
    expect(listedGradedNode.belief_credence_is_fixed).toBe(0);
  });

  // NULL is a real state on four of the five columns — nobody has grounded
  // the node — and must arrive as explicit nulls under PRESENT keys, never
  // as missing keys and never coerced to 0.
  it('reports an ungraded node with explicit nulls under all five keys', async () => {
    const ungradedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Ungraded node nobody has grounded',
    });

    const listedUngradedNode =
      await readListedNodeBeliefFieldsThroughNodeService(ungradedNodeId);

    expect(listedUngradedNode.belief_credence).toBeNull();
    expect(listedUngradedNode.belief_credence).not.toBe(0);
    expect(listedUngradedNode.belief_computed_at).toBeNull();
    expect(listedUngradedNode.belief_evidence_for_mass).toBeNull();
    expect(listedUngradedNode.belief_evidence_against_mass).toBeNull();
    expect(listedUngradedNode.belief_credence_is_fixed).toBe(0);
    // Present-and-null: every belief key exists on the listed row, so a
    // caller can tell "ungraded" from "not reported".
    expect(Object.keys(listedUngradedNode)).toEqual(
      expect.arrayContaining([...BELIEF_NODE_LIST_READ_COLUMN_NAMES])
    );
  });

  // A human-asserted credence must arrive flagged as fixed with its sign
  // intact, and with masses NULL — an assertion has no evidence ledger.
  it('reports a fixed-credence node with flag 1, its negative credence, and NULL masses', async () => {
    const fixedCredenceNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
      title: 'Node whose credence a human asserted by hand',
      beliefCredence: -0.4,
    });

    const listedFixedNode =
      await readListedNodeBeliefFieldsThroughNodeService(fixedCredenceNodeId);

    expect(listedFixedNode.belief_credence_is_fixed).toBe(1);
    expect(listedFixedNode.belief_credence).toBe(-0.4);
    expect(listedFixedNode.belief_computed_at).toBe(SEEDED_BELIEF_COMPUTED_AT);
    expect(listedFixedNode.belief_evidence_for_mass).toBeNull();
    expect(listedFixedNode.belief_evidence_against_mass).toBeNull();
  });
});
