/**
 * THE TWO APP-BACKED MCP DOORS SAY THE SAME THING ABOUT THE BELIEF SURFACE
 * THAT REMAINS: the node-read belief columns on rah_get_nodes.
 *
 * deleted in the engine-leaves-the-fork slice: the identical-schema and
 * banned-synonym describes over rah_set_belief_fixed_credence and
 * rah_get_belief_movements — those tools are gone from both doors (the
 * absences are pinned per door in
 * remote-mcp-route-belief-surface-reduced-to-display.test.ts and
 * stdio-server-belief-surface-reduced-to-node-reads.test.ts).
 * rah_write_display_belief is deliberately NOT compared here: it is
 * remote-only, so there is no cross-door agreement to pin (pinned in
 * remote-mcp-route-display-belief-tool.test.ts and
 * stdio-server-display-belief-surface.test.ts).
 *
 * Same thesis as tests/unit/mcp/mcp-doors-agree-on-belief.test.ts: RA-H
 * serves the same rah_* tools from the local door
 * (apps/mcp-server/stdio-server.js) and the remote door (app/api/mcp/route.ts),
 * and a contract declared twice is a contract that drifts. Both doors take
 * the node-read belief fragment from the one shared module
 * src/services/belief/beliefMcpToolContract.js, so agreement is structural —
 * and this file is what notices if either door stops using it.
 *
 * The comparison is of ADVERTISED contracts, because the contract is what an
 * external agent (samai-diagnostic's adapters) actually reads.
 *
 * Seam: the remote door through tests/unit/mcp/helpers/remoteMcpDoorHarness.ts,
 * the local door spawned as a real child process — both pointed at the SAME
 * in-process app stub, which serves nothing because no test here calls a
 * tool. The spawned process is always terminated in a finally block.
 */

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live remote-door harness, which also owns the shared app stub.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;
// Every tool the local door advertises, read once and reused by every test.
let localDoorTools: Tool[] = [];
// Every tool the remote door advertises, read once and reused.
let remoteDoorTools: Tool[] = [];

// The three belief columns a node read reports, compared field by field on
// rah_get_nodes because that tool has an upstream half the doors may
// legitimately phrase differently.
const beliefNodeReadFieldNames = [
  'belief_credence',
  'belief_computed_at',
  'belief_credence_is_fixed',
];

// Read every tool the local door advertises, spawning it against the shared
// app stub and always terminating the process afterwards.
async function readLocalDoorTools(raHAppStubBaseUrl: string): Promise<Tool[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), 'apps', 'mcp-server', 'stdio-server.js')],
    cwd: process.cwd(),
    env: { ...process.env, RAH_MCP_TARGET_URL: raHAppStubBaseUrl } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ra-h-belief-tool-surface-agree-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await transport.close();
  }
}

// Find one advertised tool by name, failing readably if a door lacks it.
function findAdvertisedTool(tools: Tool[], toolName: string, doorName: string): Tool {
  const advertisedTool = tools.find((tool) => tool.name === toolName);
  expect(advertisedTool, `the ${doorName} door must advertise ${toolName}`).toBeDefined();
  return advertisedTool as Tool;
}

// The JSON-Schema fragment a node-read tool advertises for one property of
// each node it returns, reached through the array item schema.
function nodeReadOutputPropertySchema(advertisedTool: Tool, propertyName: string): unknown {
  const outputSchema = advertisedTool.outputSchema as
    | { properties?: { nodes?: { items?: { properties?: Record<string, unknown> } } } }
    | undefined;
  return outputSchema?.properties?.nodes?.items?.properties?.[propertyName];
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  // Neither door is asked to call the app in this file — only to describe
  // itself — so the stub serves nothing and 404s anything unexpected.
  remoteMcpDoorHarness.respondWith(() => undefined);

  localDoorTools = await readLocalDoorTools(remoteMcpDoorHarness.raHAppStubBaseUrl);
  remoteDoorTools = await remoteMcpDoorHarness.withRemoteMcpClient(
    async (client) => (await client.listTools()).tools
  );
}, 60000);

afterAll(async () => {
  await remoteMcpDoorHarness.stop();
});

describe('both MCP doors advertise the same belief columns on the node read', () => {
  for (const beliefFieldName of beliefNodeReadFieldNames) {
    // An agent reading a node's belief must get the same shape from either
    // door — including nullability, which is what carries "nobody has
    // grounded this node" as a state distinct from a credence of 0.
    it(`advertises an identical ${beliefFieldName} on rah_get_nodes`, () => {
      const localGetNodesTool = findAdvertisedTool(localDoorTools, 'rah_get_nodes', 'local');
      const remoteGetNodesTool = findAdvertisedTool(remoteDoorTools, 'rah_get_nodes', 'remote');

      const localBeliefFieldSchema = nodeReadOutputPropertySchema(
        localGetNodesTool,
        beliefFieldName
      );
      const remoteBeliefFieldSchema = nodeReadOutputPropertySchema(
        remoteGetNodesTool,
        beliefFieldName
      );

      expect(
        localBeliefFieldSchema,
        `the local door must advertise ${beliefFieldName} on the rah_get_nodes output schema`
      ).toBeDefined();
      expect(
        remoteBeliefFieldSchema,
        `the remote door must advertise ${beliefFieldName} on the rah_get_nodes output schema`
      ).toBeDefined();
      // Deep equality, because both doors take the fragment from the shared
      // contract's node-read fields.
      expect(remoteBeliefFieldSchema).toEqual(localBeliefFieldSchema);
    });
  }
});
