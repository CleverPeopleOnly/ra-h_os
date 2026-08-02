/**
 * Tests for the LOCAL MCP door's node-read BELIEF surface
 * (apps/mcp-server/stdio-server.js): rah_get_nodes must report each node's
 * three belief columns — belief_credence, belief_computed_at,
 * belief_credence_is_fixed — exactly as the app returned them.
 *
 * This is the local-door twin of
 * tests/unit/mcp/remote-mcp-route-belief-node-reads.test.ts, with the same
 * fixtures and the same three states the vocabulary keeps apart: a graded
 * node (a number, sign intact), an ungraded node (null — NEVER 0), and a
 * fixed-credence node (belief_credence_is_fixed 1). Both doors take the node
 * belief fields from the shared contract
 * (src/services/belief/beliefMcpToolContract.js), so this file and the remote
 * one should stay line-for-line comparable; the structural agreement itself
 * is pinned in tests/unit/mcp/mcp-doors-agree-on-belief-tool-surface.test.ts.
 *
 * Seam (same as tests/unit/mcp/stdio-server-node-metadata-reads.test.ts): the
 * spawned proxy is pointed at a local in-process HTTP stub via
 * RAH_MCP_TARGET_URL, and the stub answers GET /api/nodes/[id] from a fixture
 * table. No real app and no database is involved. The spawned proxy process
 * is always terminated in the finally block of withMcpClient, so no orphan
 * survives a failure.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// One node row as the app returns it, belief columns included. Credence and
// its stamp are nullable because NULL (ungraded) is a state of its own; the
// fixed flag is not — the column is NOT NULL DEFAULT 0.
interface BeliefNodeReadRow {
  id: number;
  title: string;
  source: string | null;
  description: string | null;
  link: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
}

// A node the engine has graded: a positive credence with its stamp, derived
// (not fixed) — the ordinary graded state.
const gradedBeliefNodeRecord: BeliefNodeReadRow = {
  id: 21,
  title: 'Node the belief engine has graded',
  source: 'Fixture source text.',
  description: 'A node carrying an engine-derived credence.',
  link: null,
  metadata: null,
  created_at: '2026-07-01T08:00:00.000Z',
  updated_at: '2026-07-30T08:00:00.000Z',
  belief_credence: 0.62,
  belief_computed_at: '2026-07-28T09:00:00.000Z',
  belief_credence_is_fixed: 0,
};

// A node whose credence a human asserted by hand — negative, because
// credence is the only signed quantity in the system and the sign must
// survive the door.
const fixedBeliefNodeRecord: BeliefNodeReadRow = {
  id: 22,
  title: 'Node whose credence a human asserted',
  source: null,
  description: null,
  link: null,
  metadata: null,
  created_at: '2026-07-02T08:00:00.000Z',
  updated_at: '2026-07-02T08:00:00.000Z',
  belief_credence: -0.4,
  belief_computed_at: '2026-07-29T09:00:00.000Z',
  belief_credence_is_fixed: 1,
};

// A node nobody has grounded: credence NULL, no stamp, ordinary flag.
const ungradedBeliefNodeRecord: BeliefNodeReadRow = {
  id: 23,
  title: 'Node nobody has grounded',
  source: null,
  description: null,
  link: null,
  metadata: null,
  created_at: '2026-07-03T08:00:00.000Z',
  updated_at: '2026-07-03T08:00:00.000Z',
  belief_credence: null,
  belief_computed_at: null,
  belief_credence_is_fixed: 0,
};

// Every node the stub can serve, keyed by the id the proxy asks for.
const beliefNodeReadRowsById = new Map<number, BeliefNodeReadRow>([
  [gradedBeliefNodeRecord.id, gradedBeliefNodeRecord],
  [fixedBeliefNodeRecord.id, fixedBeliefNodeRecord],
  [ungradedBeliefNodeRecord.id, ungradedBeliefNodeRecord],
]);

// The in-process HTTP stub standing in for the running RA-H app.
let apiStubServer: http.Server;
// Base URL the spawned proxy is pointed at via RAH_MCP_TARGET_URL.
let apiStubBaseUrl = '';

// Route the stub's requests: answer GET /api/nodes/<id> with the fixture node
// in the app's own envelope ({ success, node }) so the tool call completes.
function handleApiStubRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', apiStubBaseUrl);
  const method = req.method || 'GET';
  const singleNodePathMatch = /^\/api\/nodes\/(\d+)$/.exec(url.pathname);

  if (method === 'GET' && singleNodePathMatch) {
    const requestedNode = beliefNodeReadRowsById.get(Number(singleNodePathMatch[1]));
    if (requestedNode) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, node: requestedNode }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Node not found' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({ success: false, error: `Unhandled stub route: ${method} ${url.pathname}` })
  );
}

// Spawn the proxy against the stub, run the callback with a connected MCP
// client, then ALWAYS close the transport (terminating the proxy process).
async function withMcpClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), 'apps', 'mcp-server', 'stdio-server.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAH_MCP_TARGET_URL: apiStubBaseUrl,
    } as Record<string, string>,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'ra-h-stdio-belief-node-reads-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// Call rah_get_nodes for the given ids and return the structured node read.
// The reported rows are typed as the belief-carrying shape this file drives.
async function callGetNodesTool(
  client: Client,
  nodeIds: number[]
): Promise<{ count: number; nodes: Array<Record<string, unknown>> }> {
  const nodeReadToolResult = await client.callTool({
    name: 'rah_get_nodes',
    arguments: { nodeIds },
  });
  expect((nodeReadToolResult as { isError?: boolean }).isError ?? false).toBe(false);
  return (nodeReadToolResult as { structuredContent?: unknown }).structuredContent as {
    count: number;
    nodes: Array<Record<string, unknown>>;
  };
}

beforeAll(async () => {
  apiStubServer = http.createServer((req, res) => {
    handleApiStubRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    apiStubServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = apiStubServer.address() as AddressInfo;
  apiStubBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    apiStubServer.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('app-MCP proxy rah_get_nodes belief columns', () => {
  // The core gap: a graded node's belief must survive the proxy's mapping.
  it('reports the three belief columns of a graded node verbatim', async () => {
    await withMcpClient(async (client) => {
      const structuredNodeRead = await callGetNodesTool(client, [gradedBeliefNodeRecord.id]);

      const reportedNode = structuredNodeRead.nodes[0];
      expect(reportedNode.belief_credence).toBe(0.62);
      expect(reportedNode.belief_computed_at).toBe('2026-07-28T09:00:00.000Z');
      expect(reportedNode.belief_credence_is_fixed).toBe(0);
    });
  });

  // A human-asserted credence arrives flagged, sign intact.
  it('reports a fixed-credence node with the flag 1 and its negative credence intact', async () => {
    await withMcpClient(async (client) => {
      const structuredNodeRead = await callGetNodesTool(client, [fixedBeliefNodeRecord.id]);

      const reportedNode = structuredNodeRead.nodes[0];
      expect(reportedNode.belief_credence_is_fixed).toBe(1);
      expect(reportedNode.belief_credence).toBe(-0.4);
    });
  });

  // NULL credence means nobody has grounded the node — an explicit null,
  // never 0 and never a dropped key.
  it('reports an ungraded node with belief_credence null, present and never 0', async () => {
    await withMcpClient(async (client) => {
      const structuredNodeRead = await callGetNodesTool(client, [ungradedBeliefNodeRecord.id]);

      const reportedNode = structuredNodeRead.nodes[0];
      expect(Object.keys(reportedNode)).toContain('belief_credence');
      expect(reportedNode.belief_credence).toBeNull();
      expect(reportedNode.belief_credence).not.toBe(0);
      expect(reportedNode.belief_computed_at).toBeNull();
    });
  });

  // One call must not smear one node's belief over another's absence.
  it('keeps belief per node when one call loads a graded and an ungraded node', async () => {
    await withMcpClient(async (client) => {
      const structuredNodeRead = await callGetNodesTool(client, [
        gradedBeliefNodeRecord.id,
        ungradedBeliefNodeRecord.id,
      ]);

      const reportedGradedNode = structuredNodeRead.nodes.find(
        (node) => node.id === gradedBeliefNodeRecord.id
      );
      const reportedUngradedNode = structuredNodeRead.nodes.find(
        (node) => node.id === ungradedBeliefNodeRecord.id
      );
      expect(reportedGradedNode?.belief_credence).toBe(0.62);
      expect(reportedUngradedNode?.belief_credence).toBeNull();
    });
  });

  // Discoverability, and the SDK's own validation: structuredContent is
  // checked against the advertised output schema, so the mapping above is
  // only usable once the schema declares all three columns too.
  it('advertises the three belief columns on the rah_get_nodes output schema', async () => {
    await withMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const getNodesTool = listedTools.tools.find((tool) => tool.name === 'rah_get_nodes');
      expect(getNodesTool).toBeDefined();

      const outputSchemaJson = JSON.stringify(getNodesTool?.outputSchema);
      expect(outputSchemaJson).toContain('belief_credence');
      expect(outputSchemaJson).toContain('belief_computed_at');
      expect(outputSchemaJson).toContain('belief_credence_is_fixed');
    });
  });

  // GUARD: the fields the tool already reports must keep arriving unchanged.
  it('GUARD: still reports id, title, source, description, link and the timestamps', async () => {
    await withMcpClient(async (client) => {
      const structuredNodeRead = await callGetNodesTool(client, [gradedBeliefNodeRecord.id]);

      expect(structuredNodeRead.nodes[0]).toMatchObject({
        id: gradedBeliefNodeRecord.id,
        title: gradedBeliefNodeRecord.title,
        source: gradedBeliefNodeRecord.source,
        description: gradedBeliefNodeRecord.description,
        link: null,
        created_at: gradedBeliefNodeRecord.created_at,
        updated_at: gradedBeliefNodeRecord.updated_at,
      });
    });
  });
});
