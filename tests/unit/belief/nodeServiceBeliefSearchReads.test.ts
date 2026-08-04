/**
 * SEARCHED list reads must carry the node's belief columns too:
 * nodeService.getNodes with a search term routes through searchNodesSQLite
 * (src/services/database/nodes.ts), whose candidate SELECTs (FTS, LIKE,
 * relaxed LIKE) each name their columns by hand — so a searched node list
 * could silently drop the five belief columns even after the plain list read
 * carries them. This file pins the searched path onto the same surface as the
 * plain list read (nodeServiceBeliefListReads.test.ts), against a real temp
 * database:
 *
 *  - a node graded VIA THE REAL ENGINE and found by search reports its cached
 *    credence projection, its grading timestamp and both persisted evidence
 *    masses — including an against-mass of exactly 0, never NULL,
 *  - an ungraded node found by search reports explicit nulls under PRESENT
 *    keys with the fixed flag 0,
 *  - a fixed-credence node found by search reports flag 1, its asserted
 *    credence, and NULL masses.
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

// The five belief columns of one searched node as the search read must report
// them — the same key set the plain list read pins.
interface BeliefNodeSearchReadFields {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  belief_evidence_for_mass: number | null;
  belief_evidence_against_mass: number | null;
}

// The exact key set the searched list read must carry per node — asserted as
// PRESENT keys so a caller can tell "ungraded" (null) from "not reported"
// (absent).
const BELIEF_NODE_SEARCH_READ_COLUMN_NAMES = [
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

// Seed the smallest gradeable graph — a fixed-credence source (0.8) talking
// about a searchable target through one evidence edge (support 0.5) — and
// grade the target through the REAL engine, so the searched row carries
// exactly what the engine persisted: r = 0.8 x 0.5 = 0.4, s = 0.
async function seedAndGradeSearchableTargetNodeThroughRealEngine(): Promise<number> {
  // The bootstrap source: its human-asserted credence is the credence its
  // evidence carries. Title deliberately does NOT contain the search term.
  const fixedCredenceSourceNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
    title: 'Bootstrap origin for the searched read',
    beliefCredence: 0.8,
  });
  // The node the engine will grade and the search read must report.
  const gradedTargetNodeId = tempBeliefDb.insertNodeFixture({
    title: 'Osteology target the searched read must report belief for',
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

describe('nodeService.getNodes belief columns on SEARCHED list reads', () => {
  // The searched-path gap: every search SELECT names its columns by hand, so
  // belief must ride the shared fragment there too or a searched list shows
  // no belief at all.
  it('reports all five belief columns for an engine-graded node found by search', async () => {
    const gradedTargetNodeId = await seedAndGradeSearchableTargetNodeThroughRealEngine();

    const searchedGradedNode = await searchListedNodeBeliefFieldsThroughNodeService(
      'Osteology',
      gradedTargetNodeId
    );

    // The engine's persisted masses: one positive contribution of 0.4.
    expect(searchedGradedNode.belief_evidence_for_mass).toBeCloseTo(0.4, 10);
    // An against-mass of exactly 0 is a graded state — never NULL.
    expect(searchedGradedNode.belief_evidence_against_mass).toBe(0);
    expect(searchedGradedNode.belief_evidence_against_mass).not.toBeNull();
    // The cached credence is the v2 projection of those masses.
    expect(searchedGradedNode.belief_credence).toBeCloseTo(
      expectedBeliefCredenceProjection(0.4, 0),
      10
    );
    // The engine stamped its own grading timestamp.
    expect(typeof searchedGradedNode.belief_computed_at).toBe('string');
    // Nobody asserted this credence by hand: the column default is 0.
    expect(searchedGradedNode.belief_credence_is_fixed).toBe(0);
  });

  // NULL is a real state on four of the five columns and must arrive as
  // explicit nulls under PRESENT keys through the searched path too.
  it('reports an ungraded node found by search with explicit nulls under all five keys', async () => {
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
    expect(searchedUngradedNode.belief_evidence_for_mass).toBeNull();
    expect(searchedUngradedNode.belief_evidence_against_mass).toBeNull();
    expect(searchedUngradedNode.belief_credence_is_fixed).toBe(0);
    // Present-and-null: every belief key exists on the searched row, so a
    // caller can tell "ungraded" from "not reported".
    expect(Object.keys(searchedUngradedNode)).toEqual(
      expect.arrayContaining([...BELIEF_NODE_SEARCH_READ_COLUMN_NAMES])
    );
  });

  // A human-asserted credence must survive the searched path flagged as fixed
  // with its sign intact, and with masses NULL — an assertion has no evidence
  // ledger.
  it('reports a fixed-credence node found by search with flag 1, its negative credence, and NULL masses', async () => {
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
    expect(searchedFixedNode.belief_evidence_for_mass).toBeNull();
    expect(searchedFixedNode.belief_evidence_against_mass).toBeNull();
  });
});
