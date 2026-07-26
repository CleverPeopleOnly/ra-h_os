/**
 * MR-B test for the app-MCP proxy (apps/mcp-server/stdio-server.js): the
 * rah_create_edge tool must accept the three writable evidence fields and
 * include them in the POST body it sends to /api/edges — today its zod
 * input schema silently strips them before the payload is built.
 *
 * Seam (same as tests/unit/mcp/stdio-server.test.ts): the spawned proxy is
 * pointed at a local in-process HTTP stub via RAH_MCP_TARGET_URL, and the
 * stub records every request body. No real app and no database is involved.
 * The spawned proxy process is always terminated in the finally block of
 * withMcpClient, so no orphan processes survive a failure.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// One recorded request the HTTP stub received from the proxy under test.
type RecordedApiRequest = {
  method: string;
  pathname: string;
  body: Record<string, unknown> | null;
};

// The in-process HTTP stub standing in for the running RA-H app.
let apiStubServer: http.Server;
// Base URL the spawned proxy is pointed at via RAH_MCP_TARGET_URL.
let apiStubBaseUrl = '';
// Every request the stub received, in arrival order.
let recordedApiRequests: RecordedApiRequest[] = [];

// Collect and parse a JSON request body from an incoming stub request.
async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

// Route the stub's requests: record everything, answer POST /api/edges with
// a successful create so the tool call completes.
async function handleApiStubRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', apiStubBaseUrl);
  const method = req.method || 'GET';
  const body = method === 'POST' || method === 'PUT' ? await readJsonBody(req) : null;

  recordedApiRequests.push({ method, pathname: url.pathname, body });

  if (method === 'POST' && url.pathname === '/api/edges') {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        data: { id: 42, from_node_id: body?.from_node_id, to_node_id: body?.to_node_id },
        message: 'Edge created successfully',
      })
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: `Unhandled stub route: ${method} ${url.pathname}` }));
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

  const client = new Client({ name: 'ra-h-stdio-evidence-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  apiStubServer = http.createServer((req, res) => {
    void handleApiStubRequest(req, res);
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

describe('app-MCP proxy rah_create_edge evidence forwarding (MR-B)', () => {
  // The pinned behavior: evidence arguments given to the tool must appear in
  // the POST body the proxy sends to /api/edges (today the zod schema strips
  // them, so the app never sees the evidence).
  it('includes belief_evidence_direction, belief_evidence_strength, and belief_evidence_origin_key in the POST body to /api/edges', async () => {
    await withMcpClient(async (client) => {
      await client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result that supports the claim node.',
          confirmed_by_user: true,
          belief_evidence_direction: 'for',
          belief_evidence_strength: 0.9,
          belief_evidence_origin_key: 'origin:stdio-evidence-test',
        },
      });

      const createEdgeRequest = recordedApiRequests.find(
        (entry) => entry.method === 'POST' && entry.pathname === '/api/edges'
      );
      expect(createEdgeRequest, 'proxy should have POSTed to /api/edges').toBeDefined();

      // Existing payload contract still holds.
      expect(createEdgeRequest?.body).toMatchObject({
        from_node_id: 2,
        to_node_id: 1,
        explanation: 'Reports a measured result that supports the claim node.',
        created_via: 'mcp',
        confirmed_by_user: true,
      });
      // The evidence fields must survive the tool schema and reach the app.
      expect(createEdgeRequest?.body).toMatchObject({
        belief_evidence_direction: 'for',
        belief_evidence_strength: 0.9,
        belief_evidence_origin_key: 'origin:stdio-evidence-test',
      });
    });
  });

  // Discoverability: the tool's advertised input schema must name the
  // evidence fields, otherwise no external agent can know they exist.
  it('advertises the evidence fields in the rah_create_edge input schema', async () => {
    await withMcpClient(async (client) => {
      const result = await client.listTools();
      const createEdgeTool = result.tools.find((tool) => tool.name === 'rah_create_edge');
      expect(createEdgeTool).toBeDefined();

      const inputSchemaJson = JSON.stringify(createEdgeTool?.inputSchema);
      expect(inputSchemaJson).toContain('belief_evidence_direction');
      expect(inputSchemaJson).toContain('belief_evidence_strength');
      expect(inputSchemaJson).toContain('belief_evidence_origin_key');
    });
  });
});
