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
 * is exactly what would mislead one.
 *
 * deleted in the evidence-leaves-the-edges-table slice: the
 * belief_evidence_support write-contract parity describe and the belief
 * edge-read contract parity describe — the edge tools shed the evidence
 * surface entirely (pinned per door in the *-edge-tools-shed-evidence
 * files), so there is no evidence contract left to agree on. The two guards
 * below survive: the confirmation gate and the banned weight field.
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

// The two edge write tools whose guards are compared across the doors.
const edgeWriteToolNames = ['rah_create_edge', 'rah_update_edge'];

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

describe('both MCP doors keep the shared edge-tool guards', () => {
  for (const writeToolName of edgeWriteToolNames) {
    // GUARD: the confirmation gate guards every edge write on both doors and
    // already agrees — a door that quietly dropped it would let an agent
    // write relationships the user never confirmed.
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

  // GUARD: the banned word is checked across the whole ADVERTISED surface of
  // both doors — `weight` is banned as a synonym for credence anywhere in
  // belief code, and it must not reappear in the contract an agent reads.
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
