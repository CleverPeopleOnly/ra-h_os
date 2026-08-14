/**
 * FAILING-FIRST red set for slice 9 — THE ENGINE AND BELIEF SERVICES LEAVE
 * THE FORK: the REMOTE MCP door's belief surface shrinks to the display
 * write (app/api/mcp/route.ts).
 *
 * samai owns the belief engine, so the door tools that asserted, withdrew,
 * or replayed belief are deleted:
 *  - rah_set_belief_fixed_credence,
 *  - rah_clear_belief_fixed_credence,
 *  - rah_get_belief_movements (its table is dropped in the same slice).
 * The survivors this slice must NOT touch are the display write and the
 * graph-event journal pair — samai's write path and read path into the fork.
 *
 * Seam: tests/unit/mcp/helpers/remoteMcpDoorHarness.ts, the same harness as
 * remote-mcp-route-graph-event-tools.test.ts — a real MCP client over the
 * real transport into the exported POST handler, with an in-process stub
 * standing in for the RA-H app. No tool in this file may reach the app, so
 * the stub deliberately serves nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { GET } from '../../../app/api/mcp/route';
import {
  REMOTE_MCP_DOOR_HARNESS_TOKEN,
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live harness for this file.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;

// The three belief tools deleted from this door with the engine.
const deletedBeliefToolNames = [
  'rah_set_belief_fixed_credence',
  'rah_clear_belief_fixed_credence',
  'rah_get_belief_movements',
];

// The tools this slice must leave standing: samai's display write and the
// graph-event journal pair.
const survivingRemoteDoorToolNames = [
  'rah_write_display_belief',
  'rah_read_graph_events',
  'rah_acknowledge_graph_events',
];

// Plausible arguments for each dead tool, so a call that still reaches a
// registered handler exercises its real path (and demonstrably answers as a
// living tool) instead of bouncing off input validation.
const deadToolCallArguments: Record<string, Record<string, unknown>> = {
  rah_set_belief_fixed_credence: { node_id: 1, belief_credence: 0.5 },
  rah_clear_belief_fixed_credence: { node_id: 1 },
  rah_get_belief_movements: { node_id: 1 },
};

// The flattened text of one tool result's content blocks — where an
// unknown-tool answer's message lives when the door answers in-band.
function toolResultText(toolResult: unknown): string {
  const contentBlocks =
    (toolResult as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return contentBlocks.map((block) => block.text ?? '').join('\n');
}

/**
 * Call one deleted tool by name and demand the unknown-tool answer. The MCP
 * SDK surfaces an unregistered name either as a thrown protocol error or as
 * an isError result whose text says the tool was not found — both count as
 * "unregistered"; anything else means a handler still answered.
 */
async function expectDeadToolToAnswerUnknown(client: Client, deadToolName: string): Promise<void> {
  // Whatever text the door answered with, from either channel.
  let doorAnswerText: string;
  try {
    const toolResult = await client.callTool({
      name: deadToolName,
      arguments: deadToolCallArguments[deadToolName],
    });
    // A registered tool answering success is the clearest possible failure:
    // the handler is still alive.
    expect(
      (toolResult as { isError?: boolean }).isError ?? false,
      `${deadToolName} answered as a registered tool — it must be deleted from the remote door`
    ).toBe(true);
    doorAnswerText = toolResultText(toolResult);
  } catch (thrownByDoor) {
    doorAnswerText = String((thrownByDoor as Error).message ?? thrownByDoor);
  }
  // Whichever channel it came through, the answer must be the unknown-tool
  // one — a handler that merely errored for some other reason still exists.
  expect(
    doorAnswerText,
    `${deadToolName} must be unregistered, not merely failing`
  ).toMatch(/not found|unknown tool/i);
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
});

afterAll(async () => {
  await remoteMcpDoorHarness.stop();
});

beforeEach(() => {
  // Nothing in this file may reach the app: an unstubbed call 404s loudly.
  remoteMcpDoorHarness.respondWith(() => undefined);
  remoteMcpDoorHarness.resetRecordedAppRequests();
});

describe('remote MCP door belief surface after the engine leaves the fork', () => {
  // The whole registry statement in one read: the three engine-era belief
  // tools are gone from tools/list, while the display write and the journal
  // pair stand untouched — proving the deletion cut exactly where planned.
  it('lists neither fixed-credence tool nor the movements read, and still lists the display write and journal tools', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const advertisedToolNames = (await client.listTools()).tools.map((tool) => tool.name);

      for (const deletedBeliefToolName of deletedBeliefToolNames) {
        expect(
          advertisedToolNames,
          `${deletedBeliefToolName} must leave the remote door with the engine`
        ).not.toContain(deletedBeliefToolName);
      }
      for (const survivingToolName of survivingRemoteDoorToolNames) {
        expect(
          advertisedToolNames,
          `${survivingToolName} must survive this slice untouched`
        ).toContain(survivingToolName);
      }
    });
  });

  // Deletion is not merely unadvertising: calling each dead name must come
  // back as an unknown tool, so no hidden handler keeps serving callers that
  // remember the old surface.
  for (const deletedBeliefToolName of deletedBeliefToolNames) {
    it(`a tools/call to ${deletedBeliefToolName} answers unknown-tool`, async () => {
      await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
        await expectDeadToolToAnswerUnknown(client, deletedBeliefToolName);
      });
      // And nothing was forwarded to the app on the way to that answer.
      expect(
        remoteMcpDoorHarness.recordedAppRequests(),
        'an unknown tool must send nothing to the app'
      ).toHaveLength(0);
    });
  }

  // Discoverability over plain HTTP: the GET metadata handler's advertised
  // tool list must shed the three dead names too — it is the list an
  // external agent reads before ever opening an MCP session.
  it('the GET discovery list names none of the three dead belief tools', async () => {
    // The harness's bearer credential rides this direct GET: the door fails
    // closed and refuses an uncredentialed listing.
    const metadataRequest = new Request('http://127.0.0.1/api/mcp', {
      method: 'GET',
      headers: { Authorization: `Bearer ${REMOTE_MCP_DOOR_HARNESS_TOKEN}` },
    }) as unknown as NextRequest;

    const metadataResponse = await GET(metadataRequest);
    const metadata = (await metadataResponse.json()) as { tools: string[] };

    for (const deletedBeliefToolName of deletedBeliefToolNames) {
      expect(
        metadata.tools,
        `${deletedBeliefToolName} must leave the GET discovery list with the engine`
      ).not.toContain(deletedBeliefToolName);
    }
    // Sanity: the discovery list still advertises the surviving display
    // write, so this test is reading a live list rather than an empty one.
    expect(metadata.tools).toContain('rah_write_display_belief');
  });
});
