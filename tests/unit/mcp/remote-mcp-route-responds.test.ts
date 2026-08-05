/**
 * Tests for the remote MCP door (app/api/mcp/route.ts): it must actually
 * ANSWER a client. That is the whole concern of this file — not what any tool
 * says, only that the door speaks at all.
 *
 * The defect being pinned: the POST handler builds a
 * WebStandardStreamableHTTPServerTransport in its default SSE streaming mode,
 * so `transport.handleRequest(request)` returns a Response wrapping a
 * ReadableStream that is filled ASYNCHRONOUSLY, after the handler has already
 * returned. The handler then immediately runs `await transport.close()`, and
 * close() calls every stream's cleanup, which closes the stream controller.
 * The controller is therefore closed before a single JSON-RPC message is ever
 * enqueued, so every request — including the opening `initialize` — comes back
 * as HTTP 200 with a completely empty body. A real MCP client never sees a
 * reply and times out with McpError -32001. In short: nothing has ever
 * successfully talked to this door.
 *
 * Seam (deliberately the same shape as the local door's tests in
 * tests/unit/mcp/stdio-server-evidence.test.ts, so the two doors stay
 * comparable): a real MCP Client is driven over a real
 * StreamableHTTPClientTransport whose `fetch` option is pointed straight at
 * this route's exported POST handler, in process — no socket, no `next dev`.
 * Behind the route, an in-process http server stands in for the running RA-H
 * app and records every request it receives; the route is pointed at it with
 * RAH_MCP_TARGET_URL. No real app and no database is involved.
 */

import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { NextRequest } from 'next/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { GET, POST } from '../../../app/api/mcp/route';

// One request the RA-H app stub received from the route under test.
type RecordedAppRequest = {
  method: string;
  pathname: string;
  body: Record<string, unknown> | null;
};

// How long the MCP client waits for a reply before declaring the door mute.
// Kept well under the vitest per-test budget below so a mute door fails as a
// readable MCP timeout rather than as an opaque "test timed out".
const REMOTE_MCP_REPLY_TIMEOUT_MS = 4000;

// Per-test budget for the client-driven tests: long enough to let the MCP
// timeout above fire and be reported, short enough to keep the suite quick.
const CLIENT_DRIVEN_TEST_TIMEOUT_MS = 15000;

// The tool names the route's GET metadata handler advertises to the outside
// world. Both the MCP handshake (listTools) and the GET handler must report
// them, which is what proves the handshake carried a real payload rather than
// merely failing to error.
const toolNamesTheRemoteMcpDoorAdvertises = [
  'rah_add_node',
  'rah_search_nodes',
  'rah_retrieve_query_context',
  'rah_update_node',
  'rah_get_nodes',
  'rah_create_edge',
  'rah_query_edges',
  'rah_update_edge',
  'rah_search_embeddings',
  'rah_extract_url',
  'rah_extract_youtube',
  'rah_extract_pdf',
  'rah_get_context',
  'rah_set_belief_fixed_credence',
  'rah_get_belief_movements',
  'rah_recompute_node_belief',
];

// The bearer token this suite installs as RAH_MCP_DOOR_TOKEN: the door fails
// closed with no token configured, so every request this file sends carries
// this credential. An arbitrary value; only equality matters.
const doorTokenForThisSuite = 'test-only-door-token-responds-8b4c';

// The node record the app stub returns from the search endpoint, so the
// round-trip test can assert the tool's reply carried this exact payload back
// out through the client.
const stubbedSearchResultNode = {
  id: 7,
  title: 'A node the stubbed app returns for the search query',
  source: 'Stub source text.',
  description: 'Stub description.',
  link: null,
  updated_at: '2026-07-30T00:00:00.000Z',
};

// The in-process http server standing in for the running RA-H app.
let raHAppStubServer: http.Server;
// Base URL the route is pointed at via RAH_MCP_TARGET_URL.
let raHAppStubBaseUrl = '';
// Every request the stub received, in arrival order.
let recordedAppRequests: RecordedAppRequest[] = [];
// The RAH_MCP_TARGET_URL value present before this file ran, restored after.
let targetUrlBeforeThisSuite: string | undefined;
// The RAH_MCP_DOOR_TOKEN value present before this file ran, restored after —
// absent stays absent.
let doorTokenBeforeThisSuite: string | undefined;

// Collect and parse a JSON request body from an incoming stub request.
async function readJsonRequestBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

// Route the stub's requests: record everything, and answer the one endpoint
// the round-trip test drives (rah_search_nodes -> /api/nodes/direct-search)
// with a successful search payload in the shape the route expects.
async function handleAppStubRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', raHAppStubBaseUrl);
  const method = req.method || 'GET';
  const body = method === 'POST' || method === 'PUT' ? await readJsonRequestBody(req) : null;

  recordedAppRequests.push({ method, pathname: url.pathname, body });

  if (method === 'POST' && url.pathname === '/api/nodes/direct-search') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { nodes: [stubbedSearchResultNode] } }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: `Unhandled stub route: ${method} ${url.pathname}` }));
}

// The client transport's network layer, replaced so requests reach the route's
// exported POST handler in process. Any other verb answers 405, which the
// client treats as "this server offers no standalone SSE stream" and ignores —
// the route only serves MCP over POST.
async function fetchIntoRemoteMcpRoutePostHandler(
  url: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  if (method !== 'POST') {
    return new Response(null, { status: 405 });
  }
  // The suite's bearer credential rides every forwarded POST, so the locked
  // door lets the test client through.
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${doorTokenForThisSuite}`);
  const routeRequest = new Request(String(url), { ...init, headers }) as unknown as NextRequest;
  return POST(routeRequest);
}

// Build a raw JSON-RPC `initialize` request aimed at the route, used by the
// direct-POST regression pin that needs the untouched response body.
function buildRawInitializeRequest(requestId: number): NextRequest {
  return new Request('http://127.0.0.1/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${doorTokenForThisSuite}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'ra-h-remote-mcp-route-test', version: '1.0.0' },
      },
    }),
  }) as unknown as NextRequest;
}

// Pull the JSON-RPC payloads out of a response body WITHOUT pinning the wire
// framing: a plain JSON body is parsed directly, an SSE body has its payloads
// read off the `data:` lines. The contract under test is that the door
// answers, not how the answer is framed, so a future maintainer may repair the
// lifecycle in either direction without failing this file.
function extractJsonRpcPayloadsFromResponseBody(bodyText: string): Record<string, unknown>[] {
  const trimmedBody = bodyText.trim();
  if (!trimmedBody) {
    return [];
  }
  try {
    const parsedWholeBody: unknown = JSON.parse(trimmedBody);
    return Array.isArray(parsedWholeBody)
      ? (parsedWholeBody as Record<string, unknown>[])
      : [parsedWholeBody as Record<string, unknown>];
  } catch {
    return trimmedBody
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>);
  }
}

// Connect a real MCP client to the route, run the callback, then ALWAYS close
// the transport so no aborted request or timer survives a failing test.
async function withRemoteMcpClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/api/mcp'), {
    fetch: fetchIntoRemoteMcpRoutePostHandler,
  });
  const client = new Client({ name: 'ra-h-remote-mcp-route-test', version: '1.0.0' });

  try {
    await client.connect(transport, { timeout: REMOTE_MCP_REPLY_TIMEOUT_MS });
    return await fn(client);
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  raHAppStubServer = http.createServer((req, res) => {
    void handleAppStubRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    raHAppStubServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = raHAppStubServer.address() as AddressInfo;
  raHAppStubBaseUrl = `http://127.0.0.1:${address.port}`;

  targetUrlBeforeThisSuite = process.env.RAH_MCP_TARGET_URL;
  process.env.RAH_MCP_TARGET_URL = raHAppStubBaseUrl;

  doorTokenBeforeThisSuite = process.env.RAH_MCP_DOOR_TOKEN;
  process.env.RAH_MCP_DOOR_TOKEN = doorTokenForThisSuite;
});

afterAll(async () => {
  if (targetUrlBeforeThisSuite === undefined) {
    delete process.env.RAH_MCP_TARGET_URL;
  } else {
    process.env.RAH_MCP_TARGET_URL = targetUrlBeforeThisSuite;
  }

  if (doorTokenBeforeThisSuite === undefined) {
    delete process.env.RAH_MCP_DOOR_TOKEN;
  } else {
    process.env.RAH_MCP_DOOR_TOKEN = doorTokenBeforeThisSuite;
  }

  await new Promise<void>((resolve, reject) => {
    raHAppStubServer.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  recordedAppRequests = [];
});

describe('remote MCP door answers a client', () => {
  // The opening handshake must complete. Today it does not: the initialize
  // reply is never written to the closed stream, so the client waits out its
  // timeout and throws McpError -32001.
  it('completes the initialize handshake and reports the server identity', async () => {
    await withRemoteMcpClient(async (client) => {
      const serverIdentity = client.getServerVersion();
      expect(serverIdentity?.name).toBe('ra-h-mcp');
    });
  }, CLIENT_DRIVEN_TEST_TIMEOUT_MS);

  // A handshake that completes but carries nothing would be a hollow pass, so
  // the tool list must come back populated and must name every tool the door
  // advertises publicly.
  it('returns the advertised rah_* tool set from listTools', async () => {
    await withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools(undefined, { timeout: REMOTE_MCP_REPLY_TIMEOUT_MS });
      const listedToolNames = listedTools.tools.map((tool) => tool.name);

      expect(listedToolNames.length).toBeGreaterThan(0);
      for (const advertisedToolName of toolNamesTheRemoteMcpDoorAdvertises) {
        expect(listedToolNames, `listTools must offer ${advertisedToolName}`).toContain(advertisedToolName);
      }
    });
  }, CLIENT_DRIVEN_TEST_TIMEOUT_MS);

  // The substantive proof of the whole path: a real tool call must travel
  // client -> transport -> route -> app, and the app's answer must travel all
  // the way back out to the client. rah_search_nodes is driven because it is
  // an ordinary read with a simple request and response shape.
  it('carries a rah_search_nodes call through to the app and the app answer back to the client', async () => {
    await withRemoteMcpClient(async (client) => {
      const toolResult = await client.callTool(
        {
          name: 'rah_search_nodes',
          arguments: { query: 'osteopathy', limit: 5 },
        },
        undefined,
        { timeout: REMOTE_MCP_REPLY_TIMEOUT_MS }
      );

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);

      // Outbound leg: the app received the search the client asked for.
      const searchRequestTheAppReceived = recordedAppRequests.find(
        (entry) => entry.method === 'POST' && entry.pathname === '/api/nodes/direct-search'
      );
      expect(
        searchRequestTheAppReceived,
        'the route should have POSTed the search to the app'
      ).toBeDefined();
      expect(searchRequestTheAppReceived?.body).toMatchObject({ query: 'osteopathy', limit: 5 });

      // Return leg: the app's node came back out through the client.
      expect(toolResult.structuredContent).toMatchObject({
        count: 1,
        nodes: [
          {
            id: stubbedSearchResultNode.id,
            title: stubbedSearchResultNode.title,
            updated_at: stubbedSearchResultNode.updated_at,
          },
        ],
      });
    });
  }, CLIENT_DRIVEN_TEST_TIMEOUT_MS);

  // The direct regression pin for the defect itself, with no MCP client in the
  // way: a raw initialize POST straight to the handler must come back with a
  // body that is not empty and that carries the JSON-RPC result for the id
  // that was sent. Today the body is the empty string, every time, because the
  // stream controller is closed before anything is enqueued into it.
  it('answers a raw initialize POST with a non-empty body carrying the result for that request id', async () => {
    const rawInitializeRequestId = 1;
    const routeResponse = await POST(buildRawInitializeRequest(rawInitializeRequestId));
    const responseBodyText = await routeResponse.text();

    expect(responseBodyText, 'the door must not answer with an empty body').not.toBe('');

    const jsonRpcPayloads = extractJsonRpcPayloadsFromResponseBody(responseBodyText);
    const initializePayload = jsonRpcPayloads.find(
      (payload) => payload.id === rawInitializeRequestId
    );
    expect(
      initializePayload,
      `the body must carry a JSON-RPC payload for id ${rawInitializeRequestId}`
    ).toBeDefined();
    expect(initializePayload).toHaveProperty('result');
  });

  // GUARD (passes before and after the fix): the plain GET metadata handler is
  // a separate path that never touches the streaming transport, so repairing
  // the POST lifecycle must leave its advertised tool list untouched.
  it('still lists the advertised tools from the GET metadata handler', async () => {
    const metadataRequest = new Request('http://127.0.0.1/api/mcp', {
      method: 'GET',
      headers: { Authorization: `Bearer ${doorTokenForThisSuite}` },
    }) as unknown as NextRequest;

    const metadataResponse = await GET(metadataRequest);
    const metadata = (await metadataResponse.json()) as { name: string; tools: string[] };

    expect(metadata.name).toBe('ra-h-mcp');
    expect(metadata.tools).toEqual(toolNamesTheRemoteMcpDoorAdvertises);
  });
});
