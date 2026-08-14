/**
 * Belief columns on the LIST route: GET /api/nodes (app/api/nodes/route.ts)
 * answers { success, data: Node[] } straight from nodeService.getNodes, and
 * that list read must carry all four belief columns — otherwise no caller of
 * the route (the belief UI of MR-B above all) can see any node's belief.
 * This file pins the route's JSON surface end-to-end over a real temp
 * database:
 *
 *  - every listed node object carries the four belief keys: belief_credence,
 *    belief_computed_at, belief_credence_is_fixed, belief_uncertainty,
 *  - a node whose belief columns hold a graded state (seeded directly — the
 *    display columns are written, never derived in this fork) reports its
 *    stored credence and stored uncertainty,
 *  - an ungraded node reports explicit nulls (JSON null, present keys) — a
 *    real state that must never be coerced to 0 and never dropped from the
 *    payload.
 *
 * reshaped in the display-belief-door-writable slice: the two evidence-mass
 * columns are gone from nodes, so the five-key surface became this four-key
 * one and the fixture seeds a stored belief_uncertainty instead of masses.
 *
 * Seam: tests/unit/belief/helpers/tempBeliefDatabase.ts, with the route
 * module imported dynamically AFTER the temp database opens so its transitive
 * sqlite-client import binds to the temp file. The handler reads its filters
 * from request.nextUrl.searchParams, which a plain Request does not have, so
 * the request builder shims a URL onto it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from '../belief/helpers/tempBeliefDatabase';

// One node object as the route's JSON must carry it: identity plus the four
// belief keys, each nullable state kept distinct from an absent key.
interface BeliefNodeListRouteRow {
  id: number;
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  belief_uncertainty: number | null;
}

// The exact belief key set every listed node object must carry.
const BELIEF_NODE_LIST_ROUTE_KEYS = [
  'belief_credence',
  'belief_computed_at',
  'belief_credence_is_fixed',
  'belief_uncertainty',
] as const;

// The stored display pair the graded fixture carries.
const SEEDED_GRADED_CREDENCE = 0.31;
const SEEDED_GRADED_UNCERTAINTY = 0.42;

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

// Import the route module under test, bound to THIS temp-database generation.
async function importNodesListRoute() {
  return import('../../../app/api/nodes/route');
}

// Drive the route's GET handler as the UI would call it. The handler reads
// request.nextUrl.searchParams, which a plain Request lacks, so a URL is
// shimmed onto the request object under that key.
async function getNodesListThroughRoute(): Promise<Response> {
  const { GET } = await importNodesListRoute();
  const nodesListUrl = 'http://127.0.0.1/api/nodes';
  const nodesListRequest = Object.assign(new Request(nodesListUrl, { method: 'GET' }), {
    nextUrl: new URL(nodesListUrl),
  }) as unknown as NextRequest;
  return GET(nodesListRequest);
}

// Fetch the route's node list and hand back one listed node by id.
async function readListedNodeThroughRoute(nodeId: number): Promise<BeliefNodeListRouteRow> {
  const nodesListResponse = await getNodesListThroughRoute();
  expect(nodesListResponse.status).toBe(200);
  const nodesListReply = (await nodesListResponse.json()) as {
    success: boolean;
    data: BeliefNodeListRouteRow[];
  };
  expect(nodesListReply.success).toBe(true);
  const listedNode = nodesListReply.data.find(nodeRow => nodeRow.id === nodeId);
  expect(listedNode, `node #${nodeId} must appear in the route's node list`).toBeDefined();
  return listedNode!;
}

// Seed a target node whose belief columns hold a graded state, written
// directly with SQL — the display columns are written by samai's engine
// through the display write, never derived in this fork, so the route's JSON
// surface is pinned over directly seeded column values.
function seedNodeWithGradedBeliefColumns(): number {
  // The node the route must report a graded belief state for.
  const seededTargetNodeId = tempBeliefDb.insertNodeFixture({
    title: 'Seeded graded target node the route must report belief for',
  });
  tempBeliefDb.sqlite
    .prepare(
      `UPDATE nodes
       SET belief_credence = ?, belief_computed_at = ?, belief_uncertainty = ?
       WHERE id = ?`
    )
    .run(
      SEEDED_GRADED_CREDENCE,
      '2026-07-01T00:00:00.000Z',
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

describe('GET /api/nodes belief columns on the node list', () => {
  // The route surface in one pass: a graded node's four belief keys reach
  // the JSON with the stored numbers.
  it('carries all four belief keys with the stored numbers for a graded node', async () => {
    const gradedTargetNodeId = seedNodeWithGradedBeliefColumns();

    const listedGradedNode = await readListedNodeThroughRoute(gradedTargetNodeId);

    expect(Object.keys(listedGradedNode)).toEqual(
      expect.arrayContaining([...BELIEF_NODE_LIST_ROUTE_KEYS])
    );
    expect(listedGradedNode.belief_credence).toBeCloseTo(SEEDED_GRADED_CREDENCE, 10);
    expect(listedGradedNode.belief_uncertainty).toBeCloseTo(SEEDED_GRADED_UNCERTAINTY, 10);
    expect(typeof listedGradedNode.belief_computed_at).toBe('string');
    expect(listedGradedNode.belief_credence_is_fixed).toBe(0);
  });

  // Ungraded is a real state: the keys are present and explicitly null in
  // the JSON — never 0, and never dropped (JSON.stringify drops undefined,
  // so a missing SELECT column would silently erase the keys end-to-end).
  it('carries explicit JSON nulls for an ungraded node under all four keys', async () => {
    const ungradedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Ungraded node the route must report as unassessed',
    });

    const listedUngradedNode = await readListedNodeThroughRoute(ungradedNodeId);

    // Present-and-null: the keys must survive JSON serialisation, which is
    // exactly what distinguishes a carried NULL from an omitted column.
    expect(Object.keys(listedUngradedNode)).toEqual(
      expect.arrayContaining([...BELIEF_NODE_LIST_ROUTE_KEYS])
    );
    expect(listedUngradedNode.belief_credence).toBeNull();
    expect(listedUngradedNode.belief_credence).not.toBe(0);
    expect(listedUngradedNode.belief_computed_at).toBeNull();
    expect(listedUngradedNode.belief_uncertainty).toBeNull();
    expect(listedUngradedNode.belief_credence_is_fixed).toBe(0);
  });
});
