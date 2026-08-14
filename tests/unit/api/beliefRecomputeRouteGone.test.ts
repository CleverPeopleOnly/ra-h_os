/**
 * THE RECOMPUTE SURFACE DIES with the display-belief slice — REST half.
 *
 * samai owns the belief engine now, and every non-fixed recompute in the
 * interim world landed "never assessed": a recompute that still ran would
 * ERASE the display beliefs samai writes through POST /api/belief/display.
 * So POST /api/belief/recompute must stop serving recomputes: either the
 * route module is DELETED outright, or it answers 404/410 for every request.
 * This test is green under either implementation and red today, when the
 * route answers 200 and nulls the node.
 *
 * Seam: tests/unit/belief/helpers/tempBeliefDatabase.ts, route imported
 * dynamically AFTER the temp database opens (the module — if it still exists
 * — transitively imports the sqlite client).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from '../belief/helpers/tempBeliefDatabase';

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('POST /api/belief/recompute no longer serves recomputes', () => {
  // Either the module is gone (import fails — gone is gone) or every request
  // answers 404/410; a 200 recompute is the one outcome that must be
  // impossible, because it would erase samai's display writes.
  it('the recompute route is deleted or answers 404/410, and never regrades a node', async () => {
    // A real graded node, so a still-living route would demonstrably answer
    // 200 rather than hiding behind an unknown-node 404.
    const gradedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Node a recompute must no longer reach',
      beliefCredence: 0.62,
    });

    // The route module, if it still exists at all. Computed specifier, the
    // house pattern for importing a module that is ALLOWED to be gone: a
    // string-literal dynamic import would make tsc resolve the deleted path
    // and fail type-check on exactly the deletion this test celebrates.
    const recomputeRouteModuleSpecifier = '../../../app/api/belief/recompute/route';
    let recomputeRouteModule: { POST: (request: NextRequest) => Promise<Response> } | undefined;
    try {
      recomputeRouteModule = (await import(recomputeRouteModuleSpecifier)) as {
        POST: (request: NextRequest) => Promise<Response>;
      };
    } catch {
      // Deleted outright: the surface is gone, which is the point.
      return;
    }

    const recomputeRequest = new Request('http://127.0.0.1/api/belief/recompute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: gradedNodeId }),
    }) as unknown as NextRequest;
    const response = await recomputeRouteModule.POST(recomputeRequest);

    // A surviving module must refuse: gone (404) or gone-for-good (410).
    expect([404, 410]).toContain(response.status);

    // And the node's display belief survives whatever the route answered.
    const storedBeliefRow = tempBeliefDb.readNodeBelief(gradedNodeId);
    expect(storedBeliefRow.belief_credence).toBeCloseTo(0.62, 12);
  });
});
