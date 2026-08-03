/**
 * BOTH APP-BACKED MCP DOORS REPORT belief_uncertainty ON NODE READS
 * (docs/belief-model-subjective-logic.md §2 and §6): rah_get_nodes returns
 * belief_uncertainty ALONGSIDE belief_credence — derived on read from the
 * node's evidence masses (uncertainty = 2/(r + s + 2)), never stored, and
 * NULL when the node was never assessed.
 *
 * Two layers pinned in one file:
 *  1. ADVERTISED: both doors declare belief_uncertainty on the rah_get_nodes
 *     output schema, identically — same drift-proofing thesis as
 *     mcp-doors-agree-on-belief-tool-surface.test.ts, because both doors must
 *     take the fragment from the shared contract module
 *     (src/services/belief/beliefMcpToolContract.js, whose own derivation
 *     behaviour is pinned in
 *     tests/unit/belief/beliefMcpToolContractUncertaintyNodeReadFields.test.ts).
 *  2. DELIVERED: driving the remote door with node rows that carry evidence
 *     masses, the reply's belief_uncertainty is the derived value — and null
 *     for a never-assessed node, never 0 and never a dropped key.
 *
 * Seam: the remote door through remoteMcpDoorHarness (real MCP client into
 * the exported POST handler, in-process app stub behind), the local door
 * spawned as a real child process for the schema comparison only. The stub's
 * node rows carry the masses because the app's node read serves the columns
 * it stores; the DERIVATION lives in the shared mapper the doors spread in.
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
// Every tool the local door advertises, read once for the schema comparison.
let localDoorTools: Tool[] = [];
// Every tool the remote door advertises, read once for the schema comparison.
let remoteDoorTools: Tool[] = [];

// One node as the tool reports it back to the client.
type ReportedNode = Record<string, unknown>;

// A node graded under v2: §3 row 1's masses (0.45, 0) with their cached
// projection, so the derived uncertainty must be 2/2.45.
const massGradedNodeRecord = {
  id: 31,
  title: 'Node graded from evidence masses',
  source: 'Fixture source text.',
  description: 'A node carrying v2 evidence masses.',
  link: null,
  metadata: null,
  created_at: '2026-08-01T08:00:00.000Z',
  updated_at: '2026-08-02T08:00:00.000Z',
  belief_credence: 0.45 / 2.45,
  belief_computed_at: '2026-08-02T09:00:00.000Z',
  belief_credence_is_fixed: 0,
  belief_evidence_for_mass: 0.45,
  belief_evidence_against_mass: 0,
};

// A node nobody has assessed: masses NULL, credence NULL — its uncertainty
// must arrive as an explicit null.
const neverAssessedNodeRecord = {
  id: 32,
  title: 'Node nobody has assessed',
  source: null,
  description: null,
  link: null,
  metadata: null,
  created_at: '2026-08-01T08:00:00.000Z',
  updated_at: '2026-08-01T08:00:00.000Z',
  belief_credence: null,
  belief_computed_at: null,
  belief_credence_is_fixed: 0,
  belief_evidence_for_mass: null,
  belief_evidence_against_mass: null,
};

// Every node the stubbed app serves, keyed by the id in the URL.
const beliefNodeRecordsTheAppServes: Record<string, Record<string, unknown>> = {
  '31': massGradedNodeRecord,
  '32': neverAssessedNodeRecord,
};

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
  const client = new Client({ name: 'ra-h-belief-uncertainty-read-test', version: '1.0.0' });
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

// Drive rah_get_nodes on the remote door and hand back the reported nodes.
async function callGetNodesTool(client: Client, nodeIds: number[]): Promise<ReportedNode[]> {
  const toolResult = await client.callTool({ name: 'rah_get_nodes', arguments: { nodeIds } });
  expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
  const structuredContent = toolResult.structuredContent as { nodes?: ReportedNode[] } | undefined;
  return structuredContent?.nodes ?? [];
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  remoteMcpDoorHarness.respondWith((request) => {
    const nodeIdMatch = /^\/api\/nodes\/(\d+)$/.exec(request.pathname);
    if (request.method === 'GET' && nodeIdMatch) {
      const nodeRecord = beliefNodeRecordsTheAppServes[nodeIdMatch[1]];
      if (!nodeRecord) {
        return undefined;
      }
      return { payload: { success: true, node: nodeRecord } };
    }
    return undefined;
  });

  localDoorTools = await readLocalDoorTools(remoteMcpDoorHarness.raHAppStubBaseUrl);
  remoteDoorTools = await remoteMcpDoorHarness.withRemoteMcpClient(
    async (client) => (await client.listTools()).tools
  );
}, 60000);

afterAll(async () => {
  await remoteMcpDoorHarness.stop();
});

describe('both MCP doors advertise belief_uncertainty on rah_get_nodes', () => {
  // Discoverability first: an agent learns the field exists from the schema.
  it('declares belief_uncertainty on both doors, identically', () => {
    const localGetNodesTool = findAdvertisedTool(localDoorTools, 'rah_get_nodes', 'local');
    const remoteGetNodesTool = findAdvertisedTool(remoteDoorTools, 'rah_get_nodes', 'remote');

    const localUncertaintySchema = nodeReadOutputPropertySchema(
      localGetNodesTool,
      'belief_uncertainty'
    );
    const remoteUncertaintySchema = nodeReadOutputPropertySchema(
      remoteGetNodesTool,
      'belief_uncertainty'
    );

    expect(
      localUncertaintySchema,
      'the local door must advertise belief_uncertainty on the rah_get_nodes output schema'
    ).toBeDefined();
    expect(
      remoteUncertaintySchema,
      'the remote door must advertise belief_uncertainty on the rah_get_nodes output schema'
    ).toBeDefined();
    // Deep equality, because both doors must take the fragment from the
    // shared contract's node-read fields.
    expect(remoteUncertaintySchema).toEqual(localUncertaintySchema);
  });
});

describe('the remote MCP door delivers belief_uncertainty on node reads', () => {
  // The derivation reaches the wire: masses (0.45, 0) → uncertainty 2/2.45,
  // reported beside the cached credence.
  it('reports the derived uncertainty of a mass-graded node beside its credence', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedNode] = await callGetNodesTool(client, [massGradedNodeRecord.id]);

      expect(Number(reportedNode.belief_credence)).toBeCloseTo(0.45 / 2.45, 10);
      expect(Number(reportedNode.belief_uncertainty)).toBeCloseTo(2 / 2.45, 10);
    });
  });

  // Never assessed arrives as an explicit null — a real state distinct from
  // any number, and distinct from the key being missing.
  it('reports belief_uncertainty null, present and never 0, for a never-assessed node', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedNode] = await callGetNodesTool(client, [neverAssessedNodeRecord.id]);

      expect(Object.keys(reportedNode)).toContain('belief_uncertainty');
      expect(reportedNode.belief_uncertainty).toBeNull();
      expect(reportedNode.belief_uncertainty).not.toBe(0);
      expect(reportedNode.belief_credence).toBeNull();
    });
  });

  // GUARD: the columns the node read already reports keep arriving — adding
  // uncertainty must not disturb the rest of the record.
  it('GUARD: still reports the three v1 belief columns beside the uncertainty', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const [reportedNode] = await callGetNodesTool(client, [massGradedNodeRecord.id]);

      expect(reportedNode.belief_computed_at).toBe(massGradedNodeRecord.belief_computed_at);
      expect(reportedNode.belief_credence_is_fixed).toBe(0);
      expect(reportedNode.id).toBe(massGradedNodeRecord.id);
      expect(reportedNode.title).toBe(massGradedNodeRecord.title);
    });
  });
});
