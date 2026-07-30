/**
 * NODE metadata and creation-timestamp round-trip through the app-MCP proxy
 * (apps/mcp-server/stdio-server.js, tool rah_get_nodes).
 *
 * GET /api/nodes/[id] already answers with the complete node row, including
 * `metadata` (a parsed object, or null when the column is NULL) and
 * `created_at`. The shipped tool then reduces every node it loaded to
 * { id, title, source, description, link, updated_at }, so two things the app
 * already holds never reach the agent that asked for the node. This file pins
 * the contract instead:
 *
 *  - each entry of structuredContent.nodes carries `metadata` and `created_at`
 *    exactly as the app returned them,
 *  - a node whose stored metadata is NULL comes back as `metadata: null`, never
 *    as `{}`: an absent metadata bag and an empty one are different states, and
 *    an empty bag would read as "this node was written with no keys" rather
 *    than "nothing was ever recorded",
 *  - the advertised output schema names both fields, so an external agent can
 *    discover them. (The MCP SDK validates structuredContent against the
 *    advertised output schema, so the mapping and the schema are only usable
 *    once they are in step.)
 *
 * Seam (same as tests/unit/mcp/stdio-server-evidence.test.ts): the spawned
 * proxy is pointed at a local in-process HTTP stub via RAH_MCP_TARGET_URL, and
 * the stub answers GET /api/nodes/[id] from a fixture table keyed by node id.
 * No real app and no database is involved. The spawned proxy process is always
 * terminated in the finally block of withMcpClient, so no orphan processes
 * survive a failure.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// One node row as a node read must carry it: the fields the tool already
// reports, plus the metadata bag and the creation timestamp it drops today.
// metadata is nullable because NULL (nothing ever recorded) is a state of its
// own, distinct from an empty object.
interface NodeReadRow {
  id: number;
  title: string;
  source: string | null;
  description: string | null;
  link: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// The node whose metadata bag holds real canonical keys — the case that proves
// the whole object survives the proxy's mapping step unflattened.
const nodeWithStoredMetadata: NodeReadRow = {
  id: 501,
  title: 'Node carrying a stored metadata bag',
  source: 'Fixture source text for the node with metadata.',
  description: 'A node the app returns with canonical metadata keys set.',
  link: null,
  metadata: { type: 'article', state: 'active', captured_method: 'url_extract' },
  created_at: '2026-07-01T09:15:00.000Z',
  updated_at: '2026-07-20T11:00:00.000Z',
};

// The node whose metadata column is NULL: nothing was ever recorded about it.
// It must come back as null, not as an empty bag.
const nodeWithoutStoredMetadata: NodeReadRow = {
  id: 502,
  title: 'Node with no metadata recorded',
  source: null,
  description: null,
  link: null,
  metadata: null,
  created_at: '2026-07-02T14:30:00.000Z',
  updated_at: '2026-07-21T08:45:00.000Z',
};

// Every node the stub can serve, keyed by the id the proxy asks for.
const nodeReadRowsById = new Map<number, NodeReadRow>([
  [nodeWithStoredMetadata.id, nodeWithStoredMetadata],
  [nodeWithoutStoredMetadata.id, nodeWithoutStoredMetadata],
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
    const requestedNode = nodeReadRowsById.get(Number(singleNodePathMatch[1]));
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

  const client = new Client({ name: 'ra-h-stdio-node-metadata-reads-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// Extract a tool call's structured content with a caller-chosen shape.
function getStructured<T>(toolResult: unknown): T {
  return (toolResult as { structuredContent?: unknown }).structuredContent as T;
}

// Call rah_get_nodes for the given ids and return the structured node read.
async function callGetNodesTool(
  client: Client,
  nodeIds: number[]
): Promise<{ count: number; nodes: NodeReadRow[] }> {
  const nodeReadToolResult = await client.callTool({
    name: 'rah_get_nodes',
    arguments: { nodeIds },
  });
  expect((nodeReadToolResult as { isError?: boolean }).isError ?? false).toBe(false);
  return getStructured<{ count: number; nodes: NodeReadRow[] }>(nodeReadToolResult);
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

describe('app-MCP proxy rah_get_nodes metadata and creation-timestamp reads', () => {
  // The pass-through the defect breaks: the whole stored metadata bag and the
  // creation timestamp must survive the proxy's own mapping step.
  it('surfaces the stored metadata bag and created_at of a node the app returned', async () => {
    await withMcpClient(async (client) => {
      const structuredNodeRead = await callGetNodesTool(client, [nodeWithStoredMetadata.id]);

      expect(structuredNodeRead.count).toBe(1);
      const loadedNode = structuredNodeRead.nodes[0];
      // The bag arrives whole, key for key, not flattened or partially copied.
      expect(loadedNode.metadata).toEqual({
        type: 'article',
        state: 'active',
        captured_method: 'url_extract',
      });
      expect(loadedNode.created_at).toBe('2026-07-01T09:15:00.000Z');
    });
  });

  // NULL metadata must stay null. An empty object would claim the node was
  // written with an (empty) metadata bag, when in fact nothing was ever
  // recorded — and the key must be PRESENT, so a caller can tell "nothing
  // recorded" from "the tool forgot to report it".
  it('reports metadata as null rather than an empty object for a node with none stored', async () => {
    await withMcpClient(async (client) => {
      const structuredNodeRead = await callGetNodesTool(client, [nodeWithoutStoredMetadata.id]);

      const loadedNode = structuredNodeRead.nodes[0];
      expect(Object.keys(loadedNode)).toContain('metadata');
      expect(loadedNode.metadata).toBeNull();
      expect(loadedNode.metadata).not.toEqual({});
      expect(loadedNode.created_at).toBe('2026-07-02T14:30:00.000Z');
    });
  });

  // Both states in one call: a multi-id read must not let the node that has
  // metadata lend its bag to the node that has none, or vice versa.
  it('keeps metadata per node when one call loads a node with metadata and a node without', async () => {
    await withMcpClient(async (client) => {
      const structuredNodeRead = await callGetNodesTool(client, [
        nodeWithStoredMetadata.id,
        nodeWithoutStoredMetadata.id,
      ]);

      expect(structuredNodeRead.count).toBe(2);
      const nodeThatHasMetadata = structuredNodeRead.nodes.find(
        (node) => node.id === nodeWithStoredMetadata.id
      );
      const nodeThatHasNoMetadata = structuredNodeRead.nodes.find(
        (node) => node.id === nodeWithoutStoredMetadata.id
      );
      expect(nodeThatHasMetadata?.metadata).toEqual({
        type: 'article',
        state: 'active',
        captured_method: 'url_extract',
      });
      expect(nodeThatHasNoMetadata?.metadata).toBeNull();
      expect(nodeThatHasMetadata?.created_at).toBe('2026-07-01T09:15:00.000Z');
      expect(nodeThatHasNoMetadata?.created_at).toBe('2026-07-02T14:30:00.000Z');
    });
  });

  // Discoverability: an external agent learns what a node read returns from the
  // advertised output schema. The SDK also validates structuredContent against
  // that schema, so the mapping above is only usable once the schema names both
  // fields too.
  it('advertises metadata and created_at on the rah_get_nodes output schema', async () => {
    await withMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const getNodesTool = listedTools.tools.find((tool) => tool.name === 'rah_get_nodes');
      expect(getNodesTool).toBeDefined();

      const outputSchemaJson = JSON.stringify(getNodesTool?.outputSchema);
      expect(outputSchemaJson).toContain('metadata');
      expect(outputSchemaJson).toContain('created_at');
    });
  });

  // GUARD: the fields the tool already reports must keep arriving unchanged —
  // adding metadata and created_at must not disturb the existing node read.
  it('GUARD: still reports id, title, source, description, link and updated_at', async () => {
    await withMcpClient(async (client) => {
      const structuredNodeRead = await callGetNodesTool(client, [nodeWithStoredMetadata.id]);

      expect(structuredNodeRead.nodes[0]).toMatchObject({
        id: nodeWithStoredMetadata.id,
        title: 'Node carrying a stored metadata bag',
        source: 'Fixture source text for the node with metadata.',
        description: 'A node the app returns with canonical metadata keys set.',
        link: null,
        updated_at: '2026-07-20T11:00:00.000Z',
      });
    });
  });
});
