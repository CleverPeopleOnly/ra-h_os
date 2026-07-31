/**
 * The MR's thesis, pinned directly: THE TWO APP-BACKED MCP DOORS SAY THE SAME
 * THING ABOUT BELIEF.
 *
 * RA-H serves the same rah_* tools from two separate files — the local door
 * (apps/mcp-server/stdio-server.js, CommonJS, spawned as a child process) and
 * the remote door (app/api/mcp/route.ts, TypeScript inside Next). Because the
 * tools are declared twice, the belief surface drifted: every belief change
 * this fork has made landed on the local door, and none on the remote one.
 * The other files in this MR pin each door's behaviour on its own. This file
 * pins the thing neither of those can see — that the two AGREE.
 *
 * It compares the advertised contracts rather than the handler bodies, because
 * the contract is what an external agent actually reads, and a difference here
 * is exactly what would mislead one. Both doors take these pieces from the one
 * shared module src/services/belief/beliefMcpToolContract.js, so agreement
 * should be structural rather than a coincidence anyone has to maintain.
 *
 * Deliberately narrow: only the BELIEF-owned pieces are compared. The two
 * doors legitimately differ elsewhere (instructions text, server name and
 * version, which tools they expose), and this fork merges upstream, so
 * demanding whole-schema equality would fail on the next upstream sync for no
 * belief reason.
 *
 * Seam: the remote door through tests/unit/mcp/helpers/remoteMcpDoorHarness.ts,
 * the local door spawned as a real child process with a real MCP client —
 * both pointed at the SAME in-process app stub. The spawned process is always
 * terminated in a finally block, so no orphan survives a failure.
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

// Both write tools carry the support input schema, so both are compared.
const writeToolsCarryingSupport = ['rah_create_edge', 'rah_update_edge'];
// The two belief columns an edge read reports.
const beliefEdgeReadFieldNames = ['belief_evidence_support', 'belief_evidence_contribution'];

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
  const client = new Client({ name: 'ra-h-doors-agree-test', version: '1.0.0' });
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

// The JSON-Schema fragment a tool advertises for one input property.
function inputPropertySchema(advertisedTool: Tool, propertyName: string): unknown {
  const properties = (advertisedTool.inputSchema as { properties?: Record<string, unknown> })
    .properties;
  return properties?.[propertyName];
}

// The JSON-Schema fragment an edge-read tool advertises for one property of
// each edge it returns, reached through the array item schema.
function edgeReadOutputPropertySchema(advertisedTool: Tool, propertyName: string): unknown {
  const outputSchema = advertisedTool.outputSchema as
    | { properties?: { edges?: { items?: { properties?: Record<string, unknown> } } } }
    | undefined;
  return outputSchema?.properties?.edges?.items?.properties?.[propertyName];
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

describe('both MCP doors advertise the same belief_evidence_support write contract', () => {
  for (const writeToolName of writeToolsCarryingSupport) {
    // The headline agreement: an agent that learns how to record evidence from
    // one door must be able to record it identically through the other —
    // same field name, same range, same description of what omission means.
    it(`advertises an identical belief_evidence_support on ${writeToolName}`, () => {
      const localTool = findAdvertisedTool(localDoorTools, writeToolName, 'local');
      const remoteTool = findAdvertisedTool(remoteDoorTools, writeToolName, 'remote');

      const localSupportSchema = inputPropertySchema(localTool, 'belief_evidence_support');
      const remoteSupportSchema = inputPropertySchema(remoteTool, 'belief_evidence_support');

      expect(
        localSupportSchema,
        `the local door must advertise belief_evidence_support on ${writeToolName}`
      ).toBeDefined();
      expect(
        remoteSupportSchema,
        `the remote door must advertise belief_evidence_support on ${writeToolName}`
      ).toBeDefined();
      // Deep equality, because both doors take this schema from the one shared
      // contract. Any difference means they have started to drift again.
      expect(remoteSupportSchema).toEqual(localSupportSchema);
    });

    // GUARD (passes before and after): the confirmation gate guards every edge
    // write on both doors and already agrees. Adding evidence to the remote
    // door's write tools must not disturb it — a door that quietly dropped it
    // would let an agent write relationships the user never confirmed.
    it(`GUARD: requires confirmed_by_user on ${writeToolName} at both doors`, () => {
      for (const [doorName, tools] of [
        ['local', localDoorTools],
        ['remote', remoteDoorTools],
      ] as const) {
        const advertisedTool = findAdvertisedTool(tools, writeToolName, doorName);
        const requiredProperties =
          (advertisedTool.inputSchema as { required?: string[] }).required ?? [];
        expect(
          requiredProperties,
          `the ${doorName} door must require confirmed_by_user on ${writeToolName}`
        ).toContain('confirmed_by_user');
      }
    });
  }
});

describe('both MCP doors advertise the same belief edge-read contract', () => {
  for (const beliefFieldName of beliefEdgeReadFieldNames) {
    // An agent reading evidence must get the same shape from either door,
    // including that the field is nullable — which is what carries "this edge
    // is not evidence at all" and "this edge has never been graded".
    it(`advertises an identical ${beliefFieldName} on rah_query_edges`, () => {
      const localTool = findAdvertisedTool(localDoorTools, 'rah_query_edges', 'local');
      const remoteTool = findAdvertisedTool(remoteDoorTools, 'rah_query_edges', 'remote');

      const localFieldSchema = edgeReadOutputPropertySchema(localTool, beliefFieldName);
      const remoteFieldSchema = edgeReadOutputPropertySchema(remoteTool, beliefFieldName);

      expect(
        localFieldSchema,
        `the local door must advertise ${beliefFieldName} on the rah_query_edges output schema`
      ).toBeDefined();
      expect(
        remoteFieldSchema,
        `the remote door must advertise ${beliefFieldName} on the rah_query_edges output schema`
      ).toBeDefined();
      expect(remoteFieldSchema).toEqual(localFieldSchema);
    });
  }

  // GUARD (passes before and after, for a reason worth stating): the banned
  // word is checked across the whole ADVERTISED surface of both doors. It
  // passes today only because the remote door declares no output schema at
  // all, so its `weight` never reaches the advertised contract — the live
  // defect is in what that door RETURNS, and it is pinned in
  // tests/unit/mcp/remote-mcp-route-belief-edge-reads.test.ts. Once the door
  // declares an output schema this guard starts earning its keep: `weight` is
  // banned as a synonym for credence anywhere in belief code, and it must not
  // reappear in the contract an agent reads.
  it('GUARD: neither door advertises a weight field anywhere on rah_query_edges', () => {
    for (const [doorName, tools] of [
      ['local', localDoorTools],
      ['remote', remoteDoorTools],
    ] as const) {
      const queryEdgesTool = findAdvertisedTool(tools, 'rah_query_edges', doorName);
      expect(
        JSON.stringify(queryEdgesTool),
        `the ${doorName} door must not advertise a weight field`
      ).not.toContain('weight');
    }
  });
});
