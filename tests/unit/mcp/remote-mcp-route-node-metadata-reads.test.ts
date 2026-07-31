/**
 * Tests for the REMOTE MCP door's node READ surface (app/api/mcp/route.ts):
 * rah_get_nodes must report the same node record the local door reports.
 *
 * WHAT IS WRONG TODAY. The remote door's rah_get_nodes returns only id, title,
 * source, link and updated_at. It drops `description` (what the artifact is
 * and why it is in the graph), `metadata` (the node's own bag, including the
 * canonical type/state keys) and `created_at`. The local door reports all
 * three, so the same agent asking the same door-agnostic question gets a
 * thinner node from the remote door and cannot tell that anything is missing.
 *
 * The metadata rule matters on its own: a node with nothing ever recorded
 * about it must report null, never an empty object. Those are different
 * states — `{}` claims a bag was written and left empty — and the local door
 * already keeps them apart.
 *
 * Seam: tests/unit/mcp/helpers/remoteMcpDoorHarness.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live harness for this file.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;
// The node records the stubbed app serves, keyed by the id in the URL.
let nodeRecordsTheAppServes: Record<string, Record<string, unknown>> = {};

// One node as the tool reports it back to the client.
type ReportedNode = Record<string, unknown>;

// A node record with every column populated, so a reader of the assertions
// can see exactly which of them the door is expected to pass on.
const fullyPopulatedNodeRecord = {
  id: 11,
  title: 'A node with everything recorded about it',
  source: 'The canonical source text.',
  description: 'What this artifact is and why it sits in the graph.',
  link: 'https://example.invalid/paper',
  metadata: { type: 'paper', state: 'read' },
  created_at: '2026-07-01T08:00:00.000Z',
  updated_at: '2026-07-30T08:00:00.000Z',
};

// A node the app returns with no metadata key at all — nothing was ever
// recorded about it.
const nodeRecordWithoutMetadata = {
  id: 12,
  title: 'A node with nothing recorded about it',
  source: null,
  description: null,
  link: null,
  created_at: '2026-07-02T08:00:00.000Z',
  updated_at: '2026-07-02T08:00:00.000Z',
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
      const nodeRecord = nodeRecordsTheAppServes[nodeIdMatch[1]];
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
  nodeRecordsTheAppServes = {};
});

describe('remote MCP door rah_get_nodes reports the whole node record', () => {
  // The three dropped columns, pinned together on a node that has all of them.
  it('reports description, metadata and created_at for a node that has them', async () => {
    nodeRecordsTheAppServes = { '11': fullyPopulatedNodeRecord };

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedNode] = await callGetNodesTool(client, [11]);

      expect(reportedNode.description).toBe(fullyPopulatedNodeRecord.description);
      expect(reportedNode.metadata).toEqual(fullyPopulatedNodeRecord.metadata);
      expect(reportedNode.created_at).toBe(fullyPopulatedNodeRecord.created_at);
    });
  });

  // "Nothing ever recorded" and "a bag written with no keys" are different
  // states, and only null says the first one.
  it('reports metadata as null rather than an empty object for a node with none stored', async () => {
    nodeRecordsTheAppServes = { '12': nodeRecordWithoutMetadata };

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedNode] = await callGetNodesTool(client, [12]);

      expect(reportedNode.metadata).toBeNull();
      expect(reportedNode.metadata).not.toEqual({});
      // Present-and-null, so a caller can see the column was considered.
      expect(Object.keys(reportedNode)).toContain('metadata');
    });
  });

  // One call must not smear one node's bag over another's absence.
  it('keeps metadata per node when one call loads a node with metadata and a node without', async () => {
    nodeRecordsTheAppServes = {
      '11': fullyPopulatedNodeRecord,
      '12': nodeRecordWithoutMetadata,
    };

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const reportedNodes = await callGetNodesTool(client, [11, 12]);

      const nodeWithMetadata = reportedNodes.find((node) => node.id === 11);
      const nodeWithoutMetadata = reportedNodes.find((node) => node.id === 12);
      expect(nodeWithMetadata?.metadata).toEqual(fullyPopulatedNodeRecord.metadata);
      expect(nodeWithoutMetadata?.metadata).toBeNull();
    });
  });

  // Discoverability, and the output schema this door has never declared.
  it('advertises description, metadata and created_at on the output schema', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const getNodesTool = listedTools.tools.find((tool) => tool.name === 'rah_get_nodes');
      expect(getNodesTool).toBeDefined();

      expect(getNodesTool?.outputSchema, 'rah_get_nodes must declare an output schema').toBeDefined();
      const outputSchemaJson = JSON.stringify(getNodesTool?.outputSchema);
      expect(outputSchemaJson).toContain('description');
      expect(outputSchemaJson).toContain('metadata');
      expect(outputSchemaJson).toContain('created_at');
    });
  });

  // GUARD: the columns this door already reported must keep being reported.
  it('GUARD: still reports id, title, source, link and updated_at', async () => {
    nodeRecordsTheAppServes = { '11': fullyPopulatedNodeRecord };

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedNode] = await callGetNodesTool(client, [11]);

      expect(reportedNode.id).toBe(fullyPopulatedNodeRecord.id);
      expect(reportedNode.title).toBe(fullyPopulatedNodeRecord.title);
      expect(reportedNode.source).toBe(fullyPopulatedNodeRecord.source);
      expect(reportedNode.link).toBe(fullyPopulatedNodeRecord.link);
      expect(reportedNode.updated_at).toBe(fullyPopulatedNodeRecord.updated_at);
    });
  });
});
