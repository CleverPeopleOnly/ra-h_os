/**
 * Tests for the three NEW belief tools on the REMOTE MCP door
 * (app/api/mcp/route.ts):
 *
 *  - rah_set_belief_fixed_credence — assert one node's credence by hand,
 *    mirroring the standalone door's setBeliefFixedCredence semantics and
 *    reply shape,
 *  - rah_get_belief_movements — read the log of a node's credence changing,
 *    newest first,
 *  - rah_recompute_node_belief — ask the app's belief engine to regrade one
 *    node, where a null credence answer is a REAL state (ungraded), not an
 *    error.
 *
 * WHY: the external belief consumer (samai-diagnostic's BeliefSystem adapter)
 * talks to RA-H through the app doors, and today those doors expose only the
 * edge-side belief surface — no way to bootstrap a credence, read a node's
 * movement history, or ask for a regrade. The door is an HTTP proxy: each
 * tool validates at its schema, forwards to the app's belief endpoints
 * (POST /api/belief/fixed-credence, GET /api/belief/movements,
 * POST /api/belief/recompute — pinned behaviourally in tests/unit/api/), and
 * passes the app's answer through. The app is never reimplemented door-side.
 *
 * Seam: tests/unit/mcp/helpers/remoteMcpDoorHarness.ts — a real MCP client
 * over the real transport into the exported POST handler in process, with an
 * in-process stub standing in for the RA-H app and recording every request.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';

import { GET } from '../../../app/api/mcp/route';
import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live harness for this file.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;

// The three new belief tool names, exactly as both doors must advertise them.
const newBeliefToolNames = [
  'rah_set_belief_fixed_credence',
  'rah_get_belief_movements',
  'rah_recompute_node_belief',
];

// The node every happy-path call in this file works on.
const ASSERTED_NODE_ID = 9;
// A node id the stubbed app has never heard of, for the refusal paths.
const UNKNOWN_NODE_ID = 424242;
// A node whose movement log is empty, for the quiet-success path.
const QUIET_NODE_ID = 10;
// A node whose recompute lands on "ungraded" (null credence).
const EVIDENCELESS_NODE_ID = 11;
// The timestamp the stubbed app stamps on every fixed-credence assertion.
const STUBBED_BELIEF_COMPUTED_AT = '2026-07-30T10:00:00.000Z';
// The credence the stubbed app answers for a graded recompute.
const STUBBED_RECOMPUTED_CREDENCE = 0.44;

// The movement log the stubbed app serves for ASSERTED_NODE_ID — already
// newest first, exactly as the app route answers it; the door must pass the
// order through untouched.
const stubbedMovementLogNewestFirst = [
  {
    id: 33,
    node_id: ASSERTED_NODE_ID,
    from_credence: 0.6,
    to_credence: 0.4,
    trigger: 'belief-fixed-credence-set',
    occurred_at: '2026-07-03T10:00:00.000Z',
  },
  {
    id: 32,
    node_id: ASSERTED_NODE_ID,
    from_credence: 0.3,
    to_credence: 0.6,
    trigger: 'belief-recompute',
    occurred_at: '2026-07-02T10:00:00.000Z',
  },
  {
    id: 31,
    node_id: ASSERTED_NODE_ID,
    from_credence: null,
    to_credence: 0.3,
    trigger: 'belief-recompute',
    occurred_at: '2026-07-01T10:00:00.000Z',
  },
];

// Find the requests the stubbed app received for one belief endpoint.
function findRecordedBeliefRequests(method: string, pathname: string) {
  return remoteMcpDoorHarness
    .recordedAppRequests()
    .filter((entry) => entry.method === method && entry.pathname === pathname);
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  // The stubbed app serves the three belief endpoints the door forwards to,
  // keyed off the node id the request names — including the standalone-shaped
  // refusal for a node that does not exist.
  remoteMcpDoorHarness.respondWith((request) => {
    if (request.method === 'POST' && request.pathname === '/api/belief/fixed-credence') {
      const assertedNodeId = request.body?.node_id as number;
      const assertedBeliefCredence = request.body?.belief_credence as number;
      if (assertedNodeId === UNKNOWN_NODE_ID) {
        return {
          status: 404,
          payload: {
            success: false,
            error: `Cannot assert a credence about node #${UNKNOWN_NODE_ID}: no such node.`,
          },
        };
      }
      return {
        payload: {
          success: true,
          node_id: assertedNodeId,
          belief_credence: assertedBeliefCredence,
          belief_credence_is_fixed: 1,
          belief_computed_at: STUBBED_BELIEF_COMPUTED_AT,
          message: `Asserted belief_credence ${assertedBeliefCredence} on node #${assertedNodeId}.`,
        },
      };
    }

    if (request.method === 'GET' && request.pathname === '/api/belief/movements') {
      const requestedNodeId = Number(request.searchParams.node_id);
      if (requestedNodeId === QUIET_NODE_ID) {
        return { payload: { success: true, count: 0, movements: [] } };
      }
      // Serve the fixture log, honouring a forwarded limit.
      const requestedLimit = request.searchParams.limit
        ? Number(request.searchParams.limit)
        : stubbedMovementLogNewestFirst.length;
      const servedMovements = stubbedMovementLogNewestFirst.slice(0, requestedLimit);
      return {
        payload: { success: true, count: servedMovements.length, movements: servedMovements },
      };
    }

    if (request.method === 'POST' && request.pathname === '/api/belief/recompute') {
      const recomputedNodeId = request.body?.node_id as number;
      if (recomputedNodeId === UNKNOWN_NODE_ID) {
        return {
          status: 404,
          payload: {
            success: false,
            error: `Cannot recompute belief for node #${UNKNOWN_NODE_ID}: no such node.`,
          },
        };
      }
      if (recomputedNodeId === EVIDENCELESS_NODE_ID) {
        return {
          payload: {
            success: true,
            node_id: recomputedNodeId,
            belief_credence: null,
            message: `Node #${recomputedNodeId} has no counted evidence and stays ungraded.`,
          },
        };
      }
      return {
        payload: {
          success: true,
          node_id: recomputedNodeId,
          belief_credence: STUBBED_RECOMPUTED_CREDENCE,
          message: `Recomputed belief for node #${recomputedNodeId}.`,
        },
      };
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

describe('remote MCP door rah_set_belief_fixed_credence', () => {
  // The whole path: schema in, forwarded body, and the standalone-shaped
  // reply back out through structuredContent.
  it('forwards the assertion to the app and reports the standalone-shaped reply', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_set_belief_fixed_credence',
        arguments: { node_id: ASSERTED_NODE_ID, belief_credence: 0.7 },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      // Outbound leg: the exact column names ride the POST body.
      const [forwardedAssertion] = findRecordedBeliefRequests('POST', '/api/belief/fixed-credence');
      expect(forwardedAssertion, 'the door should have POSTed to /api/belief/fixed-credence').toBeDefined();
      expect(forwardedAssertion.body).toMatchObject({
        node_id: ASSERTED_NODE_ID,
        belief_credence: 0.7,
      });
      // Return leg: the standalone door's reply shape, field for field.
      expect(toolResult.structuredContent).toMatchObject({
        success: true,
        node_id: ASSERTED_NODE_ID,
        belief_credence: 0.7,
        belief_credence_is_fixed: 1,
        belief_computed_at: STUBBED_BELIEF_COMPUTED_AT,
      });
      expect(
        typeof (toolResult.structuredContent as { message?: unknown }).message
      ).toBe('string');
    });
  });

  // 0 is assessed-and-torn — a legitimate assertion that must forward
  // verbatim, never be dropped as falsy.
  it('accepts a credence of exactly 0 and forwards it verbatim', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_set_belief_fixed_credence',
        arguments: { node_id: ASSERTED_NODE_ID, belief_credence: 0 },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const [forwardedAssertion] = findRecordedBeliefRequests('POST', '/api/belief/fixed-credence');
      expect(Object.keys(forwardedAssertion?.body ?? {})).toContain('belief_credence');
      expect(forwardedAssertion?.body?.belief_credence).toBe(0);
    });
  });

  // The interval is OPEN: ±1 would claim total certainty, which is not
  // expressible — refused at the schema, so no request ever reaches the app.
  it('rejects a credence at or beyond plus/minus 1 and sends no request to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      // Guard against a vacuous pass: an UNKNOWN tool also errors without a
      // request, so the refusal only means anything once the tool exists.
      const listedToolNames = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listedToolNames).toContain('rah_set_belief_fixed_credence');

      for (const rejectedCredence of [1, -1, 1.5, -2]) {
        const toolResult = await client.callTool({
          name: 'rah_set_belief_fixed_credence',
          arguments: { node_id: ASSERTED_NODE_ID, belief_credence: rejectedCredence },
        });

        expect(
          (toolResult as { isError?: boolean }).isError,
          `a credence of ${rejectedCredence} must be rejected — the interval is open`
        ).toBe(true);
      }
      expect(findRecordedBeliefRequests('POST', '/api/belief/fixed-credence')).toHaveLength(0);
    });
  });

  // The app's refusal for a node that does not exist must surface as a tool
  // error that names the node, not as a silent success.
  it('refuses an unknown node with an error naming it', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_set_belief_fixed_credence',
        arguments: { node_id: UNKNOWN_NODE_ID, belief_credence: 0.5 },
      });

      expect((toolResult as { isError?: boolean }).isError).toBe(true);
      // The refusal text names the node the caller asked about.
      const refusalText = JSON.stringify(toolResult.content);
      expect(refusalText).toContain(String(UNKNOWN_NODE_ID));
    });
  });
});

describe('remote MCP door rah_get_belief_movements', () => {
  // The read path: node_id rides the query string, and the app's
  // newest-first order passes through the door untouched.
  it('forwards node_id and reports the movement log newest first under the exact column names', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_get_belief_movements',
        arguments: { node_id: ASSERTED_NODE_ID },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      // Outbound leg: the door asked the app for this node's movements.
      const [forwardedMovementsRead] = findRecordedBeliefRequests('GET', '/api/belief/movements');
      expect(forwardedMovementsRead, 'the door should have GET /api/belief/movements').toBeDefined();
      expect(forwardedMovementsRead.searchParams.node_id).toBe(String(ASSERTED_NODE_ID));

      // Return leg: count plus the log, order and columns untouched.
      const movementsReadReply = toolResult.structuredContent as {
        count: number;
        movements: Array<Record<string, unknown>>;
      };
      expect(movementsReadReply.count).toBe(3);
      expect(movementsReadReply.movements.map((movement) => movement.id)).toEqual([33, 32, 31]);
      expect(movementsReadReply.movements[0]).toEqual(stubbedMovementLogNewestFirst[0]);
      // The oldest movement's null from_credence (previously ungraded)
      // survives as null, never 0.
      expect(movementsReadReply.movements[2].from_credence).toBeNull();
    });
  });

  // The limit forwards so the APP caps the page — the door must not page a
  // log it never loaded.
  it('forwards a given limit to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_get_belief_movements',
        arguments: { node_id: ASSERTED_NODE_ID, limit: 2 },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const [forwardedMovementsRead] = findRecordedBeliefRequests('GET', '/api/belief/movements');
      expect(forwardedMovementsRead.searchParams.limit).toBe('2');
      const movementsReadReply = toolResult.structuredContent as { count: number };
      expect(movementsReadReply.count).toBe(2);
    });
  });

  // A quiet node is a success, not an error: an empty log means the credence
  // has simply never changed.
  it('reports an empty log as a success with count 0', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_get_belief_movements',
        arguments: { node_id: QUIET_NODE_ID },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      expect(toolResult.structuredContent).toMatchObject({ count: 0, movements: [] });
    });
  });

  // An impossible page is refused at the schema; the app never hears of it.
  it('rejects a limit of 0 or over 100 and sends no request to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      // Guard against a vacuous pass: an UNKNOWN tool also errors without a
      // request, so the refusal only means anything once the tool exists.
      const listedToolNames = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listedToolNames).toContain('rah_get_belief_movements');

      for (const rejectedLimit of [0, 101]) {
        const toolResult = await client.callTool({
          name: 'rah_get_belief_movements',
          arguments: { node_id: ASSERTED_NODE_ID, limit: rejectedLimit },
        });

        expect(
          (toolResult as { isError?: boolean }).isError,
          `a limit of ${rejectedLimit} must be rejected`
        ).toBe(true);
      }
      expect(findRecordedBeliefRequests('GET', '/api/belief/movements')).toHaveLength(0);
    });
  });
});

describe('remote MCP door rah_recompute_node_belief', () => {
  // The regrade path: node_id rides the POST body, and the app's graded
  // answer passes through.
  it('forwards the recompute to the app and reports the regraded credence', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_recompute_node_belief',
        arguments: { node_id: ASSERTED_NODE_ID },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const [forwardedRecompute] = findRecordedBeliefRequests('POST', '/api/belief/recompute');
      expect(forwardedRecompute, 'the door should have POSTed to /api/belief/recompute').toBeDefined();
      expect(forwardedRecompute.body).toMatchObject({ node_id: ASSERTED_NODE_ID });
      expect(toolResult.structuredContent).toMatchObject({
        success: true,
        node_id: ASSERTED_NODE_ID,
        belief_credence: STUBBED_RECOMPUTED_CREDENCE,
      });
    });
  });

  // Ungraded is a real answer: a null credence must arrive as an explicit
  // null with NO error — and never be coerced to 0.
  it('reports a null credence as a successful ungraded answer, never 0 and never an error', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_recompute_node_belief',
        arguments: { node_id: EVIDENCELESS_NODE_ID },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const recomputeReply = toolResult.structuredContent as {
        success: boolean;
        belief_credence: number | null;
      };
      expect(recomputeReply.success).toBe(true);
      expect(recomputeReply.belief_credence).toBeNull();
      expect(recomputeReply.belief_credence).not.toBe(0);
    });
  });

  // A typo'd node id is an error, not an ungraded node.
  it('refuses an unknown node with an error naming it', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_recompute_node_belief',
        arguments: { node_id: UNKNOWN_NODE_ID },
      });

      expect((toolResult as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(toolResult.content)).toContain(String(UNKNOWN_NODE_ID));
    });
  });
});

describe('remote MCP door advertises the new belief tools', () => {
  // Discoverability over the MCP handshake: each new tool is listed with an
  // input schema AND an output schema — the missing output schemas are how
  // the last drift went unnoticed.
  it('lists all three belief tools with input and output schemas', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();

      for (const beliefToolName of newBeliefToolNames) {
        const advertisedBeliefTool = listedTools.tools.find(
          (tool) => tool.name === beliefToolName
        );
        expect(advertisedBeliefTool, `the door must advertise ${beliefToolName}`).toBeDefined();
        expect(
          advertisedBeliefTool?.inputSchema,
          `${beliefToolName} must declare an input schema`
        ).toBeDefined();
        expect(
          advertisedBeliefTool?.outputSchema,
          `${beliefToolName} must declare an output schema`
        ).toBeDefined();
      }
    });
  });

  // Discoverability over plain HTTP: the GET metadata handler's advertised
  // tool list must name the new tools too. (Its existing strict-equality pin
  // in tests/unit/mcp/remote-mcp-route-responds.test.ts lists the pre-belief
  // tool set and will need its fixture extended in the same change.)
  it('names all three belief tools in the GET metadata tool list', async () => {
    const metadataRequest = new Request('http://127.0.0.1/api/mcp', {
      method: 'GET',
    }) as unknown as NextRequest;

    const metadataResponse = await GET(metadataRequest);
    const metadata = (await metadataResponse.json()) as { tools: string[] };

    expect(metadata.tools).toEqual(expect.arrayContaining(newBeliefToolNames));
  });
});
