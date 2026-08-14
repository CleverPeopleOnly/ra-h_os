/**
 * Filtered EDGE READS through the app-MCP proxy
 * (apps/mcp-server/stdio-server.js, tool rah_query_edges).
 *
 * This file pins the tool's filter contract:
 *
 *  - the tool sends nodeId, direction, limit and offset to GET /api/edges,
 *    with 'both' when the caller omits the direction,
 *  - a direction the read path does not implement, and a negative offset, are
 *    tool errors that reach the app as no request at all,
 *  - the advertised input schema names direction and offset.
 *
 * deleted in the evidence-leaves-the-edges-table slice: the
 * surfaces-support-and-contribution test, and the belief-column half of the
 * advertise test — the edge tools shed the evidence read fields, pinned in
 * stdio-server-edge-tools-shed-evidence.test.ts.
 *
 * Seam: the spawned proxy is pointed at a local in-process HTTP stub via
 * RAH_MCP_TARGET_URL, and the stub records every request — including its
 * query string — and answers GET /api/edges with three seeded plain edges.
 * No real app and no database is involved. The spawned proxy process is
 * always terminated in the finally block of withMcpClient, so no orphan
 * processes survive a failure.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// One recorded request the HTTP stub received from the proxy under test. The
// query parameters are recorded because they are the whole subject of the
// filter tests: today the proxy can only send two of them.
type RecordedApiRequest = {
  method: string;
  pathname: string;
  searchParams: Record<string, string>;
};

// One edge row as an edge read must carry it: the plain relationship
// columns — no edge carries belief evidence any more.
interface BeliefEdgeReadRow {
  id: number;
  from_node_id: number;
  to_node_id: number;
}

// The stub rows the app answers edge reads with: three plain relationship
// edges into node 1.
const stubEdgeReadRows: BeliefEdgeReadRow[] = [
  { id: 11, from_node_id: 2, to_node_id: 1 },
  { id: 12, from_node_id: 3, to_node_id: 1 },
  { id: 13, from_node_id: 4, to_node_id: 1 },
];

// The in-process HTTP stub standing in for the running RA-H app.
let apiStubServer: http.Server;
// Base URL the spawned proxy is pointed at via RAH_MCP_TARGET_URL.
let apiStubBaseUrl = '';
// Every request the stub received, in arrival order.
let recordedApiRequests: RecordedApiRequest[] = [];

// Route the stub's requests: record method, path and query string, then answer
// GET /api/edges with the three seeded plain edges so the tool call completes.
function handleApiStubRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', apiStubBaseUrl);
  const method = req.method || 'GET';

  recordedApiRequests.push({
    method,
    pathname: url.pathname,
    searchParams: Object.fromEntries(url.searchParams.entries()),
  });

  if (method === 'GET' && url.pathname === '/api/edges') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        data: stubEdgeReadRows,
        count: stubEdgeReadRows.length,
      })
    );
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

  const client = new Client({ name: 'ra-h-stdio-belief-edge-reads-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// Find the (single) GET /api/edges request the stub recorded, if any.
function findRecordedEdgeReadRequest(): RecordedApiRequest | undefined {
  return recordedApiRequests.find(
    (entry) => entry.method === 'GET' && entry.pathname === '/api/edges'
  );
}

// Extract a tool call's structured content with a caller-chosen shape.
function getStructured<T>(result: unknown): T {
  return (result as { structuredContent?: unknown }).structuredContent as T;
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

beforeEach(() => {
  recordedApiRequests = [];
});

describe('app-MCP proxy rah_query_edges filtered edge reads', () => {
  // The proxy has to be able to ASK for one side of a node and for one page:
  // all four filter parts must appear in the query string it sends the app.
  it('sends nodeId, direction, limit and offset to GET /api/edges', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_query_edges',
        arguments: { nodeId: 7, direction: 'into', limit: 5, offset: 10 },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const edgeReadRequest = findRecordedEdgeReadRequest();
      expect(edgeReadRequest, 'proxy should have read GET /api/edges').toBeDefined();
      expect(edgeReadRequest?.searchParams).toMatchObject({
        nodeId: '7',
        direction: 'into',
        limit: '5',
        offset: '10',
      });
    });
  });

  // The out_of side must be reachable too.
  it('sends a direction of out_of to GET /api/edges', async () => {
    await withMcpClient(async (client) => {
      await client.callTool({
        name: 'rah_query_edges',
        arguments: { nodeId: 7, direction: 'out_of' },
      });

      expect(findRecordedEdgeReadRequest()?.searchParams).toMatchObject({
        nodeId: '7',
        direction: 'out_of',
      });
    });
  });

  // Omitting the direction means either side of the node, so an existing
  // caller keeps the behaviour it has today without having to name it.
  it('sends a direction of both when the caller omits it', async () => {
    await withMcpClient(async (client) => {
      await client.callTool({
        name: 'rah_query_edges',
        arguments: { nodeId: 7 },
      });

      expect(findRecordedEdgeReadRequest()?.searchParams).toMatchObject({
        nodeId: '7',
        direction: 'both',
      });
    });
  });

  // A direction the read path does not implement must be a tool error, not a
  // silent fall back to both sides: an agent asking for one side of a node
  // and getting both would draw a conclusion from the wrong half of the
  // graph.
  it('rejects an unknown direction with a tool error and sends no request to /api/edges', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_query_edges',
        arguments: { nodeId: 7, direction: 'sideways' },
      });

      expect(
        (toolResult as { isError?: boolean }).isError,
        'a direction outside into / out_of / both must be rejected'
      ).toBe(true);
      expect(findRecordedEdgeReadRequest()).toBeUndefined();
    });
  });

  // There is no page before the first one, so a negative offset is an invalid
  // read rather than something to clamp silently.
  it('rejects a negative offset with a tool error and sends no request to /api/edges', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_query_edges',
        arguments: { nodeId: 7, offset: -1 },
      });

      expect((toolResult as { isError?: boolean }).isError, 'offset cannot be negative').toBe(true);
      expect(findRecordedEdgeReadRequest()).toBeUndefined();
    });
  });

  // Discoverability: an external agent learns what it can ask for from the
  // advertised schemas, so direction and offset must be on the input schema.
  it('advertises direction and offset on the input schema', async () => {
    await withMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const queryEdgesTool = listedTools.tools.find((tool) => tool.name === 'rah_query_edges');
      expect(queryEdgesTool).toBeDefined();

      const inputSchemaJson = JSON.stringify(queryEdgesTool?.inputSchema);
      expect(inputSchemaJson).toContain('nodeId');
      expect(inputSchemaJson).toContain('direction');
      expect(inputSchemaJson).toContain('limit');
      expect(inputSchemaJson).toContain('offset');
      // The three direction values, named exactly as the read path accepts.
      expect(inputSchemaJson).toContain('into');
      expect(inputSchemaJson).toContain('out_of');
      expect(inputSchemaJson).toContain('both');
    });
  });

  // GUARD: a read with no arguments at all is still a valid read, so adding
  // the filter must not make nodeId or a page position mandatory.
  it('GUARD: reads edges with no arguments at all', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_query_edges',
        arguments: {},
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const structured = getStructured<{ count: number; edges: BeliefEdgeReadRow[] }>(toolResult);
      expect(structured.count).toBe(3);
      expect(findRecordedEdgeReadRequest()).toBeDefined();
    });
  });
});
