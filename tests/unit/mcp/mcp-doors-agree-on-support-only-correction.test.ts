/**
 * BOTH MCP DOORS SAY THE SAME THING ABOUT A SUPPORT-ONLY EDGE CORRECTION.
 *
 * RA-H serves the same rah_* tools from two separate files — the local door
 * (apps/mcp-server/stdio-server.js, CommonJS, spawned as a child process) and
 * the remote door (app/api/mcp/route.ts, TypeScript inside Next). Because the
 * tools are declared twice the belief surface drifted once already, which is
 * what tests/unit/mcp/mcp-doors-agree-on-belief.test.ts was written to stop.
 * This file is that same idea for the newer behaviour: making `explanation`
 * optional and `belief_evidence_support` nullable is TWO edits in TWO files,
 * so it is precisely the shape of change that lands on one door only.
 *
 * Unlike the earlier agreement file, this one compares more than the advertised
 * contracts: it drives BOTH doors with the identical tool arguments against the
 * SAME app stub and compares the request bodies they produce. The body is where
 * the danger lives — a door that keeps sending `context: { created_via: 'mcp' }`
 * on a support-only correction destroys the stored explanation, and no schema
 * comparison would ever see it.
 *
 * Deliberately narrow: only the support-correction behaviour is compared. The
 * two doors legitimately differ elsewhere (instructions text, server name and
 * version, which tools they expose), and this fork merges upstream, so
 * demanding whole-schema equality would fail on the next upstream sync for no
 * belief reason.
 *
 * Seam: the remote door through tests/unit/mcp/helpers/remoteMcpDoorHarness.ts,
 * the local door spawned as a real child process with a real MCP client — both
 * pointed at the SAME in-process app stub. The spawned process is always
 * terminated in a finally block, so no orphan survives a failure.
 */

import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

// The edge id every correction in this file is aimed at.
const CORRECTED_EDGE_ID = 42;

// The tool arguments of a support-only correction: no explanation at all, which
// is the case both doors currently refuse.
const supportOnlyCorrectionToolArguments = {
  id: CORRECTED_EDGE_ID,
  confirmed_by_user: true,
  belief_evidence_support: 0.4,
};

// The tool arguments of an un-assessment: support explicitly null, again with
// no explanation, returning a graded evidence edge to a plain relationship.
const unassessingCorrectionToolArguments = {
  id: CORRECTED_EDGE_ID,
  confirmed_by_user: true,
  belief_evidence_support: null,
};

// Run one MCP client against the LOCAL door, pointed at the shared app stub,
// always terminating the spawned process afterwards.
async function withLocalMcpDoorClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), 'apps', 'mcp-server', 'stdio-server.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAH_MCP_TARGET_URL: remoteMcpDoorHarness.raHAppStubBaseUrl,
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ra-h-doors-agree-support-only-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// The body of the PUT /api/edges/<id> request the shared stub last recorded.
function findRecordedUpdateEdgeBody(): Record<string, unknown> | null | undefined {
  return remoteMcpDoorHarness
    .recordedAppRequests()
    .find((entry) => entry.method === 'PUT' && entry.pathname === `/api/edges/${CORRECTED_EDGE_ID}`)
    ?.body;
}

/**
 * Drive BOTH doors with the same rah_update_edge arguments and return the PUT
 * body each one produced, so the two can be compared directly. Each door is
 * driven against a freshly reset recorder so the bodies cannot be confused.
 */
async function updateEdgeBodyFromEachDoor(
  updateEdgeArguments: Record<string, unknown>
): Promise<{ localDoorBody: unknown; remoteDoorBody: unknown }> {
  remoteMcpDoorHarness.resetRecordedAppRequests();
  await withLocalMcpDoorClient(async (client) => {
    await client.callTool({ name: 'rah_update_edge', arguments: updateEdgeArguments });
  });
  const localDoorBody = findRecordedUpdateEdgeBody();

  remoteMcpDoorHarness.resetRecordedAppRequests();
  await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
    await client.callTool({ name: 'rah_update_edge', arguments: updateEdgeArguments });
  });
  const remoteDoorBody = findRecordedUpdateEdgeBody();

  return { localDoorBody, remoteDoorBody };
}

// Find one advertised tool by name, failing readably if a door lacks it.
function findAdvertisedTool(tools: Tool[], toolName: string, doorName: string): Tool {
  const advertisedTool = tools.find((tool) => tool.name === toolName);
  expect(advertisedTool, `the ${doorName} door must advertise ${toolName}`).toBeDefined();
  return advertisedTool as Tool;
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  // The stub answers only the edge update, so any other call 404s loudly.
  remoteMcpDoorHarness.respondWith((request) => {
    if (request.method === 'PUT' && request.pathname === `/api/edges/${CORRECTED_EDGE_ID}`) {
      return { payload: { success: true, message: 'Edge updated successfully' } };
    }
    return undefined;
  });

  localDoorTools = await withLocalMcpDoorClient(async (client) => (await client.listTools()).tools);
  remoteDoorTools = await remoteMcpDoorHarness.withRemoteMcpClient(
    async (client) => (await client.listTools()).tools
  );
}, 60000);

afterAll(async () => {
  await remoteMcpDoorHarness.stop();
});

beforeEach(() => {
  remoteMcpDoorHarness.resetRecordedAppRequests();
});

describe('both MCP doors send the same support-only edge correction', () => {
  // The agreement that matters most: the body is where the destructive bug
  // would live. A door that still sent a context on a support-only correction
  // would wipe the stored explanation, and no schema comparison would see it.
  it('produces an identical PUT body for a support-only correction', async () => {
    const { localDoorBody, remoteDoorBody } = await updateEdgeBodyFromEachDoor(
      supportOnlyCorrectionToolArguments
    );

    expect(localDoorBody, 'the local door must have PUT to /api/edges/<id>').toBeTruthy();
    expect(remoteDoorBody, 'the remote door must have PUT to /api/edges/<id>').toBeTruthy();
    expect(remoteDoorBody).toEqual(localDoorBody);
  });

  // Equality alone would be satisfied by two doors that are wrong in the same
  // way, so the shared body is also pinned against the app's actual rules: no
  // context (it would overwrite the stored one), created_via present (without
  // it the route defaults to 'ui' and skips the confirmation gate) and the
  // corrected support carried top-level where the edges column reads it.
  it('agrees on a body with no context, an mcp created_via and the corrected support', async () => {
    const { localDoorBody, remoteDoorBody } = await updateEdgeBodyFromEachDoor(
      supportOnlyCorrectionToolArguments
    );

    for (const [doorName, updateEdgeBody] of [
      ['local', localDoorBody],
      ['remote', remoteDoorBody],
    ] as const) {
      const bodyKeys = Object.keys((updateEdgeBody ?? {}) as Record<string, unknown>);
      expect(bodyKeys, `the ${doorName} door must send no context on a support-only write`).not.toContain(
        'context'
      );
      expect(updateEdgeBody).toMatchObject({
        created_via: 'mcp',
        confirmed_by_user: true,
        belief_evidence_support: 0.4,
      });
    }
  });

  // Un-assessment is the other half of the change and travels the same path, so
  // it can drift on its own: a door that dropped the null key instead of
  // forwarding it would leave the edge graded and look successful doing it.
  it('produces an identical PUT body for an un-assessment, with support present and null', async () => {
    const { localDoorBody, remoteDoorBody } = await updateEdgeBodyFromEachDoor(
      unassessingCorrectionToolArguments
    );

    expect(remoteDoorBody).toEqual(localDoorBody);
    for (const [doorName, updateEdgeBody] of [
      ['local', localDoorBody],
      ['remote', remoteDoorBody],
    ] as const) {
      const unassessingBody = (updateEdgeBody ?? {}) as Record<string, unknown>;
      expect(
        Object.keys(unassessingBody),
        `the ${doorName} door must send the support key on an un-assessment`
      ).toContain('belief_evidence_support');
      expect(unassessingBody.belief_evidence_support).toBeNull();
    }
  });
});

describe('both MCP doors advertise the same optional explanation and nullable support', () => {
  // An agent reads what it may omit off the advertised schema. If one door
  // still requires the explanation, that door's clients will keep inventing
  // prose over recorded human reasoning even after the handler stops demanding
  // it.
  it('agrees that explanation is optional on rah_update_edge', () => {
    for (const [doorName, tools] of [
      ['local', localDoorTools],
      ['remote', remoteDoorTools],
    ] as const) {
      const updateEdgeTool = findAdvertisedTool(tools, 'rah_update_edge', doorName);
      const requiredInputProperties =
        (updateEdgeTool.inputSchema as { required?: string[] }).required ?? [];

      expect(
        requiredInputProperties,
        `the ${doorName} door must not require an explanation on rah_update_edge`
      ).not.toContain('explanation');
    }
  });

  // Both doors take this schema from the one shared contract in
  // src/services/belief/beliefMcpToolContract.js, so any difference means one
  // door has stopped using it — which is how the surface drifted the first time.
  it('advertises a byte-identical belief_evidence_support on rah_update_edge', () => {
    const localUpdateEdgeTool = findAdvertisedTool(localDoorTools, 'rah_update_edge', 'local');
    const remoteUpdateEdgeTool = findAdvertisedTool(remoteDoorTools, 'rah_update_edge', 'remote');

    const localSupportSchema = (
      localUpdateEdgeTool.inputSchema as { properties?: Record<string, unknown> }
    ).properties?.belief_evidence_support;
    const remoteSupportSchema = (
      remoteUpdateEdgeTool.inputSchema as { properties?: Record<string, unknown> }
    ).properties?.belief_evidence_support;

    expect(localSupportSchema).toBeDefined();
    expect(remoteSupportSchema).toBeDefined();
    expect(remoteSupportSchema).toEqual(localSupportSchema);
    // And both must admit null, or the un-assessment is undiscoverable however
    // permissive the handlers are.
    expect(JSON.stringify(localSupportSchema)).toContain('null');
  });

  // GUARD: the confirmation gate is untouched by this change. Making the
  // explanation optional must not make the write itself less guarded — a door
  // that quietly dropped the requirement would let an agent regrade the graph
  // without the user ever confirming it.
  it('GUARD: both doors still require confirmed_by_user on rah_update_edge', () => {
    for (const [doorName, tools] of [
      ['local', localDoorTools],
      ['remote', remoteDoorTools],
    ] as const) {
      const updateEdgeTool = findAdvertisedTool(tools, 'rah_update_edge', doorName);
      const requiredInputProperties =
        (updateEdgeTool.inputSchema as { required?: string[] }).required ?? [];

      expect(
        requiredInputProperties,
        `the ${doorName} door must still require confirmed_by_user`
      ).toContain('confirmed_by_user');
      expect(requiredInputProperties).toContain('id');
    }
  });
});
