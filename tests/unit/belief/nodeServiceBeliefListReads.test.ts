/**
 * LIST reads must carry the node's belief columns: nodeService.getNodes
 * (src/services/database/nodes.ts, getNodesSQLite) is the read behind
 * GET /api/nodes — the list every belief UI surface (MR-B) will render from —
 * and it must name every one of the four belief columns:
 * belief_credence, belief_computed_at, belief_credence_is_fixed and
 * belief_uncertainty. The by-id read (getNodeByIdSQLite) already carries all
 * four; this file pins the same surface onto the list read, against a real
 * temp database:
 *
 *  - a node whose belief columns hold a graded state (seeded directly — the
 *    engine left this fork in the display-belief-door-writable slice, so the
 *    display columns are written, never derived) reports its stored credence,
 *    its grading timestamp and its stored uncertainty,
 *  - an ungraded node reports credence, computed_at and uncertainty as
 *    explicit nulls (present-and-null, never a missing key) with the fixed
 *    flag 0,
 *  - a fixed-credence node reports its asserted credence with flag 1 and a
 *    NULL stored uncertainty — the fixed-node "reads as 0" rule lives in the
 *    shared contract's node-read mapper, never in the SELECT.
 *
 * reshaped in the display-belief-door-writable slice: the two evidence-mass
 * columns are gone from nodes, so the five-key surface became this four-key
 * one and the fixtures seed a stored belief_uncertainty instead of masses.
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

// The four belief columns of one listed node as the list read must report
// them.
interface BeliefNodeListReadFields {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  belief_uncertainty: number | null;
}

// The exact key set the list read must carry per node — asserted as PRESENT
// keys so a caller can tell "ungraded" (null) from "not reported" (absent).
const BELIEF_NODE_LIST_READ_COLUMN_NAMES = [
  'belief_credence',
  'belief_computed_at',
  'belief_credence_is_fixed',
  'belief_uncertainty',
] as const;

// The timestamp tempBeliefDatabase stamps on every node it seeds WITH a
// credence, so a seeded fixed-credence fixture looks already graded.
const SEEDED_BELIEF_COMPUTED_AT = '2026-07-01T00:00:00.000Z';

// The stored display pair the graded fixture carries.
const SEEDED_GRADED_CREDENCE = 0.31;
const SEEDED_GRADED_UNCERTAINTY = 0.42;

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

// Read the whole node list through the real service and hand back one node's
// belief fields by id, cast locally over the service's row type.
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

// Seed a target node whose belief columns hold a graded state, written
// directly with SQL — the display columns are written by samai's engine
// through the display write, never derived in this fork, so the read surface
// is pinned over directly seeded column values.
function seedNodeWithGradedBeliefColumns(): number {
  // The node the list read must report a graded belief state for.
  const seededTargetNodeId = tempBeliefDb.insertNodeFixture({
    title: 'Seeded graded node the list read must report belief for',
  });
  tempBeliefDb.sqlite
    .prepare(
      `UPDATE nodes
       SET belief_credence = ?, belief_computed_at = ?, belief_uncertainty = ?
       WHERE id = ?`
    )
    .run(
      SEEDED_GRADED_CREDENCE,
      SEEDED_BELIEF_COMPUTED_AT,
      SEEDED_GRADED_UNCERTAINTY,
      seededTargetNodeId
    );
  return seededTargetNodeId;
}

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('nodeService.getNodes belief columns (list read behind GET /api/nodes)', () => {
  // The core gap: a list SELECT that omits the belief columns leaves nothing
  // rendered from the list able to show belief at all.
  it('reports all four belief columns for a node with a seeded graded state', async () => {
    const gradedTargetNodeId = seedNodeWithGradedBeliefColumns();

    const listedGradedNode =
      await readListedNodeBeliefFieldsThroughNodeService(gradedTargetNodeId);

    // The stored credence rides through untouched.
    expect(listedGradedNode.belief_credence).toBeCloseTo(SEEDED_GRADED_CREDENCE, 10);
    // The stored uncertainty rides beside it.
    expect(listedGradedNode.belief_uncertainty).toBeCloseTo(SEEDED_GRADED_UNCERTAINTY, 10);
    // The grading timestamp rides along.
    expect(typeof listedGradedNode.belief_computed_at).toBe('string');
    // Nobody asserted this credence by hand: the column default is 0.
    expect(listedGradedNode.belief_credence_is_fixed).toBe(0);
  });

  // NULL is a real state on three of the four columns — nobody has grounded
  // the node — and must arrive as explicit nulls under PRESENT keys, never
  // as missing keys and never coerced to 0.
  it('reports an ungraded node with explicit nulls under all four keys', async () => {
    const ungradedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Ungraded node nobody has grounded',
    });

    const listedUngradedNode =
      await readListedNodeBeliefFieldsThroughNodeService(ungradedNodeId);

    expect(listedUngradedNode.belief_credence).toBeNull();
    expect(listedUngradedNode.belief_credence).not.toBe(0);
    expect(listedUngradedNode.belief_computed_at).toBeNull();
    expect(listedUngradedNode.belief_uncertainty).toBeNull();
    expect(listedUngradedNode.belief_credence_is_fixed).toBe(0);
    // Present-and-null: every belief key exists on the listed row, so a
    // caller can tell "ungraded" from "not reported".
    expect(Object.keys(listedUngradedNode)).toEqual(
      expect.arrayContaining([...BELIEF_NODE_LIST_READ_COLUMN_NAMES])
    );
  });

  // A human-asserted credence must arrive flagged as fixed with its sign
  // intact, and with a NULL stored uncertainty — an assertion carries no
  // stored uncertainty of its own (the read-as-0 rule is the mapper's).
  it('reports a fixed-credence node with flag 1, its negative credence, and NULL stored uncertainty', async () => {
    const fixedCredenceNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
      title: 'Node whose credence a human asserted by hand',
      beliefCredence: -0.4,
    });

    const listedFixedNode =
      await readListedNodeBeliefFieldsThroughNodeService(fixedCredenceNodeId);

    expect(listedFixedNode.belief_credence_is_fixed).toBe(1);
    expect(listedFixedNode.belief_credence).toBe(-0.4);
    expect(listedFixedNode.belief_computed_at).toBe(SEEDED_BELIEF_COMPUTED_AT);
    expect(listedFixedNode.belief_uncertainty).toBeNull();
  });
});
