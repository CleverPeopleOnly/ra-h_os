/**
 * NODE reads carry the STORED belief_uncertainty after the display-belief
 * slice: nodeService (src/services/database/nodes.ts) is the read every
 * consumer ultimately stands on (GET /api/nodes, GET /api/nodes/[id], the
 * doors' rah_get_nodes), and its SELECTs take their belief columns from
 * BELIEF_NODE_READ_COLUMNS_SQL — which now names belief_uncertainty instead
 * of the two dead mass columns.
 *
 * This file pins the service read against a real temp database:
 *  - a graded non-fixed node reports the belief_uncertainty samai stored,
 *    verbatim,
 *  - a never-assessed node reports belief_uncertainty NULL — present as an
 *    explicit null, never missing and never 0,
 *  - the list read (getNodes) carries the same stored column as the by-id
 *    read, so no consumer surface silently drops it.
 *
 * The service reports the RAW stored row — the fixed-node "uncertainty is 0"
 * rule lives in the shared node-read mapper, not in any SELECT — so no fixed
 * node appears here.
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

// The belief columns of one node as the service must report them after this
// slice. Declared locally because the Node type swap (masses out,
// belief_uncertainty in) is part of the red this file drives.
interface StoredUncertaintyNodeReadFields {
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
}

// The stored uncertainty the graded fixture carries — an arbitrary honest
// figure samai would have written beside the credence.
const STORED_GRADED_UNCERTAINTY = 0.42;

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

// Write one node's stored belief_uncertainty directly — the column samai's
// display write lands in; a plain column write, exactly like the door's.
function storeNodeBeliefUncertainty(nodeId: number, beliefUncertainty: number): void {
  tempBeliefDb.sqlite
    .prepare('UPDATE nodes SET belief_uncertainty = ? WHERE id = ?')
    .run(beliefUncertainty, nodeId);
}

// Read one node through the real service and hand back its belief fields,
// cast locally because the Node type does not declare the stored column yet.
async function readNodeThroughNodeServiceById(
  nodeId: number
): Promise<StoredUncertaintyNodeReadFields> {
  // The node service bound to THIS temp-database generation.
  const { nodeService } = await import('@/services/database/nodes');
  const nodeReadByService = await nodeService.getNodeById(nodeId);
  expect(nodeReadByService, `node #${nodeId} must exist in the fixture database`).not.toBeNull();
  return nodeReadByService as unknown as StoredUncertaintyNodeReadFields;
}

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('nodeService reads carry the stored belief_uncertainty', () => {
  // The by-id read: the stored column reaches the caller verbatim, beside the
  // credence it qualifies.
  it('getNodeById reports the stored belief_uncertainty of a graded non-fixed node', async () => {
    const gradedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Graded node with a stored uncertainty',
      beliefCredence: 0.62,
    });
    storeNodeBeliefUncertainty(gradedNodeId, STORED_GRADED_UNCERTAINTY);

    const nodeReadByService = await readNodeThroughNodeServiceById(gradedNodeId);
    expect(nodeReadByService.belief_uncertainty).toBeCloseTo(STORED_GRADED_UNCERTAINTY, 12);
    expect(nodeReadByService.belief_credence).toBeCloseTo(0.62, 12);
  });

  // Never assessed: the key is present and explicitly null — a consumer must
  // be able to tell "never assessed" from "this read dropped the column".
  it('getNodeById reports belief_uncertainty null, present and never 0, for a never-assessed node', async () => {
    const neverAssessedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Node nobody has assessed',
    });

    const nodeReadByService = await readNodeThroughNodeServiceById(neverAssessedNodeId);
    expect(nodeReadByService.belief_uncertainty).toBeNull();
    expect(nodeReadByService.belief_credence).toBeNull();
  });

  // The list read behind GET /api/nodes rides the same shared column
  // fragment, so it must carry the stored value too — per node, not smeared.
  it('getNodes carries each node\'s own stored belief_uncertainty on the list read', async () => {
    const gradedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Listed graded node',
      beliefCredence: -0.2,
    });
    storeNodeBeliefUncertainty(gradedNodeId, 0.7);
    const neverAssessedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Listed never-assessed node',
    });

    // The node service bound to THIS temp-database generation.
    const { nodeService } = await import('@/services/database/nodes');
    const listedNodes = (await nodeService.getNodes()) as unknown as Array<
      StoredUncertaintyNodeReadFields & { id: number }
    >;

    const listedGradedNode = listedNodes.find(node => node.id === gradedNodeId);
    const listedNeverAssessedNode = listedNodes.find(node => node.id === neverAssessedNodeId);
    expect(listedGradedNode?.belief_uncertainty).toBeCloseTo(0.7, 12);
    expect(listedNeverAssessedNode?.belief_uncertainty).toBeNull();
  });
});
