/**
 * UNSIGNED support range on the app-MCP proxy write door
 * (apps/mcp-server/stdio-server.js, tool rah_create_edge).
 *
 * belief_evidence_support is UNSIGNED, 0..1: it says how strongly the source
 * node talks about the target node, and the sign of a contribution comes only
 * from the source NODE's credence. This file pins the ACCEPTANCE half of the
 * unsigned range on this door: 1 (full strength) and values between 0 and 1
 * are forwarded verbatim to POST /api/edges.
 * (The rest of the door's range rules live in
 * tests/unit/mcp/stdio-server-evidence.test.ts: accepting exactly 0,
 * rejecting every negative value, and rejecting values above 1 — kept in one
 * place rather than asserted twice.)
 *
 * Seam (same as tests/unit/mcp/stdio-server-evidence.test.ts): the spawned
 * proxy is pointed at a local in-process HTTP stub via RAH_MCP_TARGET_URL and
 * the stub records every request body. No real app and no database is
 * involved. The spawned proxy process is always terminated in the finally
 * block of withMcpClient, so no orphan processes survive a failure.
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
// a successful create so an accepted tool call completes.
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

  const client = new Client({ name: 'ra-h-stdio-support-range-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// Find the (single) POST /api/edges request the stub recorded, if any.
function findRecordedCreateEdgeRequest(): RecordedApiRequest | undefined {
  return recordedApiRequests.find(
    (entry) => entry.method === 'POST' && entry.pathname === '/api/edges'
  );
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

describe('app-MCP proxy rah_create_edge unsigned support range', () => {
  // The unsigned upper boundary is IN range: full-strength evidence (support
  // exactly 1) must be accepted and forwarded verbatim to the app.
  it('accepts a belief_evidence_support of exactly 1 and forwards it in the POST body', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result bearing on the claim node at full strength.',
          confirmed_by_user: true,
          belief_evidence_support: 1,
        },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const createEdgeRequest = findRecordedCreateEdgeRequest();
      expect(createEdgeRequest, 'proxy should have POSTed to /api/edges').toBeDefined();
      expect(createEdgeRequest?.body?.belief_evidence_support).toBe(1);
    });
  });

  // An ordinary in-between value must pass through unchanged — the range
  // check must not clamp, round or otherwise touch a valid support.
  it('accepts a belief_evidence_support between 0 and 1 and forwards it verbatim', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result partially bearing on the claim node.',
          confirmed_by_user: true,
          belief_evidence_support: 0.55,
        },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const createEdgeRequest = findRecordedCreateEdgeRequest();
      expect(createEdgeRequest, 'proxy should have POSTed to /api/edges').toBeDefined();
      expect(createEdgeRequest?.body?.belief_evidence_support).toBe(0.55);
    });
  });
});
