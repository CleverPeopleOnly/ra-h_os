/**
 * The NEW display-belief write tool on the REMOTE MCP door
 * (app/api/mcp/route.ts): rah_write_display_belief — samai's one way to land
 * a node's display belief in the fork after the belief-storage split.
 *
 * REMOTE DOOR ONLY, matching the journal tools' precedent: samai writes
 * through the remote door, so the local stdio door does not gain this tool
 * (pinned in stdio-server-display-belief-surface.test.ts). The tool is a
 * validate-and-forward proxy onto POST /api/belief/display (pinned
 * behaviourally in tests/unit/api/beliefDisplayRoute.test.ts), and its
 * contract is:
 *
 *  - input: node_id, belief_credence (number in [-1, 1] or null),
 *    belief_uncertainty (number in (0, 1] or null), belief_computed_at
 *    (ISO-8601 string or null),
 *  - exactly TWO legal shapes — a GRADE (all three non-null) or an UNGRADE
 *    (all three null) — any mixture refused door-side with a message naming
 *    the two shapes, and NOTHING sent to the app,
 *  - the reply carries the STORED row's four belief columns as the app
 *    answered them,
 *  - the app's refusals (unknown node, fixed node) pass through naming what
 *    refused them.
 *
 * This file also pins the other half of the slice on this door: the
 * recompute tool is GONE — a recompute that writes never-assessed would
 * erase samai's display writes — so rah_recompute_node_belief must vanish
 * from the tools/list and from the GET metadata list.
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

// The node every happy-path write in this file lands on.
const DISPLAY_WRITE_NODE_ID = 9;
// A node id the stubbed app has never heard of, for the refusal path.
const UNKNOWN_NODE_ID = 424242;
// A node whose credence a human asserted — the stubbed app refuses a display
// write on it, naming the flag.
const FIXED_NODE_ID = 12;
// The grade every happy-path write carries: credence, the uncertainty samai
// derived beside it, and samai's computation stamp.
const WRITTEN_BELIEF_CREDENCE = 0.62;
const WRITTEN_BELIEF_UNCERTAINTY = 0.42;
const WRITTEN_BELIEF_COMPUTED_AT = '2026-08-05T10:00:00.000Z';

// The four display-write input fields, exactly as the tool must declare them.
const displayWriteInputFieldNames = [
  'node_id',
  'belief_credence',
  'belief_uncertainty',
  'belief_computed_at',
];

// Find the requests the stubbed app received for the display endpoint.
function findRecordedDisplayWriteRequests() {
  return remoteMcpDoorHarness
    .recordedAppRequests()
    .filter((entry) => entry.method === 'POST' && entry.pathname === '/api/belief/display');
}

// The structured reply of one tool call, cast to the display-write shape.
function displayWriteStructuredContent(toolResult: unknown): {
  success: boolean;
  node_id: number;
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
} {
  return (toolResult as { structuredContent?: unknown })
    .structuredContent as ReturnType<typeof displayWriteStructuredContent>;
}

// The flattened text of one tool result's content blocks — where a refusal's
// message lives.
function toolResultText(toolResult: unknown): string {
  const contentBlocks = (toolResult as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return contentBlocks.map((block) => block.text ?? '').join('\n');
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  // The stubbed app serves the ONE display endpoint the tool forwards to,
  // answering the stored-row shape the app route answers — including the
  // fixed-node and unknown-node refusals under their own statuses.
  remoteMcpDoorHarness.respondWith((request) => {
    if (request.method === 'POST' && request.pathname === '/api/belief/display') {
      const writtenNodeId = request.body?.node_id as number;
      if (writtenNodeId === UNKNOWN_NODE_ID) {
        return {
          status: 404,
          payload: {
            success: false,
            error: `Cannot write a display belief for node #${UNKNOWN_NODE_ID}: no such node.`,
          },
        };
      }
      if (writtenNodeId === FIXED_NODE_ID) {
        return {
          status: 409,
          payload: {
            success: false,
            error:
              `Node #${FIXED_NODE_ID} has its credence asserted by hand ` +
              '(belief_credence_is_fixed = 1); withdraw the assertion before writing a display belief.',
          },
        };
      }
      // The stored row after the write: the three written columns verbatim
      // (nulls included), flag 0.
      return {
        payload: {
          success: true,
          node_id: writtenNodeId,
          belief_credence: request.body?.belief_credence ?? null,
          belief_uncertainty: request.body?.belief_uncertainty ?? null,
          belief_computed_at: request.body?.belief_computed_at ?? null,
          belief_credence_is_fixed: 0,
          message: `Wrote the display belief of node #${writtenNodeId}.`,
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

describe('remote MCP door advertises the display-belief surface', () => {
  // Discoverability over the MCP handshake: the write tool is listed with an
  // input schema declaring the four fields AND an output schema — while the
  // recompute tool, whose writes would erase samai's, is gone.
  it('lists rah_write_display_belief with its four input fields and an output schema', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const advertisedDisplayWriteTool = listedTools.tools.find(
        (tool) => tool.name === 'rah_write_display_belief'
      );
      expect(
        advertisedDisplayWriteTool,
        'the remote door must advertise rah_write_display_belief'
      ).toBeDefined();
      expect(advertisedDisplayWriteTool?.outputSchema).toBeDefined();

      // Every one of the four input fields is declared by name.
      const declaredInputFieldNames = Object.keys(
        (advertisedDisplayWriteTool?.inputSchema as { properties?: Record<string, unknown> })
          ?.properties ?? {}
      );
      for (const displayWriteInputFieldName of displayWriteInputFieldNames) {
        expect(declaredInputFieldNames).toContain(displayWriteInputFieldName);
      }
    });
  });

  // The recompute tool dies NOW: its never-assessed write would erase the
  // display beliefs this new tool lands.
  it('no longer lists rah_recompute_node_belief', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();
      expect(listedTools.tools.map((tool) => tool.name)).not.toContain(
        'rah_recompute_node_belief'
      );
    });
  });

  // Discoverability over plain HTTP: the GET metadata list says the same
  // thing as the handshake — display tool in, recompute tool out.
  it('names rah_write_display_belief and not rah_recompute_node_belief in the GET metadata tool list', async () => {
    // The harness's bearer credential rides this direct GET too: the door
    // fails closed and refuses an uncredentialed listing.
    const metadataRequest = new Request('http://127.0.0.1/api/mcp', {
      method: 'GET',
      headers: { Authorization: `Bearer ${REMOTE_MCP_DOOR_HARNESS_TOKEN}` },
    }) as unknown as NextRequest;

    const metadataResponse = await GET(metadataRequest);
    const metadata = (await metadataResponse.json()) as { tools: string[] };

    expect(metadata.tools).toContain('rah_write_display_belief');
    expect(metadata.tools).not.toContain('rah_recompute_node_belief');
  });
});

describe('remote MCP door rah_write_display_belief — the two legal shapes', () => {
  // The GRADE in one pass: the four fields forward verbatim to the ONE app
  // endpoint, and the reply is the stored row the app answered.
  it('forwards a GRADE to POST /api/belief/display and answers the stored row', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_write_display_belief',
        arguments: {
          node_id: DISPLAY_WRITE_NODE_ID,
          belief_credence: WRITTEN_BELIEF_CREDENCE,
          belief_uncertainty: WRITTEN_BELIEF_UNCERTAINTY,
          belief_computed_at: WRITTEN_BELIEF_COMPUTED_AT,
        },
      });
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);

      const structuredReply = displayWriteStructuredContent(toolResult);
      expect(structuredReply.success).toBe(true);
      expect(structuredReply.node_id).toBe(DISPLAY_WRITE_NODE_ID);
      expect(structuredReply.belief_credence).toBe(WRITTEN_BELIEF_CREDENCE);
      expect(structuredReply.belief_uncertainty).toBe(WRITTEN_BELIEF_UNCERTAINTY);
      expect(structuredReply.belief_computed_at).toBe(WRITTEN_BELIEF_COMPUTED_AT);
      expect(structuredReply.belief_credence_is_fixed).toBe(0);
    });

    // Exactly one app request, to the display endpoint, carrying the body
    // verbatim — and in particular NO recompute call rides along.
    const recordedAppRequests = remoteMcpDoorHarness.recordedAppRequests();
    expect(recordedAppRequests).toHaveLength(1);
    expect(recordedAppRequests[0].pathname).toBe('/api/belief/display');
    expect(recordedAppRequests[0].body).toEqual({
      node_id: DISPLAY_WRITE_NODE_ID,
      belief_credence: WRITTEN_BELIEF_CREDENCE,
      belief_uncertainty: WRITTEN_BELIEF_UNCERTAINTY,
      belief_computed_at: WRITTEN_BELIEF_COMPUTED_AT,
    });
  });

  // The UNGRADE: all three null is the second legal shape, forwarded intact
  // and answered with the stored nulls.
  it('forwards an UNGRADE (all three null) and answers the stored nulls', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_write_display_belief',
        arguments: {
          node_id: DISPLAY_WRITE_NODE_ID,
          belief_credence: null,
          belief_uncertainty: null,
          belief_computed_at: null,
        },
      });
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);

      const structuredReply = displayWriteStructuredContent(toolResult);
      expect(structuredReply.belief_credence).toBeNull();
      expect(structuredReply.belief_uncertainty).toBeNull();
      expect(structuredReply.belief_computed_at).toBeNull();
      expect(structuredReply.belief_credence_is_fixed).toBe(0);
    });

    expect(findRecordedDisplayWriteRequests()).toHaveLength(1);
  });

  // Credence's interval is CLOSED here — samai's engine may derive the
  // endpoints — and uncertainty's top end 1 is legal.
  it('accepts credence -1 with uncertainty 1 and forwards them verbatim', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_write_display_belief',
        arguments: {
          node_id: DISPLAY_WRITE_NODE_ID,
          belief_credence: -1,
          belief_uncertainty: 1,
          belief_computed_at: WRITTEN_BELIEF_COMPUTED_AT,
        },
      });
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      expect(displayWriteStructuredContent(toolResult).belief_credence).toBe(-1);
    });

    const forwardedDisplayWrites = findRecordedDisplayWriteRequests();
    expect(forwardedDisplayWrites).toHaveLength(1);
    expect(forwardedDisplayWrites[0].body?.belief_credence).toBe(-1);
    expect(forwardedDisplayWrites[0].body?.belief_uncertainty).toBe(1);
  });
});

describe('remote MCP door rah_write_display_belief — refusals', () => {
  // A mixture is neither shape: refused DOOR-SIDE with a message naming the
  // two legal shapes, and nothing is sent to the app.
  it('refuses a mixture of nulls and values naming the two shapes, sending nothing to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_write_display_belief',
        arguments: {
          node_id: DISPLAY_WRITE_NODE_ID,
          belief_credence: WRITTEN_BELIEF_CREDENCE,
          belief_uncertainty: null,
          belief_computed_at: null,
        },
      });
      expect((toolResult as { isError?: boolean }).isError).toBe(true);
      // The message names both legal shapes: all three non-null, or all
      // three null.
      expect(toolResultText(toolResult)).toMatch(/all three/i);
    });

    expect(findRecordedDisplayWriteRequests()).toHaveLength(0);
  });

  // Out-of-interval numbers are refused at the door's own schema, before a
  // request exists: uncertainty 0 is the dogmatic opinion (not writable
  // here), and 1.5 is outside every interval in the system. The refusal must
  // come from the REGISTERED tool's schema — the "Tool ... not found" error
  // is excluded so this cannot pass merely because the tool does not exist.
  it('refuses uncertainty 0 and out-of-interval numbers, sending nothing to the app', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      // Uncertainty 0: reserved for a hand-asserted credence.
      const zeroUncertaintyResult = await client.callTool({
        name: 'rah_write_display_belief',
        arguments: {
          node_id: DISPLAY_WRITE_NODE_ID,
          belief_credence: WRITTEN_BELIEF_CREDENCE,
          belief_uncertainty: 0,
          belief_computed_at: WRITTEN_BELIEF_COMPUTED_AT,
        },
      });
      expect((zeroUncertaintyResult as { isError?: boolean }).isError).toBe(true);
      expect(toolResultText(zeroUncertaintyResult)).not.toMatch(/not found/i);

      // A credence beyond the closed interval.
      const oversizedCredenceResult = await client.callTool({
        name: 'rah_write_display_belief',
        arguments: {
          node_id: DISPLAY_WRITE_NODE_ID,
          belief_credence: 1.5,
          belief_uncertainty: WRITTEN_BELIEF_UNCERTAINTY,
          belief_computed_at: WRITTEN_BELIEF_COMPUTED_AT,
        },
      });
      expect((oversizedCredenceResult as { isError?: boolean }).isError).toBe(true);
      expect(toolResultText(oversizedCredenceResult)).not.toMatch(/not found/i);
    });

    expect(findRecordedDisplayWriteRequests()).toHaveLength(0);
  });

  // The app's fixed-node refusal passes through naming the flag: only the
  // assert/clear tools change a hand-asserted credence.
  it('surfaces the fixed-node refusal naming belief_credence_is_fixed', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_write_display_belief',
        arguments: {
          node_id: FIXED_NODE_ID,
          belief_credence: WRITTEN_BELIEF_CREDENCE,
          belief_uncertainty: WRITTEN_BELIEF_UNCERTAINTY,
          belief_computed_at: WRITTEN_BELIEF_COMPUTED_AT,
        },
      });
      expect((toolResult as { isError?: boolean }).isError).toBe(true);
      expect(toolResultText(toolResult)).toContain('belief_credence_is_fixed');
    });
  });

  // The app's unknown-node refusal passes through naming the node.
  it('surfaces the unknown-node refusal naming the node', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_write_display_belief',
        arguments: {
          node_id: UNKNOWN_NODE_ID,
          belief_credence: WRITTEN_BELIEF_CREDENCE,
          belief_uncertainty: WRITTEN_BELIEF_UNCERTAINTY,
          belief_computed_at: WRITTEN_BELIEF_COMPUTED_AT,
        },
      });
      expect((toolResult as { isError?: boolean }).isError).toBe(true);
      expect(toolResultText(toolResult)).toContain(String(UNKNOWN_NODE_ID));
    });
  });
});
