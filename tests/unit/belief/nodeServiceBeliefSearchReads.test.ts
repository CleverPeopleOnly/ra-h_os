/**
 * SEARCHED list reads must carry the node's belief columns too:
 * nodeService.getNodes with a search term routes through searchNodesSQLite
 * (src/services/database/nodes.ts), whose candidate SELECTs (FTS, LIKE,
 * relaxed LIKE) each name their columns by hand — so a searched node list
 * could silently drop the four belief columns even after the plain list read
 * carries them. This file pins the searched path onto the same surface as the
 * plain list read (nodeServiceBeliefListReads.test.ts), against a real temp
 * database:
 *
 *  - a node whose belief columns hold a graded state (seeded directly — the
 *    display columns are written, never derived in this fork) and found by
 *    search reports its stored credence, its grading timestamp and its
 *    stored uncertainty,
 *  - an ungraded node found by search reports explicit nulls under PRESENT
 *    keys with the fixed flag 0,
 *  - a fixed-credence node found by search reports flag 1, its asserted
 *    credence, and a NULL stored uncertainty.
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

// The four belief columns of one searched node as the search read must report
// them — the same key set the plain list read pins.
interface BeliefNodeSearchReadFields {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  belief_uncertainty: number | null;
}

// The exact key set the searched list read must carry per node — asserted as
// PRESENT keys so a caller can tell "ungraded" (null) from "not reported"
// (absent).
const BELIEF_NODE_SEARCH_READ_COLUMN_NAMES = [
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

// Search the node list through the real service and hand back one node's
// belief fields by id, cast locally because searched rows arrive as Node and
// the pin is on the raw column keys.
async function searchListedNodeBeliefFieldsThroughNodeService(
  searchTerm: string,
  nodeId: number
): Promise<BeliefNodeSearchReadFields & { id: number }> {
  // The node service bound to THIS temp-database generation.
  const { nodeService } = await import('@/services/database/nodes');
  const searchedNodes = (await nodeService.getNodes({ search: searchTerm })) as unknown as Array<
    BeliefNodeSearchReadFields & { id: number }
  >;
  const searchedNode = searchedNodes.find(nodeRow => nodeRow.id === nodeId);
  expect(searchedNode, `node #${nodeId} must appear in the searched node list`).toBeDefined();
  return searchedNode!;
}

// Seed a target node whose belief columns hold a graded state, written
// directly with SQL — the display columns are written by samai's engine
// through the display write, never derived in this fork, so the read surface
// is pinned over directly seeded column values.
function seedSearchableNodeWithGradedBeliefColumns(): number {
  // The node the search read must report a graded belief state for.
  const seededTargetNodeId = tempBeliefDb.insertNodeFixture({
    title: 'Osteology target the searched read must report belief for',
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

describe('nodeService.getNodes belief columns on SEARCHED list reads', () => {
  // The searched-path gap: every search SELECT names its columns by hand, so
  // belief must ride the shared fragment there too or a searched list shows
  // no belief at all.
  it('reports all four belief columns for a seeded graded node found by search', async () => {
    const gradedTargetNodeId = seedSearchableNodeWithGradedBeliefColumns();

    const searchedGradedNode = await searchListedNodeBeliefFieldsThroughNodeService(
      'Osteology',
      gradedTargetNodeId
    );

    // The stored credence rides through untouched.
    expect(searchedGradedNode.belief_credence).toBeCloseTo(SEEDED_GRADED_CREDENCE, 10);
    // The stored uncertainty rides beside it.
    expect(searchedGradedNode.belief_uncertainty).toBeCloseTo(SEEDED_GRADED_UNCERTAINTY, 10);
    // The grading timestamp rides along.
    expect(typeof searchedGradedNode.belief_computed_at).toBe('string');
    // Nobody asserted this credence by hand: the column default is 0.
    expect(searchedGradedNode.belief_credence_is_fixed).toBe(0);
  });

  // NULL is a real state on three of the four columns and must arrive as
  // explicit nulls under PRESENT keys through the searched path too.
  it('reports an ungraded node found by search with explicit nulls under all four keys', async () => {
    const ungradedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Ungraded chirality node nobody has grounded',
    });

    const searchedUngradedNode = await searchListedNodeBeliefFieldsThroughNodeService(
      'chirality',
      ungradedNodeId
    );

    expect(searchedUngradedNode.belief_credence).toBeNull();
    expect(searchedUngradedNode.belief_credence).not.toBe(0);
    expect(searchedUngradedNode.belief_computed_at).toBeNull();
    expect(searchedUngradedNode.belief_uncertainty).toBeNull();
    expect(searchedUngradedNode.belief_credence_is_fixed).toBe(0);
    // Present-and-null: every belief key exists on the searched row, so a
    // caller can tell "ungraded" from "not reported".
    expect(Object.keys(searchedUngradedNode)).toEqual(
      expect.arrayContaining([...BELIEF_NODE_SEARCH_READ_COLUMN_NAMES])
    );
  });

  // A human-asserted credence must survive the searched path flagged as fixed
  // with its sign intact, and with a NULL stored uncertainty — an assertion
  // carries no stored uncertainty of its own (the read-as-0 rule is the
  // mapper's).
  it('reports a fixed-credence node found by search with flag 1, its negative credence, and NULL stored uncertainty', async () => {
    const fixedCredenceNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
      title: 'Handfixed axiom node whose credence a human asserted',
      beliefCredence: -0.4,
    });

    const searchedFixedNode = await searchListedNodeBeliefFieldsThroughNodeService(
      'Handfixed',
      fixedCredenceNodeId
    );

    expect(searchedFixedNode.belief_credence_is_fixed).toBe(1);
    expect(searchedFixedNode.belief_credence).toBe(-0.4);
    expect(searchedFixedNode.belief_computed_at).toBe(SEEDED_BELIEF_COMPUTED_AT);
    expect(searchedFixedNode.belief_uncertainty).toBeNull();
  });
});
