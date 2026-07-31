/**
 * Correcting ONLY an edge's support through the REMOTE MCP door
 * (app/api/mcp/route.ts, tool rah_update_edge).
 *
 * The same behaviour tests/unit/mcp/stdio-server-support-only-edge-correction.test.ts
 * pins on the local door, pinned again here because the two doors declare their
 * tools in two separate files and that is exactly how the belief surface
 * drifted before (PR#17). A support correction that works against a local
 * Claude Code install and fails against the hosted door is the same defect as
 * one that fails everywhere.
 *
 * The behaviour in one paragraph: `explanation` becomes optional, because the
 * explanation is the recorded human reasoning and a support correction is not
 * an occasion to rewrite it — and there is no read-one-edge-by-id tool to fetch
 * it and hand it back. When the explanation is absent the door must send NO
 * `context` key, because PUT /api/edges/[id] spreads the body into the update
 * payload and edgeService.updateEdge writes `context` WHOLESALE, so a
 * context carrying only `created_via` would overwrite the stored one and delete
 * the explanation. `created_via` therefore has to travel top-level instead, and
 * must still travel: the route defaults created_via to 'ui' when it finds none,
 * and the 'ui' path skips the confirmation gate entirely.
 *
 * Seam: tests/unit/mcp/helpers/remoteMcpDoorHarness.ts — a real MCP client over
 * the real transport into the exported POST handler in process, with an
 * in-process stub standing in for the RA-H app and recording every request. No
 * real app and no database is involved.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live harness for this file.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;

// The edge id every correction in this file is aimed at.
const CORRECTED_EDGE_ID = 42;

// The explanation the stored edge already carries — the words a support-only
// correction must leave alone. Only the tests that deliberately edit the
// explanation ever send it.
const STORED_EDGE_EXPLANATION =
  'The source node reports a measured result bearing on the target node.';

// Call rah_update_edge with exactly the arguments given — no explanation is
// added for the caller, because absence of the explanation is what is under
// test here.
async function callUpdateEdgeTool(
  client: Client,
  updateEdgeArguments: Record<string, unknown>
): Promise<{ isError?: boolean }> {
  return (await client.callTool({
    name: 'rah_update_edge',
    arguments: { id: CORRECTED_EDGE_ID, ...updateEdgeArguments },
  })) as { isError?: boolean };
}

// The (single) PUT /api/edges/<id> request the stubbed app recorded, if any.
function findRecordedUpdateEdgeRequest() {
  return remoteMcpDoorHarness
    .recordedAppRequests()
    .find((entry) => entry.method === 'PUT' && entry.pathname === `/api/edges/${CORRECTED_EDGE_ID}`);
}

// How many update requests reached the app — 0 is what a refused correction
// must produce.
function countRecordedUpdateEdgeRequests(): number {
  return remoteMcpDoorHarness
    .recordedAppRequests()
    .filter(
      (entry) => entry.method === 'PUT' && entry.pathname === `/api/edges/${CORRECTED_EDGE_ID}`
    ).length;
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  // Answer the edge-update endpoint with a plain success so every accepted tool
  // call completes and the assertions can be about the request that was sent.
  remoteMcpDoorHarness.respondWith((request) => {
    if (request.method === 'PUT' && request.pathname === `/api/edges/${CORRECTED_EDGE_ID}`) {
      return { payload: { success: true, message: 'Edge updated successfully' } };
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

describe('remote MCP door rah_update_edge corrects support without an explanation', () => {
  // The headline: a support correction must be expressible at all. Today the
  // schema refuses the call outright, so the only way to fix a mis-graded
  // support is to rewrite the human reasoning stored beside it.
  it('accepts a support-only correction and forwards the corrected support', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        belief_evidence_support: 0.4,
      });

      expect(
        updateEdgeToolResult.isError ?? false,
        'a support-only correction must be accepted without an explanation'
      ).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(updateEdgeRequest, 'the door should have PUT to /api/edges/<id>').toBeDefined();
      expect(updateEdgeRequest?.body?.belief_evidence_support).toBeCloseTo(0.4, 10);
    });
  });

  // The destructive case this whole change is guarding against: the app writes
  // `context` wholesale, so a context sent without an explanation inside it
  // would overwrite the stored one and delete the recorded reasoning.
  it('sends no context key at all when no explanation is supplied', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        belief_evidence_support: 0.4,
      });

      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      // Asserted first so this test cannot pass merely because the door
      // refused the call and sent nothing at all.
      expect(updateEdgeRequest, 'the door should have PUT to /api/edges/<id>').toBeDefined();
      expect(
        Object.keys(updateEdgeRequest?.body ?? {}),
        'a context key with no explanation inside it would wipe the stored explanation'
      ).not.toContain('context');
    });
  });

  // Without created_via the route defaults it to 'ui', and the 'ui' path skips
  // the confirmation gate entirely — so dropping created_via to avoid sending a
  // context would silently disarm app-side confirmation for every MCP support
  // write. It must ride top-level instead, alongside the confirmation flag.
  it('still identifies itself as an mcp write and carries the confirmation flag', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        belief_evidence_support: 0.4,
      });

      expect(findRecordedUpdateEdgeRequest()?.body).toMatchObject({
        created_via: 'mcp',
        confirmed_by_user: true,
      });
    });
  });

  // Un-assessment is the write the nullable schema exists for: it returns a
  // graded evidence edge to a plain relationship, clears the edge's
  // contribution and regrades the target. A dropped key would leave the edge
  // graded, which is indistinguishable from the correction never happening.
  it('forwards an un-assessment as a present-and-null support with no context', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        belief_evidence_support: null,
      });

      expect(
        updateEdgeToolResult.isError ?? false,
        'an un-assessment must be accepted without an explanation'
      ).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(Object.keys(updateEdgeRequest?.body ?? {})).toContain('belief_evidence_support');
      expect(updateEdgeRequest?.body?.belief_evidence_support).toBeNull();
      expect(Object.keys(updateEdgeRequest?.body ?? {})).not.toContain('context');
    });
  });

  // An un-assessment is still a write, so it must not become a way around the
  // confirmation gate — and a support-only body is exactly the shape that would
  // slip past an app-side check keyed on the explanation instead.
  it('refuses an unconfirmed support-only correction and sends no request to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: false,
        belief_evidence_support: 0.4,
      });

      expect(
        updateEdgeToolResult.isError,
        'an unconfirmed support-only correction must be refused'
      ).toBe(true);
      expect(countRecordedUpdateEdgeRequests()).toBe(0);
    });
  });

  // Optionality must apply to the explanation ONLY as absence. A present but
  // blank explanation is a caller trying to write nothing over the stored
  // reasoning, which is the same destruction by a different route.
  it('refuses a whitespace-only explanation and sends no request to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        explanation: '   ',
        belief_evidence_support: 0.4,
      });

      expect(
        updateEdgeToolResult.isError,
        'a blank explanation must be refused, not treated as an omitted one'
      ).toBe(true);
      expect(countRecordedUpdateEdgeRequests()).toBe(0);
    });
  });

  // GUARD: the empty string was already refused by the min(1) schema and must
  // stay refused once the field becomes optional.
  it('GUARD: refuses an empty-string explanation and sends no request to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        explanation: '',
        belief_evidence_support: 0.4,
      });

      expect(updateEdgeToolResult.isError).toBe(true);
      expect(countRecordedUpdateEdgeRequests()).toBe(0);
    });
  });

  // GUARD: the explanation-only correction is the tool's original job and must
  // not regress. It still travels inside context, and still invents no support
  // — a support key added here would turn a plain relationship into evidence.
  it('GUARD: an explanation-only correction still sends context and no support key', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        explanation: STORED_EDGE_EXPLANATION,
      });

      expect(updateEdgeToolResult.isError ?? false).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(updateEdgeRequest?.body).toMatchObject({
        context: { explanation: STORED_EDGE_EXPLANATION, created_via: 'mcp' },
        confirmed_by_user: true,
      });
      expect(Object.keys(updateEdgeRequest?.body ?? {})).not.toContain('belief_evidence_support');
    });
  });

  // GUARD: correcting both at once is still one write. Making the explanation
  // optional must not turn the two fields into alternatives.
  it('GUARD: an explanation and a support together are sent together', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        explanation: STORED_EDGE_EXPLANATION,
        belief_evidence_support: 0.7,
      });

      expect(updateEdgeToolResult.isError ?? false).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(updateEdgeRequest?.body).toMatchObject({
        context: { explanation: STORED_EDGE_EXPLANATION, created_via: 'mcp' },
        confirmed_by_user: true,
      });
      expect(updateEdgeRequest?.body?.belief_evidence_support).toBeCloseTo(0.7, 10);
    });
  });

  // Discoverability: an agent learns what it may omit from the advertised
  // schema alone. If explanation stays required there, no client will ever
  // attempt a support-only correction however permissive the handler becomes.
  it('advertises explanation as optional while id and confirmed_by_user stay required', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const updateEdgeTool = listedTools.tools.find((tool) => tool.name === 'rah_update_edge');
      expect(updateEdgeTool).toBeDefined();

      const requiredInputProperties =
        (updateEdgeTool?.inputSchema as { required?: string[] }).required ?? [];
      expect(
        requiredInputProperties,
        'explanation must not be required, or a support-only correction is undiscoverable'
      ).not.toContain('explanation');
      // The confirmation gate is untouched by this change and must stay visible.
      expect(requiredInputProperties).toContain('confirmed_by_user');
      expect(requiredInputProperties).toContain('id');
    });
  });

  // Discoverability for the un-assessment: an agent must be able to read off
  // the advertised schema that null is a legal support here.
  it('advertises a nullable belief_evidence_support on the update tool', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const updateEdgeTool = listedTools.tools.find((tool) => tool.name === 'rah_update_edge');

      const advertisedSupportSchema = (
        updateEdgeTool?.inputSchema as { properties?: Record<string, unknown> }
      ).properties?.belief_evidence_support;
      expect(advertisedSupportSchema).toBeDefined();
      expect(
        JSON.stringify(advertisedSupportSchema),
        'the advertised support schema must admit null'
      ).toContain('null');
    });
  });
});
