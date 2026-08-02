/**
 * NODE reads must carry the node's belief columns: nodeService.getNodeById
 * (src/services/database/nodes.ts) is the read both app-backed MCP doors'
 * rah_get_nodes ultimately stands on (door -> GET /api/nodes/[id] -> this
 * service), and its SELECT currently names every column EXCEPT
 * belief_credence, belief_computed_at and belief_credence_is_fixed — so no
 * door can report a node's belief no matter what its own mapping does.
 *
 * This file pins the service read against a real temp database:
 *  - a graded node reports its credence and the timestamp it was stamped,
 *  - an ungraded node reports belief_credence NULL — a real state that must
 *    never be coerced to 0,
 *  - a node graded to exactly 0 reports 0 — assessed and believed neither
 *    way, which must never collapse into the null that means ungraded,
 *  - a fixed-credence node reports belief_credence_is_fixed 1 with its
 *    asserted (here negative) credence intact — credence is the only signed
 *    quantity in the system and the sign must survive the read.
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

// The belief columns of one node as the service must report them. Declared
// locally because the Node type does not carry them yet — that missing
// surface is part of the red this file drives.
interface BeliefNodeReadFields {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
}

// The timestamp tempBeliefDatabase stamps on every node it seeds WITH a
// credence, so a graded fixture looks like a node the engine already graded.
const SEEDED_BELIEF_COMPUTED_AT = '2026-07-01T00:00:00.000Z';

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

// Read one node through the real service and hand back its belief fields,
// cast locally because the Node type does not declare them yet.
async function readNodeBeliefFieldsThroughNodeService(
  nodeId: number
): Promise<BeliefNodeReadFields> {
  // The node service bound to THIS temp-database generation.
  const { nodeService } = await import('@/services/database/nodes');
  const nodeReadByService = await nodeService.getNodeById(nodeId);
  expect(nodeReadByService, `node #${nodeId} must exist in the fixture database`).not.toBeNull();
  return nodeReadByService as unknown as BeliefNodeReadFields;
}

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('nodeService.getNodeById belief columns', () => {
  // The core gap: a graded node's credence and grading timestamp must reach
  // the service's caller at all.
  it('reports the credence and computed_at of a graded node, with the fixed flag 0', async () => {
    const gradedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Graded node the service must report belief for',
      beliefCredence: 0.62,
    });

    const beliefNodeRead = await readNodeBeliefFieldsThroughNodeService(gradedNodeId);

    expect(beliefNodeRead.belief_credence).toBe(0.62);
    expect(beliefNodeRead.belief_computed_at).toBe(SEEDED_BELIEF_COMPUTED_AT);
    // Nobody asserted this credence by hand: the column default is 0.
    expect(beliefNodeRead.belief_credence_is_fixed).toBe(0);
  });

  // NULL credence is a real state — nobody has grounded the node — and must
  // arrive as an explicit null, never as 0 and never as a missing key.
  it('reports an ungraded node with belief_credence null, never 0', async () => {
    const ungradedNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Ungraded node nobody has grounded',
    });

    const beliefNodeRead = await readNodeBeliefFieldsThroughNodeService(ungradedNodeId);

    expect(beliefNodeRead.belief_credence).toBeNull();
    expect(beliefNodeRead.belief_credence).not.toBe(0);
    expect(beliefNodeRead.belief_computed_at).toBeNull();
    // Present-and-null, so a caller can tell "ungraded" from "not reported".
    expect(Object.keys(beliefNodeRead)).toContain('belief_credence');
  });

  // The mirror-image state: a credence of exactly 0 is a recorded grading —
  // assessed, and believed neither way — and must never read as ungraded.
  it('reports a node graded to exactly 0 as 0, never null', async () => {
    const zeroCredenceNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Node assessed and believed neither way',
      beliefCredence: 0,
    });

    const beliefNodeRead = await readNodeBeliefFieldsThroughNodeService(zeroCredenceNodeId);

    expect(beliefNodeRead.belief_credence).toBe(0);
    expect(beliefNodeRead.belief_credence).not.toBeNull();
  });

  // A human-asserted credence must arrive flagged as fixed, and its sign must
  // survive: a disbelieved node's negative credence is exactly what makes its
  // evidence count against its neighbours.
  it('reports a fixed-credence node with the flag 1 and its negative credence intact', async () => {
    const fixedCredenceNodeId = tempBeliefDb.insertFixedBeliefCredenceNodeFixture({
      title: 'Node whose credence a human asserted by hand',
      beliefCredence: -0.4,
    });

    const beliefNodeRead = await readNodeBeliefFieldsThroughNodeService(fixedCredenceNodeId);

    expect(beliefNodeRead.belief_credence_is_fixed).toBe(1);
    expect(beliefNodeRead.belief_credence).toBe(-0.4);
    expect(beliefNodeRead.belief_computed_at).toBe(SEEDED_BELIEF_COMPUTED_AT);
  });
});
