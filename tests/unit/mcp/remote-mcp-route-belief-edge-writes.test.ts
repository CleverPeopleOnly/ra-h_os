/**
 * Tests for the REMOTE MCP door's belief-evidence WRITE surface
 * (app/api/mcp/route.ts): rah_create_edge and rah_update_edge must accept
 * belief_evidence_support and forward it to the app, exactly as the local door
 * (apps/mcp-server/stdio-server.js) already does.
 *
 * WHY: every belief change this fork has made landed on the local door only.
 * The remote door does not accept belief_evidence_support on either write tool
 * at all, so an external agent talking to it can create and correct edges but
 * can never record evidence — the two doors disagree about what a belief write
 * even is. Both take the support schema from the one shared contract in
 * src/services/belief/beliefMcpToolContract.js so they cannot drift again.
 *
 * The support rules pinned here are the same ones the local door already
 * honours: UNSIGNED 0..1, because a source node's credence is the only signed
 * quantity in the system; exactly 0 ACCEPTED and forwarded, because NULL means
 * never assessed while 0 means assessed and carrying nothing, and a classifier
 * that genuinely finds no bearing must not have to invent one.
 *
 * Seam: tests/unit/mcp/helpers/remoteMcpDoorHarness.ts — a real MCP client
 * over the real transport into the exported POST handler in process, with an
 * in-process stub standing in for the RA-H app and recording every request.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live harness for this file.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;

// The edge id the update tool corrects throughout this file.
const CORRECTED_EDGE_ID = 42;
// The explanation every write in this file sends, so assertions can name it.
const EDGE_EXPLANATION = 'Reports a measured result that bears on the neighbouring node.';

// In-range supports both write tools must accept and forward verbatim. The
// boundaries carry the meaning: 0 is an assessed "carries nothing", 1 is the
// strongest the source can talk about its neighbour.
const acceptedSupportValues = [0, 0.5, 1];
// Supports outside the unsigned range, which must never reach the app.
const rejectedSupportValues = [-0.9, -1, -1.5, 1.5, 2];

// Ask the remote door to create an edge, optionally carrying evidence.
async function callCreateEdgeTool(
  client: Client,
  extraArguments: Record<string, unknown> = {},
  confirmedByUser = true
) {
  return client.callTool({
    name: 'rah_create_edge',
    arguments: {
      sourceId: 2,
      targetId: 1,
      explanation: EDGE_EXPLANATION,
      confirmed_by_user: confirmedByUser,
      ...extraArguments,
    },
  });
}

// Ask the remote door to correct an edge, optionally carrying a new support.
async function callUpdateEdgeTool(
  client: Client,
  extraArguments: Record<string, unknown> = {},
  confirmedByUser = true
) {
  return client.callTool({
    name: 'rah_update_edge',
    arguments: {
      id: CORRECTED_EDGE_ID,
      explanation: EDGE_EXPLANATION,
      confirmed_by_user: confirmedByUser,
      ...extraArguments,
    },
  });
}

// The create request the stubbed app received, if any.
function findRecordedCreateEdgeRequest() {
  return remoteMcpDoorHarness
    .recordedAppRequests()
    .find((entry) => entry.method === 'POST' && entry.pathname === '/api/edges');
}

// The correction request the stubbed app received, if any.
function findRecordedUpdateEdgeRequest() {
  return remoteMcpDoorHarness
    .recordedAppRequests()
    .find((entry) => entry.method === 'PUT' && entry.pathname === `/api/edges/${CORRECTED_EDGE_ID}`);
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  // Answer both edge-write endpoints with a plain success so every tool call
  // completes and the assertions can be about the request that was sent.
  remoteMcpDoorHarness.respondWith((request) => {
    if (request.method === 'POST' && request.pathname === '/api/edges') {
      return {
        status: 201,
        payload: { success: true, data: { id: CORRECTED_EDGE_ID }, message: 'Edge created' },
      };
    }
    if (request.method === 'PUT' && request.pathname === `/api/edges/${CORRECTED_EDGE_ID}`) {
      return { payload: { success: true, message: 'Edge updated' } };
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

describe('remote MCP door rah_create_edge evidence writes', () => {
  // The core gap: the remote door cannot write evidence at all today.
  it('forwards an in-range belief_evidence_support in the POST body', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await callCreateEdgeTool(client, { belief_evidence_support: 0.9 });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const createEdgeRequest = findRecordedCreateEdgeRequest();
      expect(createEdgeRequest, 'the door should have POSTed to /api/edges').toBeDefined();
      expect(createEdgeRequest?.body).toMatchObject({
        from_node_id: 2,
        to_node_id: 1,
        explanation: EDGE_EXPLANATION,
        created_via: 'mcp',
        confirmed_by_user: true,
        belief_evidence_support: 0.9,
      });
    });
  });

  // Both boundaries are legitimate. A 0 that arrived as an omitted field would
  // reach the app as "not evidence" instead of "assessed, carries nothing".
  it('accepts every in-range support including both boundaries and forwards the key verbatim', async () => {
    for (const acceptedSupport of acceptedSupportValues) {
      remoteMcpDoorHarness.resetRecordedAppRequests();
      await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
        const toolResult = await callCreateEdgeTool(client, {
          belief_evidence_support: acceptedSupport,
        });

        expect(
          (toolResult as { isError?: boolean }).isError ?? false,
          `a support of ${acceptedSupport} must be accepted`
        ).toBe(false);
        const createEdgeRequest = findRecordedCreateEdgeRequest();
        expect(Object.keys(createEdgeRequest?.body ?? {})).toContain('belief_evidence_support');
        expect(createEdgeRequest?.body?.belief_evidence_support).toBe(acceptedSupport);
      });
    }
  });

  // Out-of-range supports must be refused by the schema, so no request is ever
  // made. Negatives are the semantic case: direction lives on the source
  // node's credence, never on support.
  it('rejects every out-of-range belief_evidence_support and sends no request to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      for (const rejectedSupport of rejectedSupportValues) {
        const toolResult = await callCreateEdgeTool(client, {
          belief_evidence_support: rejectedSupport,
        });

        expect(
          (toolResult as { isError?: boolean }).isError,
          `a support of ${rejectedSupport} must be rejected — support is unsigned and capped at 1`
        ).toBe(true);
      }
      expect(findRecordedCreateEdgeRequest()).toBeUndefined();
    });
  });

  // GUARD: a plain relationship edge must keep an evidence-free payload. A
  // support key invented for it would turn it into assessed evidence.
  it('GUARD: sends an evidence-free payload when no support is supplied', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await callCreateEdgeTool(client);

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const createEdgeRequest = findRecordedCreateEdgeRequest();
      expect(createEdgeRequest, 'the door should have POSTed to /api/edges').toBeDefined();
      expect(Object.keys(createEdgeRequest?.body ?? {})).not.toContain('belief_evidence_support');
    });
  });

  // GUARD: the confirmation gate is unchanged by the evidence work — an
  // unconfirmed create still fails and still writes nothing.
  it('GUARD: refuses an unconfirmed create even when it carries a valid support', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await callCreateEdgeTool(client, { belief_evidence_support: 0.9 }, false);

      expect((toolResult as { isError?: boolean }).isError).toBe(true);
      expect(findRecordedCreateEdgeRequest()).toBeUndefined();
    });
  });

  // Discoverability: an external agent must be able to learn from the
  // advertised schema that it can record evidence here, and that confirmation
  // is still required.
  it('advertises belief_evidence_support and a required confirmed_by_user on the input schema', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const createEdgeTool = listedTools.tools.find((tool) => tool.name === 'rah_create_edge');
      expect(createEdgeTool).toBeDefined();

      const inputSchemaJson = JSON.stringify(createEdgeTool?.inputSchema);
      expect(inputSchemaJson).toContain('belief_evidence_support');
      // The merged-away pair must never appear on a belief write door.
      expect(inputSchemaJson).not.toContain('belief_evidence_direction');
      expect(inputSchemaJson).not.toContain('belief_evidence_strength');
      expect(createEdgeTool?.inputSchema?.required as string[]).toContain('confirmed_by_user');
      // The door declares no output schemas at all today, which is why the
      // drift went unnoticed for so long.
      expect(createEdgeTool?.outputSchema, 'rah_create_edge must declare an output schema').toBeDefined();
    });
  });
});

describe('remote MCP door rah_update_edge support correction', () => {
  // A support written once must be correctable, and the corrected value
  // belongs to the edges column — so it rides TOP-LEVEL in the PUT body, never
  // inside the app-owned context JSON.
  it('forwards a corrected belief_evidence_support as a top-level field of the PUT body', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await callUpdateEdgeTool(client, { belief_evidence_support: 0.6 });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(updateEdgeRequest, 'the door should have PUT to /api/edges/<id>').toBeDefined();
      expect(updateEdgeRequest?.body).toMatchObject({
        context: { explanation: EDGE_EXPLANATION, created_via: 'mcp' },
        confirmed_by_user: true,
        belief_evidence_support: 0.6,
      });
      // Explicitly NOT inside context: the app reads the column from the top
      // level, so a support buried in context would be silently discarded.
      const correctedContext = updateEdgeRequest?.body?.context as Record<string, unknown>;
      expect(Object.keys(correctedContext)).not.toContain('belief_evidence_support');
    });
  });

  // The same boundary rule as create: 0 is a recordable correction.
  it('accepts every in-range support including both boundaries and forwards the key verbatim', async () => {
    for (const acceptedSupport of acceptedSupportValues) {
      remoteMcpDoorHarness.resetRecordedAppRequests();
      await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
        const toolResult = await callUpdateEdgeTool(client, {
          belief_evidence_support: acceptedSupport,
        });

        expect(
          (toolResult as { isError?: boolean }).isError ?? false,
          `a corrected support of ${acceptedSupport} must be accepted`
        ).toBe(false);
        const updateEdgeRequest = findRecordedUpdateEdgeRequest();
        expect(Object.keys(updateEdgeRequest?.body ?? {})).toContain('belief_evidence_support');
        expect(updateEdgeRequest?.body?.belief_evidence_support).toBe(acceptedSupport);
      });
    }
  });

  // Out-of-range corrections are refused before any request is made.
  it('rejects every out-of-range corrected support and sends no request to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      for (const rejectedSupport of rejectedSupportValues) {
        const toolResult = await callUpdateEdgeTool(client, {
          belief_evidence_support: rejectedSupport,
        });

        expect(
          (toolResult as { isError?: boolean }).isError,
          `a corrected support of ${rejectedSupport} must be rejected`
        ).toBe(true);
      }
      expect(findRecordedUpdateEdgeRequest()).toBeUndefined();
    });
  });

  // GUARD: the confirmation gate still applies to a support correction.
  it('GUARD: refuses an unconfirmed correction even when it carries a valid support', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await callUpdateEdgeTool(client, { belief_evidence_support: 0.6 }, false);

      expect((toolResult as { isError?: boolean }).isError).toBe(true);
      expect(findRecordedUpdateEdgeRequest()).toBeUndefined();
    });
  });

  // GUARD: correcting only the explanation must not invent evidence, which
  // would turn a plain relationship edge into assessed evidence.
  it('GUARD: an explanation-only correction sends no support key at all', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await callUpdateEdgeTool(client);

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(updateEdgeRequest, 'the door should have PUT to /api/edges/<id>').toBeDefined();
      expect(Object.keys(updateEdgeRequest?.body ?? {})).not.toContain('belief_evidence_support');
    });
  });

  // Discoverability for the correction path, and the missing output schema.
  it('advertises belief_evidence_support and a required confirmed_by_user on the input schema', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const updateEdgeTool = listedTools.tools.find((tool) => tool.name === 'rah_update_edge');
      expect(updateEdgeTool).toBeDefined();

      const inputSchemaJson = JSON.stringify(updateEdgeTool?.inputSchema);
      expect(inputSchemaJson).toContain('belief_evidence_support');
      expect(inputSchemaJson).not.toContain('belief_evidence_direction');
      expect(inputSchemaJson).not.toContain('belief_evidence_strength');
      expect(updateEdgeTool?.inputSchema?.required as string[]).toContain('confirmed_by_user');
      expect(updateEdgeTool?.outputSchema, 'rah_update_edge must declare an output schema').toBeDefined();
    });
  });
});
