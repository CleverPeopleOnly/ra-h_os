/**
 * FAILING-FIRST tests for the evidence-leaves-the-edges-table slice on the
 * REMOTE MCP door (app/api/mcp/route.ts): THE EDGE TOOLS NO LONGER SPEAK
 * EVIDENCE.
 *
 * Belief evidence moved out of this fork into samai's own store, so an edge
 * is a plain knowledge-graph relationship on every door. This file pins the
 * remote door's edge-tool surface:
 *
 *  - rah_create_edge and rah_update_edge no longer advertise
 *    belief_evidence_support on their input schemas, and rah_query_edges no
 *    longer advertises either evidence field on its per-edge output schema,
 *  - a STALE caller still sending belief_evidence_support on either write is
 *    NOT an error — the key simply is not part of the contract, so the call
 *    succeeds and the request forwarded to the app carries no evidence key,
 *  - rah_query_edges answers carry NEITHER evidence field, even when the app
 *    behind the door still reports rows bearing them.
 *
 * Seam: the shared remote-door harness (helpers/remoteMcpDoorHarness.ts) — a
 * real MCP client in front of the exported POST handler, an in-process HTTP
 * stub standing in for the running RA-H app behind. No real app and no
 * database is involved.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The evidence field the write tools must no longer advertise or forward.
const removedEdgeWriteEvidenceFieldName = 'belief_evidence_support';

// The two evidence fields an edge read answer must no longer carry.
const removedEdgeReadEvidenceFieldNames = [
  'belief_evidence_support',
  'belief_evidence_contribution',
];

// The live harness for this file.
let doorHarness: RemoteMcpDoorHarness;

beforeAll(async () => {
  doorHarness = await startRemoteMcpDoorHarness();
});

afterAll(async () => {
  await doorHarness.stop();
});

beforeEach(() => {
  doorHarness.resetRecordedAppRequests();
});

// Property names a tool's advertised input schema declares.
function inputSchemaPropertyNames(advertisedTool: {
  inputSchema?: { properties?: Record<string, unknown> };
}): string[] {
  return Object.keys(advertisedTool.inputSchema?.properties ?? {});
}

// Property names of the per-edge item object inside an edge-read tool's
// advertised output schema.
function edgeReadItemPropertyNames(advertisedTool: {
  outputSchema?: {
    properties?: Record<string, { items?: { properties?: Record<string, unknown> } }>;
  };
}): string[] {
  return Object.keys(advertisedTool.outputSchema?.properties?.edges?.items?.properties ?? {});
}

// Extract a tool call's structured content with a caller-chosen shape.
function getStructured<T>(result: unknown): T {
  return (result as { structuredContent?: unknown }).structuredContent as T;
}

describe('remote MCP door edge tools shed evidence', () => {
  // The advertised surface: neither write tool takes a support any more, and
  // the read tool's per-edge answer object no longer declares either field.
  it('the edge tools no longer advertise any evidence field', async () => {
    const advertisedTools = await doorHarness.withRemoteMcpClient(
      async (client) => (await client.listTools()).tools
    );

    for (const edgeWriteToolName of ['rah_create_edge', 'rah_update_edge']) {
      const edgeWriteTool = advertisedTools.find((tool) => tool.name === edgeWriteToolName);
      expect(edgeWriteTool, `${edgeWriteToolName} must still exist`).toBeDefined();
      expect(
        inputSchemaPropertyNames(edgeWriteTool!),
        `${edgeWriteToolName} must not advertise ${removedEdgeWriteEvidenceFieldName}`
      ).not.toContain(removedEdgeWriteEvidenceFieldName);
    }

    const edgeReadTool = advertisedTools.find((tool) => tool.name === 'rah_query_edges');
    expect(edgeReadTool, 'rah_query_edges must still exist').toBeDefined();
    for (const removedFieldName of removedEdgeReadEvidenceFieldNames) {
      expect(
        edgeReadItemPropertyNames(edgeReadTool!),
        `rah_query_edges must not advertise ${removedFieldName} per edge`
      ).not.toContain(removedFieldName);
    }
  });

  // The stale-caller create: the key is stripped by the schema, the tool
  // succeeds, and the app never sees an evidence key.
  it('rah_create_edge tolerates a stale belief_evidence_support and forwards no evidence key', async () => {
    doorHarness.respondWith((request) => {
      if (request.method === 'POST' && request.pathname === '/api/edges') {
        return {
          status: 201,
          payload: {
            success: true,
            data: { id: 42, from_node_id: 1, to_node_id: 2, explanation: 'came from the fixture source' },
            message: 'Edge created successfully',
          },
        };
      }
      return undefined;
    });

    const createResult = await doorHarness.withRemoteMcpClient((client) =>
      client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 1,
          targetId: 2,
          explanation: 'came from the fixture source',
          confirmed_by_user: true,
          // The stale caller's key: no longer part of the contract, silently
          // ignored rather than refused.
          belief_evidence_support: 0.9,
        },
      })
    );

    // The call succeeded like any plain create.
    expect(getStructured<{ success: boolean; edgeId: number }>(createResult)).toMatchObject({
      success: true,
      edgeId: 42,
    });

    // The forwarded request body carries NO evidence key at all.
    const forwardedEdgeCreateRequest = doorHarness
      .recordedAppRequests()
      .find((request) => request.method === 'POST' && request.pathname === '/api/edges');
    expect(forwardedEdgeCreateRequest, 'the create must reach the app').toBeDefined();
    expect(
      Object.keys(forwardedEdgeCreateRequest!.body ?? {}),
      'the forwarded create body must not carry an evidence key'
    ).not.toContain(removedEdgeWriteEvidenceFieldName);
  });

  // The stale-caller update: same tolerance, same clean forwarded body.
  it('rah_update_edge tolerates a stale belief_evidence_support and forwards no evidence key', async () => {
    doorHarness.respondWith((request) => {
      if (request.method === 'PUT' && request.pathname === '/api/edges/7') {
        return {
          payload: {
            success: true,
            data: { id: 7, from_node_id: 1, to_node_id: 2, explanation: 'corrected fixture explanation' },
            message: 'Edge updated successfully',
          },
        };
      }
      return undefined;
    });

    const updateResult = await doorHarness.withRemoteMcpClient((client) =>
      client.callTool({
        name: 'rah_update_edge',
        arguments: {
          id: 7,
          explanation: 'corrected fixture explanation',
          confirmed_by_user: true,
          // The stale caller's key, ignored exactly as on create.
          belief_evidence_support: 0.4,
        },
      })
    );

    expect(getStructured<{ success: boolean; edgeId: number }>(updateResult)).toMatchObject({
      success: true,
      edgeId: 7,
    });

    const forwardedEdgeUpdateRequest = doorHarness
      .recordedAppRequests()
      .find((request) => request.method === 'PUT' && request.pathname === '/api/edges/7');
    expect(forwardedEdgeUpdateRequest, 'the update must reach the app').toBeDefined();
    expect(
      Object.keys(forwardedEdgeUpdateRequest!.body ?? {}),
      'the forwarded update body must not carry an evidence key'
    ).not.toContain(removedEdgeWriteEvidenceFieldName);
  });

  // The read answer: even when the app behind the door still reports rows
  // bearing evidence values (a not-yet-migrated store), the tool's answer
  // carries neither field — the contract shed them, whatever the app says.
  it('rah_query_edges answers edges without either evidence field', async () => {
    doorHarness.respondWith((request) => {
      if (request.method === 'GET' && request.pathname === '/api/edges') {
        return {
          payload: {
            success: true,
            data: [
              {
                id: 11,
                from_node_id: 1,
                to_node_id: 2,
                context: { type: 'source_of' },
                explanation: 'came from the fixture source',
                created_at: '2026-06-01T00:00:00.000Z',
                // A legacy app answer still carrying evidence values: the
                // door must not relay them.
                belief_evidence_support: 0.9,
                belief_evidence_contribution: 0.72,
              },
            ],
          },
        };
      }
      return undefined;
    });

    const queryResult = await doorHarness.withRemoteMcpClient((client) =>
      client.callTool({ name: 'rah_query_edges', arguments: { nodeId: 1 } })
    );

    const answeredEdges = getStructured<{ edges: Array<Record<string, unknown>> }>(
      queryResult
    ).edges;
    expect(answeredEdges).toHaveLength(1);
    for (const removedFieldName of removedEdgeReadEvidenceFieldNames) {
      expect(
        Object.prototype.hasOwnProperty.call(answeredEdges[0], removedFieldName),
        `rah_query_edges answer must not carry ${removedFieldName}`
      ).toBe(false);
    }
  });
});
