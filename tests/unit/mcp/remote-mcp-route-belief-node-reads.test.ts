/**
 * Tests for the REMOTE MCP door's node-read BELIEF surface
 * (app/api/mcp/route.ts): rah_get_nodes must report each node's three belief
 * columns — belief_credence, belief_computed_at, belief_credence_is_fixed —
 * exactly as the app returned them.
 *
 * WHY: the external belief consumer (samai-diagnostic's BeliefSystem adapter)
 * reads nodes through this door, and today the door's node mapping copies a
 * fixed field list that has no belief in it — a node's credence never leaves
 * the app no matter what the app reports. The three fields must ride the
 * shared contract (src/services/belief/beliefMcpToolContract.js) the same way
 * the edge read's belief fields already do, so the two app doors cannot
 * drift; the contract module's own behaviour is pinned in
 * tests/unit/belief/beliefMcpToolContractNodeReadFields.test.ts, and the
 * underlying app read is pinned in
 * tests/unit/belief/nodeServiceBeliefNodeReads.test.ts.
 *
 * The states pinned here are the ones the vocabulary keeps apart: a graded
 * node (a number, including its sign), an ungraded node (null — NEVER 0),
 * and a fixed-credence node (a human asserted the credence; the flag is 1).
 *
 * Seam: tests/unit/mcp/helpers/remoteMcpDoorHarness.ts — a real MCP client
 * over the real transport into the exported POST handler in process, with an
 * in-process stub standing in for the RA-H app.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live harness for this file.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;

// One node as the tool reports it back to the client.
type ReportedNode = Record<string, unknown>;

// A node the engine has graded: a positive credence with its stamp, derived
// (not fixed) — the ordinary graded state.
const gradedBeliefNodeRecord = {
  id: 21,
  title: 'Node the belief engine has graded',
  source: 'Fixture source text.',
  description: 'A node carrying an engine-derived credence.',
  link: null,
  metadata: null,
  created_at: '2026-07-01T08:00:00.000Z',
  updated_at: '2026-07-30T08:00:00.000Z',
  belief_credence: 0.62,
  belief_computed_at: '2026-07-28T09:00:00.000Z',
  belief_credence_is_fixed: 0,
};

// A node whose credence a human asserted by hand — negative, because credence
// is the only signed quantity in the system and the sign must survive the
// door.
const fixedBeliefNodeRecord = {
  id: 22,
  title: 'Node whose credence a human asserted',
  source: null,
  description: null,
  link: null,
  metadata: null,
  created_at: '2026-07-02T08:00:00.000Z',
  updated_at: '2026-07-02T08:00:00.000Z',
  belief_credence: -0.4,
  belief_computed_at: '2026-07-29T09:00:00.000Z',
  belief_credence_is_fixed: 1,
};

// A node nobody has grounded: credence NULL, no stamp, ordinary flag.
const ungradedBeliefNodeRecord = {
  id: 23,
  title: 'Node nobody has grounded',
  source: null,
  description: null,
  link: null,
  metadata: null,
  created_at: '2026-07-03T08:00:00.000Z',
  updated_at: '2026-07-03T08:00:00.000Z',
  belief_credence: null,
  belief_computed_at: null,
  belief_credence_is_fixed: 0,
};

// Every node the stubbed app serves, keyed by the id in the URL.
const beliefNodeRecordsTheAppServes: Record<string, Record<string, unknown>> = {
  '21': gradedBeliefNodeRecord,
  '22': fixedBeliefNodeRecord,
  '23': ungradedBeliefNodeRecord,
};

// Drive rah_get_nodes and hand back the nodes it reported.
async function callGetNodesTool(client: Client, nodeIds: number[]): Promise<ReportedNode[]> {
  const toolResult = await client.callTool({ name: 'rah_get_nodes', arguments: { nodeIds } });
  expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
  const structuredContent = toolResult.structuredContent as { nodes?: ReportedNode[] } | undefined;
  return structuredContent?.nodes ?? [];
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  remoteMcpDoorHarness.respondWith((request) => {
    const nodeIdMatch = /^\/api\/nodes\/(\d+)$/.exec(request.pathname);
    if (request.method === 'GET' && nodeIdMatch) {
      const nodeRecord = beliefNodeRecordsTheAppServes[nodeIdMatch[1]];
      if (!nodeRecord) {
        return undefined;
      }
      return { payload: { success: true, node: nodeRecord } };
    }
    return undefined;
  });
});

afterAll(async () => {
  await remoteMcpDoorHarness.stop();
});

beforeEach(() => {
  remoteMcpDoorHarness.resetRecordedAppRequests();
});

describe('remote MCP door rah_get_nodes belief columns', () => {
  // The core gap: a graded node's belief must leave the app at all.
  it('reports the three belief columns of a graded node verbatim', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedNode] = await callGetNodesTool(client, [gradedBeliefNodeRecord.id]);

      expect(reportedNode.belief_credence).toBe(0.62);
      expect(reportedNode.belief_computed_at).toBe('2026-07-28T09:00:00.000Z');
      expect(reportedNode.belief_credence_is_fixed).toBe(0);
    });
  });

  // A human-asserted credence arrives flagged, sign intact: a disbelieved
  // node's minus sign is what makes its evidence count against neighbours.
  it('reports a fixed-credence node with the flag 1 and its negative credence intact', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedNode] = await callGetNodesTool(client, [fixedBeliefNodeRecord.id]);

      expect(reportedNode.belief_credence_is_fixed).toBe(1);
      expect(reportedNode.belief_credence).toBe(-0.4);
    });
  });

  // NULL credence means nobody has grounded the node — a real state that
  // must arrive as an explicit null, never as 0 and never as a dropped key.
  it('reports an ungraded node with belief_credence null, present and never 0', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedNode] = await callGetNodesTool(client, [ungradedBeliefNodeRecord.id]);

      expect(Object.keys(reportedNode)).toContain('belief_credence');
      expect(reportedNode.belief_credence).toBeNull();
      expect(reportedNode.belief_credence).not.toBe(0);
      expect(reportedNode.belief_computed_at).toBeNull();
    });
  });

  // One call must not smear one node's belief over another's absence.
  it('keeps belief per node when one call loads a graded and an ungraded node', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const reportedNodes = await callGetNodesTool(client, [
        gradedBeliefNodeRecord.id,
        ungradedBeliefNodeRecord.id,
      ]);

      const reportedGradedNode = reportedNodes.find(
        (node) => node.id === gradedBeliefNodeRecord.id
      );
      const reportedUngradedNode = reportedNodes.find(
        (node) => node.id === ungradedBeliefNodeRecord.id
      );
      expect(reportedGradedNode?.belief_credence).toBe(0.62);
      expect(reportedUngradedNode?.belief_credence).toBeNull();
    });
  });

  // Discoverability: an external agent learns what a node read returns from
  // the advertised output schema, so all three belief columns must be
  // declared on it. (The SDK also validates structuredContent against this
  // schema, so mapping and schema are only usable in step.)
  it('advertises the three belief columns on the rah_get_nodes output schema', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const getNodesTool = listedTools.tools.find((tool) => tool.name === 'rah_get_nodes');
      expect(getNodesTool).toBeDefined();

      const outputSchemaJson = JSON.stringify(getNodesTool?.outputSchema);
      expect(outputSchemaJson).toContain('belief_credence');
      expect(outputSchemaJson).toContain('belief_computed_at');
      expect(outputSchemaJson).toContain('belief_credence_is_fixed');
    });
  });

  // GUARD: the columns the node read already reports must keep arriving —
  // adding belief must not disturb the rest of the record.
  it('GUARD: still reports id, title, source, description, link and the timestamps', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedNode] = await callGetNodesTool(client, [gradedBeliefNodeRecord.id]);

      expect(reportedNode).toMatchObject({
        id: gradedBeliefNodeRecord.id,
        title: gradedBeliefNodeRecord.title,
        source: gradedBeliefNodeRecord.source,
        description: gradedBeliefNodeRecord.description,
        link: null,
        created_at: gradedBeliefNodeRecord.created_at,
        updated_at: gradedBeliefNodeRecord.updated_at,
      });
    });
  });
});
