/**
 * ALL THREE MCP DOORS EXPOSE THE V2 UN-FIX DOOR
 * (docs/belief-model-subjective-logic.md §2, "an un-fix door", and §7).
 *
 * The two APP-BACKED doors — local (apps/mcp-server/stdio-server.js) and
 * remote (app/api/mcp/route.ts) — must advertise
 * rah_clear_belief_fixed_credence with IDENTICAL input and output schemas,
 * taken from the one shared contract module
 * (src/services/belief/beliefMcpToolContract.js) exactly like the three
 * existing belief tools; same thesis and same seam as
 * tests/unit/mcp/mcp-doors-agree-on-belief-tool-surface.test.ts.
 *
 * The STANDALONE door (apps/mcp-server-standalone/index.js) is the third
 * door here — unlike the recompute/movements tools it DOES gain the un-fix
 * twin, because it already owns setBeliefFixedCredence and an assertion made
 * through it must be withdrawable through it. It advertises the twin under
 * its own camelCase naming (clearBeliefFixedCredence, beside
 * setBeliefFixedCredence) with a MATCHING input surface: node_id and nothing
 * else. What the standalone clear does about regrading is a Reviewer
 * question (the standalone server never grades); only the advertised surface
 * is pinned here.
 *
 * Seams: the remote door through remoteMcpDoorHarness, the local door
 * spawned against the same app stub, the standalone door spawned over an
 * init-db'd temp database. Every spawned process is terminated in a finally
 * block; every database is a temp file under the OS tmpdir.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The un-fix tool's name on the two app-backed doors, following the belief
// tool naming of the existing surface.
const APP_DOOR_UNFIX_TOOL_NAME = 'rah_clear_belief_fixed_credence';
// The un-fix tool's name on the standalone door, the camelCase twin of its
// existing setBeliefFixedCredence.
const STANDALONE_UNFIX_TOOL_NAME = 'clearBeliefFixedCredence';

// The live remote-door harness, which also owns the shared app stub.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;
// Every tool the local door advertises, read once and reused by every test.
let localDoorTools: Tool[] = [];
// Every tool the remote door advertises, read once and reused.
let remoteDoorTools: Tool[] = [];
// Every tool the standalone door advertises, read once and reused.
let standaloneDoorTools: Tool[] = [];
// Temp directory holding the standalone door's database and fake HOME.
let standaloneTempRoot: string;

// Read every tool the LOCAL app-backed door advertises, spawning it against
// the shared app stub and always terminating the process afterwards.
async function readLocalDoorTools(raHAppStubBaseUrl: string): Promise<Tool[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), 'apps', 'mcp-server', 'stdio-server.js')],
    cwd: process.cwd(),
    env: { ...process.env, RAH_MCP_TARGET_URL: raHAppStubBaseUrl } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ra-h-belief-unfix-door-agree-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await transport.close();
  }
}

// Read every tool the STANDALONE door advertises: init-db a fresh temp
// database first (so the server has a schema to open), then spawn the server
// over it with HOME pinned into the temp root, terminating it afterwards.
async function readStandaloneDoorTools(): Promise<Tool[]> {
  const standaloneEntryPath = path.join(
    process.cwd(),
    'apps',
    'mcp-server-standalone',
    'index.js'
  );
  const standaloneDbPath = path.join(standaloneTempRoot, 'standalone-unfix-door.sqlite');
  const initDbResult = spawnSync(process.execPath, [standaloneEntryPath, 'init-db'], {
    cwd: process.cwd(),
    env: { ...process.env, RAH_DB_PATH: standaloneDbPath, HOME: standaloneTempRoot },
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(initDbResult.status, `standalone init-db stderr: ${initDbResult.stderr}`).toBe(0);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [standaloneEntryPath],
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAH_DB_PATH: standaloneDbPath,
      HOME: standaloneTempRoot,
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ra-h-standalone-unfix-door-test', version: '1.0.0' });
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
  standaloneTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-unfix-door-test-'));
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  // No test here calls a tool — only lists them — so the stub serves nothing.
  remoteMcpDoorHarness.respondWith(() => undefined);

  localDoorTools = await readLocalDoorTools(remoteMcpDoorHarness.raHAppStubBaseUrl);
  remoteDoorTools = await remoteMcpDoorHarness.withRemoteMcpClient(
    async (client) => (await client.listTools()).tools
  );
  standaloneDoorTools = await readStandaloneDoorTools();
}, 60000);

afterAll(async () => {
  await remoteMcpDoorHarness.stop();
  fs.rmSync(standaloneTempRoot, { recursive: true, force: true });
});

describe('the two app-backed MCP doors agree on the un-fix door', () => {
  // An agent that learns the un-fix tool from one door must be able to call
  // it identically through the other. Deep equality, because both doors must
  // take the schemas from the one shared contract module.
  it(`advertises an identical input and output schema for ${APP_DOOR_UNFIX_TOOL_NAME}`, () => {
    const localUnfixTool = findAdvertisedTool(localDoorTools, APP_DOOR_UNFIX_TOOL_NAME, 'local');
    const remoteUnfixTool = findAdvertisedTool(remoteDoorTools, APP_DOOR_UNFIX_TOOL_NAME, 'remote');

    expect(remoteUnfixTool.inputSchema).toEqual(localUnfixTool.inputSchema);
    expect(
      localUnfixTool.outputSchema,
      `the local door must declare an output schema for ${APP_DOOR_UNFIX_TOOL_NAME}`
    ).toBeDefined();
    expect(remoteUnfixTool.outputSchema).toEqual(localUnfixTool.outputSchema);
  });

  // The one argument is the node whose assertion is withdrawn — a credence
  // argument here would contradict the door's meaning (the engine grades now).
  it('takes node_id as its only input property on both app doors', () => {
    for (const [doorName, tools] of [
      ['local', localDoorTools],
      ['remote', remoteDoorTools],
    ] as const) {
      const unfixTool = findAdvertisedTool(tools, APP_DOOR_UNFIX_TOOL_NAME, doorName);
      const inputProperties = (unfixTool.inputSchema as { properties?: Record<string, unknown> })
        .properties;
      expect(Object.keys(inputProperties ?? {}), `${doorName} door input properties`).toEqual([
        'node_id',
      ]);
    }
  });

  // The vocabulary holds at the advertised surface: the banned credence
  // synonyms must not appear anywhere on the new tool.
  it('GUARD: neither app door advertises a banned credence synonym on the un-fix tool', () => {
    // The banned synonyms, checked against the tool's whole advertised JSON.
    const bannedCredenceSynonyms = ['trust', 'standing', 'score', 'weight'];

    for (const [doorName, tools] of [
      ['local', localDoorTools],
      ['remote', remoteDoorTools],
    ] as const) {
      const unfixTool = findAdvertisedTool(tools, APP_DOOR_UNFIX_TOOL_NAME, doorName);
      const advertisedToolJson = JSON.stringify(unfixTool).toLowerCase();
      for (const bannedSynonym of bannedCredenceSynonyms) {
        expect(
          advertisedToolJson,
          `the ${doorName} door must not say "${bannedSynonym}" anywhere on ${APP_DOOR_UNFIX_TOOL_NAME}`
        ).not.toContain(bannedSynonym);
      }
    }
  });
});

describe('the standalone door carries the un-fix twin', () => {
  // The standalone door owns setBeliefFixedCredence, so an assertion made
  // while the app was closed must be withdrawable through the same door.
  it(`advertises ${STANDALONE_UNFIX_TOOL_NAME} beside setBeliefFixedCredence`, () => {
    findAdvertisedTool(standaloneDoorTools, 'setBeliefFixedCredence', 'standalone');
    findAdvertisedTool(standaloneDoorTools, STANDALONE_UNFIX_TOOL_NAME, 'standalone');
  });

  // The twin's input surface matches the app doors': node_id and nothing
  // else, so the three doors ask the same question in the same shape.
  it('takes node_id as its only input property, matching the app doors', () => {
    const standaloneUnfixTool = findAdvertisedTool(
      standaloneDoorTools,
      STANDALONE_UNFIX_TOOL_NAME,
      'standalone'
    );
    const inputProperties = (
      standaloneUnfixTool.inputSchema as { properties?: Record<string, unknown> }
    ).properties;
    expect(Object.keys(inputProperties ?? {})).toEqual(['node_id']);
  });
});
