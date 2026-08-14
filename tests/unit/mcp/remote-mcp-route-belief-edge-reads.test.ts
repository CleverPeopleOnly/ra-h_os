/**
 * Tests for the REMOTE MCP door's edge READ surface (app/api/mcp/route.ts):
 * rah_query_edges must report what the local door already reports, and must
 * stop reporting something it should never have reported.
 *
 * WHAT IS WRONG TODAY. The remote door's rah_query_edges:
 *   - renames the columns to `source_id`/`target_id`, when the fork naming
 *     rule is that MCP fields follow the column names exactly —
 *     `from_node_id`/`to_node_id`;
 *   - omits `explanation` and `created_at`;
 *   - reports a field called `weight`, taken from `context.confidence`. That
 *     number is the relationship-LABEL confidence — how sure the app is that
 *     it typed the relationship correctly — and has nothing whatever to do
 *     with belief. `weight` is also a banned word in this fork precisely
 *     because it invites being read as credence. An agent that treated this
 *     door's `weight` as an edge's belief would be badly misled;
 *   - takes neither `direction` nor `offset`, so the two doors do not even
 *     accept the same arguments.
 *
 * deleted in the evidence-leaves-the-edges-table slice: the
 * surfaces-support-and-contribution describe, and the belief-column half of
 * the advertise test — the edge tools shed the evidence read fields, pinned
 * in remote-mcp-route-edge-tools-shed-evidence.test.ts.
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
// The edge rows the stubbed app returns from GET /api/edges for the next call.
let edgeRowsTheAppReturns: Record<string, unknown>[] = [];

// One edge read as the tool reports it back to the client.
type ReportedEdge = Record<string, unknown>;

// Drive rah_query_edges and hand back the edges it reported.
async function callQueryEdgesTool(
  client: Client,
  toolArguments: Record<string, unknown> = {}
): Promise<ReportedEdge[]> {
  const toolResult = await client.callTool({ name: 'rah_query_edges', arguments: toolArguments });
  expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
  const structuredContent = toolResult.structuredContent as { edges?: ReportedEdge[] } | undefined;
  return structuredContent?.edges ?? [];
}

// The read request the stubbed app received, if any.
function findRecordedQueryEdgesRequest() {
  return remoteMcpDoorHarness
    .recordedAppRequests()
    .find((entry) => entry.method === 'GET' && entry.pathname === '/api/edges');
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  remoteMcpDoorHarness.respondWith((request) => {
    if (request.method === 'GET' && request.pathname === '/api/edges') {
      return { payload: { success: true, data: edgeRowsTheAppReturns } };
    }
    return undefined;
  });
});

afterAll(async () => {
  await remoteMcpDoorHarness.stop();
});

beforeEach(() => {
  remoteMcpDoorHarness.resetRecordedAppRequests();
  edgeRowsTheAppReturns = [];
});

describe('remote MCP door rah_query_edges reports the edge columns by their own names', () => {
  // The fork naming rule: an MCP field follows the column name exactly, so a
  // reader never has to translate between the tool and the schema.
  it('reports from_node_id and to_node_id, not source_id and target_id', async () => {
    edgeRowsTheAppReturns = [
      { id: 5, from_node_id: 2, to_node_id: 1, explanation: 'Why.', created_at: '2026-07-30T00:00:00.000Z' },
    ];

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedEdge] = await callQueryEdgesTool(client, { nodeId: 1 });

      expect(reportedEdge.from_node_id).toBe(2);
      expect(reportedEdge.to_node_id).toBe(1);
      const reportedKeys = Object.keys(reportedEdge);
      expect(reportedKeys).not.toContain('source_id');
      expect(reportedKeys).not.toContain('target_id');
    });
  });

  // The banned word. The value behind it was the relationship-label
  // confidence, so a belief-aware caller reading `weight` would take a
  // statement about the app's labelling for a statement about belief.
  it('never reports a weight field, and never surfaces the relationship-label confidence as one', async () => {
    edgeRowsTheAppReturns = [
      {
        id: 5,
        from_node_id: 2,
        to_node_id: 1,
        explanation: 'Why.',
        created_at: '2026-07-30T00:00:00.000Z',
        // The relationship-label confidence the old `weight` field was taken
        // from. It is app-owned metadata about typing the relationship.
        context: { confidence: 0.9 },
      },
    ];

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const reportedEdges = await callQueryEdgesTool(client, { nodeId: 1 });

      expect(Object.keys(reportedEdges[0])).not.toContain('weight');
      // Nothing anywhere in the reply may carry that label confidence out
      // under any name — it is not a belief quantity.
      const reportedEdgesJson = JSON.stringify(reportedEdges);
      expect(reportedEdgesJson).not.toContain('weight');
      expect(reportedEdgesJson).not.toContain('0.9');
    });
  });

  // Every edge in this graph is required to be created with an explanation,
  // and the creation timestamp is what lets a reader order the evidence.
  it('reports the explanation and created_at of an edge the app returned', async () => {
    edgeRowsTheAppReturns = [
      {
        id: 5,
        from_node_id: 2,
        to_node_id: 1,
        explanation: 'Reports a measured result that bears on the neighbouring node.',
        created_at: '2026-07-30T09:15:00.000Z',
      },
    ];

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedEdge] = await callQueryEdgesTool(client, { nodeId: 1 });

      expect(reportedEdge.explanation).toBe(
        'Reports a measured result that bears on the neighbouring node.'
      );
      expect(reportedEdge.created_at).toBe('2026-07-30T09:15:00.000Z');
    });
  });

  // An edge with no explanation must report null, never an empty string —
  // which would read as an explanation that was written and said nothing.
  it('normalises a missing or NULL explanation to null rather than an empty string', async () => {
    edgeRowsTheAppReturns = [
      // Key absent entirely.
      { id: 5, from_node_id: 2, to_node_id: 1, created_at: '2026-07-30T00:00:00.000Z' },
      // Key present and NULL.
      { id: 6, from_node_id: 3, to_node_id: 1, explanation: null, created_at: null },
    ];

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [edgeWithMissingKey, edgeWithStoredNull] = await callQueryEdgesTool(client, { nodeId: 1 });

      expect(edgeWithMissingKey.explanation).toBeNull();
      expect(edgeWithStoredNull.explanation).toBeNull();
      // The same three-state discipline on the timestamp: edge 6 stores NULL,
      // so it must report null. Asserted on the stored-NULL edge, not the
      // missing-key one — edge 5 carries a real timestamp, which the test
      // above pins as passing through verbatim.
      expect(edgeWithStoredNull.created_at).toBeNull();
    });
  });
});

describe('remote MCP door rah_query_edges takes the same arguments as the local door', () => {
  // direction and offset exist on the local door and not on this one, so the
  // same agent asking the same question of the two doors gets different
  // answers. All four arguments must reach the app.
  it('sends nodeId, direction, limit and offset to GET /api/edges', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      await callQueryEdgesTool(client, { nodeId: 1, direction: 'into', limit: 10, offset: 20 });

      const queryEdgesRequest = findRecordedQueryEdgesRequest();
      expect(queryEdgesRequest, 'the door should have read GET /api/edges').toBeDefined();
      expect(queryEdgesRequest?.searchParams).toMatchObject({
        nodeId: '1',
        direction: 'into',
        limit: '10',
        offset: '20',
      });
    });
  });

  // The default is both sides, and it is sent explicitly so the side being
  // read is visible in the request the app receives.
  it('sends a direction of both when the caller omits it', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      await callQueryEdgesTool(client, { nodeId: 1 });

      expect(findRecordedQueryEdgesRequest()?.searchParams.direction).toBe('both');
    });
  });

  // An unknown direction is a schema rejection, so no request reaches the app.
  it('rejects an unknown direction with a tool error and sends no request to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_query_edges',
        arguments: { nodeId: 1, direction: 'sideways' },
      });

      expect((toolResult as { isError?: boolean }).isError).toBe(true);
      expect(findRecordedQueryEdgesRequest()).toBeUndefined();
    });
  });

  // There is no page before the first one, so a negative offset is rejected.
  it('rejects a negative offset with a tool error and sends no request to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_query_edges',
        arguments: { nodeId: 1, offset: -1 },
      });

      expect((toolResult as { isError?: boolean }).isError).toBe(true);
      expect(findRecordedQueryEdgesRequest()).toBeUndefined();
    });
  });

  // Discoverability: the new arguments must be visible in the advertised
  // schemas, and this door must declare an output schema at all — declaring
  // none is why the drift went unnoticed.
  it('advertises direction and offset on the input schema and the edge columns on the output schema', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const queryEdgesTool = listedTools.tools.find((tool) => tool.name === 'rah_query_edges');
      expect(queryEdgesTool).toBeDefined();

      const inputSchemaJson = JSON.stringify(queryEdgesTool?.inputSchema);
      expect(inputSchemaJson).toContain('direction');
      expect(inputSchemaJson).toContain('offset');

      expect(queryEdgesTool?.outputSchema, 'rah_query_edges must declare an output schema').toBeDefined();
      const outputSchemaJson = JSON.stringify(queryEdgesTool?.outputSchema);
      expect(outputSchemaJson).toContain('from_node_id');
      expect(outputSchemaJson).toContain('to_node_id');
      expect(outputSchemaJson).toContain('explanation');
      expect(outputSchemaJson).toContain('created_at');
      // The banned word must not reappear in the advertised contract either.
      expect(outputSchemaJson).not.toContain('weight');
    });
  });

  // GUARD: reading with no arguments at all must keep working.
  it('GUARD: reads edges with no arguments at all', async () => {
    edgeRowsTheAppReturns = [
      { id: 5, from_node_id: 2, to_node_id: 1, explanation: 'Why.', created_at: '2026-07-30T00:00:00.000Z' },
    ];

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const reportedEdges = await callQueryEdgesTool(client);

      expect(reportedEdges).toHaveLength(1);
      expect(reportedEdges[0].id).toBe(5);
    });
  });
});
