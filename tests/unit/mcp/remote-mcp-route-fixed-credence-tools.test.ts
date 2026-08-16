/**
 * The NEW fixed-credence tool pair on the REMOTE MCP door
 * (app/api/mcp/route.ts): rah_assert_fixed_credence and
 * rah_clear_fixed_credence — the one way anything can raise or drop
 * belief_credence_is_fixed since the belief-storage split left the column
 * write-orphaned.
 *
 * REMOTE DOOR ONLY, matching rah_write_display_belief and the journal tools'
 * precedent: samai writes through the remote door, so the stdio and
 * standalone doors gain neither tool (pinned in
 * stdio-server-display-belief-surface.test.ts and
 * standalone-fixed-credence-tools-gone.test.ts). Each tool is a
 * validate-and-forward proxy onto its app endpoint (pinned behaviourally in
 * tests/unit/api/beliefFixedRoute.test.ts), and the contract is:
 *
 *  - rah_assert_fixed_credence: node_id (positive int), belief_credence
 *    (number in the OPEN interval −1 < c < 1 — the open interval belongs to
 *    a hand assertion, unlike the display write's closed one) and
 *    belief_computed_at (ISO-8601 string; samai stamps the instant),
 *    forwarded to POST /api/belief/fixed,
 *  - rah_clear_fixed_credence: node_id ALONE, forwarded to POST
 *    /api/belief/fixed/clear,
 *  - NEITHER tool accepts belief_uncertainty or belief_credence_is_fixed as
 *    input: the route owns those figures (uncertainty 0 — the dogmatic
 *    opinion — and flag 1 on an assertion), so an illegal combination cannot
 *    even be requested,
 *  - every reply carries the STORED row's four belief columns as the app
 *    answered them, and the app's refusals (unknown node, already-fixed
 *    node, not-fixed node) pass through naming what refused them.
 *
 * The OLD engine-era names (rah_set_belief_fixed_credence,
 * rah_clear_belief_fixed_credence) stay dead — pinned in
 * remote-mcp-route-belief-surface-reduced-to-display.test.ts, which this
 * slice must not weaken.
 *
 * Seam: tests/unit/mcp/helpers/remoteMcpDoorHarness.ts — a real MCP client
 * over the real transport into the exported POST handler in process, with an
 * in-process stub standing in for the RA-H app and recording every request.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';

import { GET } from '../../../app/api/mcp/route';
import {
  REMOTE_MCP_DOOR_HARNESS_TOKEN,
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live harness for this file.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;

// The node every happy-path assertion in this file lands on.
const ASSERTED_NODE_ID = 9;
// A node id the stubbed app has never heard of, for the 404 pass-through.
const UNKNOWN_NODE_ID = 424242;
// A node already carrying a hand assertion — the stubbed app refuses a
// second decree on it, naming the flag.
const ALREADY_FIXED_NODE_ID = 12;
// A node nobody asserted — the stubbed app refuses a clear on it, plainly.
const NOT_FIXED_NODE_ID = 21;
// The decree every happy-path assertion carries: the credence and the
// instant samai stamped it.
const ASSERTED_BELIEF_CREDENCE = 0.73;
const ASSERTED_BELIEF_COMPUTED_AT = '2026-08-12T09:00:00.000Z';
// The stale figures the stubbed app answers after a clear: the hand-asserted
// columns as they stand once only the flag has dropped.
const STALE_BELIEF_CREDENCE = -0.4;
const STALE_BELIEF_COMPUTED_AT = '2026-08-04T10:00:00.000Z';

// The assertion tool's three input fields, exactly as it must declare them —
// and NOTHING more: the route owns uncertainty and the flag.
const assertToolInputFieldNames = ['node_id', 'belief_credence', 'belief_computed_at'];

// Find the requests the stubbed app received for one fixed-credence endpoint.
function findRecordedFixedCredenceRequests(pathname: string) {
  return remoteMcpDoorHarness
    .recordedAppRequests()
    .filter((entry) => entry.method === 'POST' && entry.pathname === pathname);
}

// The structured reply of one tool call, cast to the stored-row shape both
// fixed-credence tools answer.
function fixedCredenceStructuredContent(toolResult: unknown): {
  success: boolean;
  node_id: number;
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
} {
  return (toolResult as { structuredContent?: unknown })
    .structuredContent as ReturnType<typeof fixedCredenceStructuredContent>;
}

// The flattened text of one tool result's content blocks — where a refusal's
// message lives.
function toolResultText(toolResult: unknown): string {
  const contentBlocks = (toolResult as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return contentBlocks.map((block) => block.text ?? '').join('\n');
}

// The declared property names of one advertised tool's input schema.
function declaredInputFieldNames(advertisedTool: { inputSchema?: unknown } | undefined): string[] {
  return Object.keys(
    (advertisedTool?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {}
  );
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  // The stubbed app serves the TWO fixed-credence endpoints the tools
  // forward to, answering the stored-row shape the app routes answer —
  // including every refusal under its own status.
  remoteMcpDoorHarness.respondWith((request) => {
    if (request.method === 'POST' && request.pathname === '/api/belief/fixed') {
      const assertedNodeId = request.body?.node_id as number;
      if (assertedNodeId === UNKNOWN_NODE_ID) {
        return {
          status: 404,
          payload: {
            success: false,
            error: `Cannot assert a fixed credence for node #${UNKNOWN_NODE_ID}: no such node.`,
          },
        };
      }
      if (assertedNodeId === ALREADY_FIXED_NODE_ID) {
        return {
          status: 409,
          payload: {
            success: false,
            error:
              `Node #${ALREADY_FIXED_NODE_ID} already has its credence asserted by hand ` +
              '(belief_credence_is_fixed = 1); clear the assertion before asserting again.',
          },
        };
      }
      // The stored row after the assertion: the caller's credence and stamp
      // verbatim, plus the TWO figures the route itself supplies —
      // uncertainty 0 and flag 1.
      return {
        payload: {
          success: true,
          node_id: assertedNodeId,
          belief_credence: request.body?.belief_credence ?? null,
          belief_uncertainty: 0,
          belief_computed_at: request.body?.belief_computed_at ?? null,
          belief_credence_is_fixed: 1,
          message: `Asserted the fixed credence of node #${assertedNodeId}.`,
        },
      };
    }
    if (request.method === 'POST' && request.pathname === '/api/belief/fixed/clear') {
      const clearedNodeId = request.body?.node_id as number;
      if (clearedNodeId === UNKNOWN_NODE_ID) {
        return {
          status: 404,
          payload: {
            success: false,
            error: `Cannot clear the fixed credence of node #${UNKNOWN_NODE_ID}: no such node.`,
          },
        };
      }
      if (clearedNodeId === NOT_FIXED_NODE_ID) {
        return {
          status: 409,
          payload: {
            success: false,
            error: `Node #${NOT_FIXED_NODE_ID} is not fixed; there is no assertion to clear.`,
          },
        };
      }
      // The stored row after the clear: flag down, the other three columns
      // still holding the stale hand-asserted figures.
      return {
        payload: {
          success: true,
          node_id: clearedNodeId,
          belief_credence: STALE_BELIEF_CREDENCE,
          belief_uncertainty: 0,
          belief_computed_at: STALE_BELIEF_COMPUTED_AT,
          belief_credence_is_fixed: 0,
          message: `Cleared the fixed credence of node #${clearedNodeId}.`,
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

describe('remote MCP door advertises the fixed-credence pair', () => {
  // Discoverability over the MCP handshake: the assertion tool declares
  // exactly its three input fields — and neither route-owned figure — plus
  // an output schema for the stored-row reply.
  it('lists rah_assert_fixed_credence with exactly node_id, belief_credence and belief_computed_at', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const advertisedAssertTool = listedTools.tools.find(
        (tool) => tool.name === 'rah_assert_fixed_credence'
      );
      expect(
        advertisedAssertTool,
        'the remote door must advertise rah_assert_fixed_credence'
      ).toBeDefined();
      expect(advertisedAssertTool?.outputSchema).toBeDefined();

      const declaredFieldNames = declaredInputFieldNames(advertisedAssertTool);
      for (const assertToolInputFieldName of assertToolInputFieldNames) {
        expect(declaredFieldNames).toContain(assertToolInputFieldName);
      }
      // The route owns uncertainty (always 0 on an assertion) and the flag
      // (always 1), so the tool must not even declare them as inputs — an
      // illegal combination cannot be requested.
      expect(declaredFieldNames).not.toContain('belief_uncertainty');
      expect(declaredFieldNames).not.toContain('belief_credence_is_fixed');
    });
  });

  // The clear takes the node alone: the other three columns keep their stale
  // figures, so there is nothing else a caller could legitimately say.
  it('lists rah_clear_fixed_credence taking node_id alone', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const advertisedClearTool = listedTools.tools.find(
        (tool) => tool.name === 'rah_clear_fixed_credence'
      );
      expect(
        advertisedClearTool,
        'the remote door must advertise rah_clear_fixed_credence'
      ).toBeDefined();
      expect(advertisedClearTool?.outputSchema).toBeDefined();
      expect(declaredInputFieldNames(advertisedClearTool)).toEqual(['node_id']);
    });
  });

  // Discoverability over plain HTTP: the GET metadata list an external agent
  // reads before opening an MCP session must name both new tools too.
  it('names both fixed-credence tools in the GET metadata tool list', async () => {
    // The harness's bearer credential rides this direct GET: the door fails
    // closed and refuses an uncredentialed listing.
    const metadataRequest = new Request('http://127.0.0.1/api/mcp', {
      method: 'GET',
      headers: { Authorization: `Bearer ${REMOTE_MCP_DOOR_HARNESS_TOKEN}` },
    }) as unknown as NextRequest;

    const metadataResponse = await GET(metadataRequest);
    const metadata = (await metadataResponse.json()) as { tools: string[] };

    expect(metadata.tools).toContain('rah_assert_fixed_credence');
    expect(metadata.tools).toContain('rah_clear_fixed_credence');
  });
});

describe('remote MCP door rah_assert_fixed_credence', () => {
  // The hand assertion in one pass: the three fields forward verbatim to the
  // ONE app endpoint, and the reply is the stored row the app answered —
  // carrying uncertainty 0 and flag 1, two figures the caller never sent.
  it('forwards the assertion to POST /api/belief/fixed and answers the stored row', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_assert_fixed_credence',
        arguments: {
          node_id: ASSERTED_NODE_ID,
          belief_credence: ASSERTED_BELIEF_CREDENCE,
          belief_computed_at: ASSERTED_BELIEF_COMPUTED_AT,
        },
      });
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);

      const structuredReply = fixedCredenceStructuredContent(toolResult);
      expect(structuredReply.success).toBe(true);
      expect(structuredReply.node_id).toBe(ASSERTED_NODE_ID);
      expect(structuredReply.belief_credence).toBe(ASSERTED_BELIEF_CREDENCE);
      expect(structuredReply.belief_computed_at).toBe(ASSERTED_BELIEF_COMPUTED_AT);
      // The stored row's two route-owned figures, never requestable as input.
      expect(structuredReply.belief_uncertainty).toBe(0);
      expect(structuredReply.belief_credence_is_fixed).toBe(1);
    });

    // Exactly one app request, to the assertion endpoint, carrying the three
    // fields verbatim and nothing more.
    const recordedAppRequests = remoteMcpDoorHarness.recordedAppRequests();
    expect(recordedAppRequests).toHaveLength(1);
    expect(recordedAppRequests[0].pathname).toBe('/api/belief/fixed');
    expect(recordedAppRequests[0].body).toEqual({
      node_id: ASSERTED_NODE_ID,
      belief_credence: ASSERTED_BELIEF_CREDENCE,
      belief_computed_at: ASSERTED_BELIEF_COMPUTED_AT,
    });
  });

  // A hand assertion may disbelieve: a negative credence rides the same path
  // as a positive one, verbatim.
  it('forwards a negative credence verbatim — a hand assertion may disbelieve', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_assert_fixed_credence',
        arguments: {
          node_id: ASSERTED_NODE_ID,
          belief_credence: -0.85,
          belief_computed_at: ASSERTED_BELIEF_COMPUTED_AT,
        },
      });
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      expect(fixedCredenceStructuredContent(toolResult).belief_credence).toBe(-0.85);
    });

    const forwardedAssertions = findRecordedFixedCredenceRequests('/api/belief/fixed');
    expect(forwardedAssertions).toHaveLength(1);
    expect(forwardedAssertions[0].body?.belief_credence).toBe(-0.85);
  });

  // Credence's interval is OPEN here — the endpoints belong to derivation,
  // not decree — so −1, 1 and anything beyond are refused at the door's own
  // schema, before a request exists. The refusal must come from the
  // REGISTERED tool's schema: the "not found" answer is excluded so this
  // cannot pass merely because the tool does not exist.
  it('refuses credence at or beyond the closed endpoints door-side, sending nothing to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      for (const refusedCredence of [-1, 1, 1.5]) {
        const toolResult = await client.callTool({
          name: 'rah_assert_fixed_credence',
          arguments: {
            node_id: ASSERTED_NODE_ID,
            belief_credence: refusedCredence,
            belief_computed_at: ASSERTED_BELIEF_COMPUTED_AT,
          },
        });
        expect(
          (toolResult as { isError?: boolean }).isError,
          `credence ${refusedCredence} must be refused door-side`
        ).toBe(true);
        expect(toolResultText(toolResult)).not.toMatch(/not found/i);
      }
    });

    expect(findRecordedFixedCredenceRequests('/api/belief/fixed')).toHaveLength(0);
  });

  // An assertion that names no node, or carries no stamp, is refused at the
  // schema too: node_id is a positive integer and belief_computed_at is
  // required — samai stamps the instant, so a stampless decree is incomplete.
  it('refuses a non-positive node_id and a missing stamp door-side, sending nothing to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const zeroNodeIdResult = await client.callTool({
        name: 'rah_assert_fixed_credence',
        arguments: {
          node_id: 0,
          belief_credence: ASSERTED_BELIEF_CREDENCE,
          belief_computed_at: ASSERTED_BELIEF_COMPUTED_AT,
        },
      });
      expect((zeroNodeIdResult as { isError?: boolean }).isError).toBe(true);
      expect(toolResultText(zeroNodeIdResult)).not.toMatch(/not found/i);

      const missingStampResult = await client.callTool({
        name: 'rah_assert_fixed_credence',
        arguments: {
          node_id: ASSERTED_NODE_ID,
          belief_credence: ASSERTED_BELIEF_CREDENCE,
        },
      });
      expect((missingStampResult as { isError?: boolean }).isError).toBe(true);
      expect(toolResultText(missingStampResult)).not.toMatch(/not found/i);
    });

    expect(findRecordedFixedCredenceRequests('/api/belief/fixed')).toHaveLength(0);
  });

  // The app's refusals pass through naming what refused them: the unknown
  // node by number, the standing assertion by its flag.
  it('surfaces the unknown-node and already-fixed refusals naming what refused them', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const unknownNodeResult = await client.callTool({
        name: 'rah_assert_fixed_credence',
        arguments: {
          node_id: UNKNOWN_NODE_ID,
          belief_credence: ASSERTED_BELIEF_CREDENCE,
          belief_computed_at: ASSERTED_BELIEF_COMPUTED_AT,
        },
      });
      expect((unknownNodeResult as { isError?: boolean }).isError).toBe(true);
      expect(toolResultText(unknownNodeResult)).toContain(String(UNKNOWN_NODE_ID));

      const alreadyFixedResult = await client.callTool({
        name: 'rah_assert_fixed_credence',
        arguments: {
          node_id: ALREADY_FIXED_NODE_ID,
          belief_credence: ASSERTED_BELIEF_CREDENCE,
          belief_computed_at: ASSERTED_BELIEF_COMPUTED_AT,
        },
      });
      expect((alreadyFixedResult as { isError?: boolean }).isError).toBe(true);
      expect(toolResultText(alreadyFixedResult)).toContain('belief_credence_is_fixed');
    });
  });
});

describe('remote MCP door rah_clear_fixed_credence', () => {
  // The clear in one pass: the node alone forwards to the clear endpoint,
  // and the reply is the stored row with the flag down and the stale
  // hand-asserted figures still standing — this store never grades, so the
  // regrade is samai's, through the display write afterwards.
  it('forwards the clear to POST /api/belief/fixed/clear and answers the stored row with the stale figures', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_clear_fixed_credence',
        arguments: { node_id: ASSERTED_NODE_ID },
      });
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);

      const structuredReply = fixedCredenceStructuredContent(toolResult);
      expect(structuredReply.success).toBe(true);
      expect(structuredReply.node_id).toBe(ASSERTED_NODE_ID);
      expect(structuredReply.belief_credence_is_fixed).toBe(0);
      // The stale figures the clear deliberately leaves standing.
      expect(structuredReply.belief_credence).toBe(STALE_BELIEF_CREDENCE);
      expect(structuredReply.belief_uncertainty).toBe(0);
      expect(structuredReply.belief_computed_at).toBe(STALE_BELIEF_COMPUTED_AT);
    });

    // Exactly one app request, to the clear endpoint, naming the node alone.
    const recordedAppRequests = remoteMcpDoorHarness.recordedAppRequests();
    expect(recordedAppRequests).toHaveLength(1);
    expect(recordedAppRequests[0].pathname).toBe('/api/belief/fixed/clear');
    expect(recordedAppRequests[0].body).toEqual({ node_id: ASSERTED_NODE_ID });
  });

  // The app's refusals pass through naming what refused them: the unknown
  // node by number, and the unfixed node plainly — clearing a node nobody
  // asserted is a caller error, never a silent no-op.
  it('surfaces the unknown-node and not-fixed refusals naming what refused them', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const unknownNodeResult = await client.callTool({
        name: 'rah_clear_fixed_credence',
        arguments: { node_id: UNKNOWN_NODE_ID },
      });
      expect((unknownNodeResult as { isError?: boolean }).isError).toBe(true);
      expect(toolResultText(unknownNodeResult)).toContain(String(UNKNOWN_NODE_ID));

      const notFixedResult = await client.callTool({
        name: 'rah_clear_fixed_credence',
        arguments: { node_id: NOT_FIXED_NODE_ID },
      });
      expect((notFixedResult as { isError?: boolean }).isError).toBe(true);
      expect(toolResultText(notFixedResult)).toContain(String(NOT_FIXED_NODE_ID));
      expect(toolResultText(notFixedResult)).toMatch(/not fixed/i);
    });
  });
});
