/**
 * Shared test harness for driving the REMOTE MCP door (app/api/mcp/route.ts)
 * in process.
 *
 * It is the same seam tests/unit/mcp/remote-mcp-route-responds.test.ts proved
 * out, and the same shape as the local door's seam in
 * tests/unit/mcp/stdio-server-evidence.test.ts — a real MCP client in front,
 * an in-process http server standing in for the running RA-H app behind — so
 * the two doors' tests stay directly comparable. It is factored out here
 * because the door-3 parity work drives the same seam from several files and
 * the harness must not drift between them.
 *
 * No real app, no `next dev`, no socket in front of the route, and no
 * database is ever involved.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextRequest } from 'next/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { POST } from '../../../../app/api/mcp/route';

// How long the MCP client waits for a reply before giving up. Short, so a
// door that stops answering fails fast and readably.
export const REMOTE_MCP_REPLY_TIMEOUT_MS = 4000;

// The bearer token the harness installs as RAH_MCP_DOOR_TOKEN while it runs.
// The door FAILS CLOSED — with no token configured every request answers 503
// — so an unconfigured harness would 503 every door test. An arbitrary value;
// exported so a test file that also drives the route directly can send the
// same credential.
export const REMOTE_MCP_DOOR_HARNESS_TOKEN = 'remote-mcp-door-harness-token-7c21';

// One request the RA-H app stub received from the route under test. The query
// string is kept parsed as well as raw because the read tools carry their
// arguments there rather than in a body.
export type RecordedAppRequest = {
  method: string;
  pathname: string;
  searchParams: Record<string, string>;
  body: Record<string, unknown> | null;
};

// What the stubbed app answers with. `status` defaults to 200; `payload` is
// serialised as the JSON body the route's callRaHApi will read.
export type RaHAppStubReply = {
  status?: number;
  payload: unknown;
};

// Decides the stubbed app's answer for one request. Returning undefined means
// "I do not serve this route", and the stub answers 404 so an unstubbed call
// fails loudly instead of silently looking like an empty result.
export type RaHAppStubResponder = (request: RecordedAppRequest) => RaHAppStubReply | undefined;

// The live harness handed to a test file.
export type RemoteMcpDoorHarness = {
  // Base URL of the stubbed app. Exposed so a test that also drives the LOCAL
  // door can point that spawned process at the same stub.
  raHAppStubBaseUrl: string;
  // Every request the stubbed app received since the last reset, in order.
  recordedAppRequests: () => RecordedAppRequest[];
  // Forget all recorded requests. Call between tests.
  resetRecordedAppRequests: () => void;
  // Install the stubbed app's behaviour for subsequent requests.
  respondWith: (responder: RaHAppStubResponder) => void;
  // Drive the remote door with a real MCP client over its real transport,
  // always closing the transport afterwards.
  withRemoteMcpClient: <T>(fn: (client: Client) => Promise<T>) => Promise<T>;
  // Shut the stub down and restore the environment. Call in afterAll.
  stop: () => Promise<void>;
};

// Collect and parse a JSON request body from an incoming stub request.
async function readJsonRequestBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/**
 * Start the app stub, point the route at it via RAH_MCP_TARGET_URL, and return
 * the harness. The caller must await `stop()` in afterAll.
 */
export async function startRemoteMcpDoorHarness(): Promise<RemoteMcpDoorHarness> {
  // Every request the stub has received since the last reset.
  let recordedAppRequests: RecordedAppRequest[] = [];
  // The stubbed app's current behaviour; 404s everything until a test sets it.
  let appStubResponder: RaHAppStubResponder = () => undefined;
  // The RAH_MCP_TARGET_URL value present before the harness started.
  const targetUrlBeforeHarness = process.env.RAH_MCP_TARGET_URL;
  // The RAH_MCP_DOOR_TOKEN value present before the harness started, restored
  // exactly in stop() — absent stays absent. The harness token replaces it
  // because the fail-closed door refuses every request until one is set.
  const doorTokenBeforeHarness = process.env.RAH_MCP_DOOR_TOKEN;
  process.env.RAH_MCP_DOOR_TOKEN = REMOTE_MCP_DOOR_HARNESS_TOKEN;
  // Base URL the route is pointed at.
  let raHAppStubBaseUrl = '';

  // Record the request, then answer it from the installed responder.
  async function handleAppStubRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', raHAppStubBaseUrl);
    const method = req.method || 'GET';
    const body = method === 'POST' || method === 'PUT' ? await readJsonRequestBody(req) : null;

    const recordedAppRequest: RecordedAppRequest = {
      method,
      pathname: url.pathname,
      searchParams: Object.fromEntries(url.searchParams.entries()),
      body,
    };
    recordedAppRequests.push(recordedAppRequest);

    const reply = appStubResponder(recordedAppRequest);
    if (reply) {
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.payload));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ success: false, error: `Unstubbed app route: ${method} ${url.pathname}` })
    );
  }

  const raHAppStubServer = http.createServer((req, res) => {
    void handleAppStubRequest(req, res);
  });
  await new Promise<void>((resolve) => {
    raHAppStubServer.listen(0, '127.0.0.1', () => resolve());
  });
  raHAppStubBaseUrl = `http://127.0.0.1:${(raHAppStubServer.address() as AddressInfo).port}`;
  process.env.RAH_MCP_TARGET_URL = raHAppStubBaseUrl;

  // The client transport's network layer, replaced so requests reach the
  // route's exported POST handler in process. Any other verb answers 405,
  // which the client treats as "no standalone SSE stream offered" and ignores.
  async function fetchIntoRemoteMcpRoutePostHandler(
    url: string | URL,
    init: RequestInit = {}
  ): Promise<Response> {
    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      return new Response(null, { status: 405 });
    }
    // The harness's own bearer credential rides every forwarded POST, so the
    // locked door lets the test client through.
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${REMOTE_MCP_DOOR_HARNESS_TOKEN}`);
    return POST(new Request(String(url), { ...init, headers }) as unknown as NextRequest);
  }

  return {
    raHAppStubBaseUrl,
    recordedAppRequests: () => recordedAppRequests,
    resetRecordedAppRequests: () => {
      recordedAppRequests = [];
    },
    respondWith: (responder: RaHAppStubResponder) => {
      appStubResponder = responder;
    },
    withRemoteMcpClient: async <T>(fn: (client: Client) => Promise<T>): Promise<T> => {
      const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/api/mcp'), {
        fetch: fetchIntoRemoteMcpRoutePostHandler,
      });
      const client = new Client({ name: 'ra-h-remote-mcp-door-test', version: '1.0.0' });
      try {
        await client.connect(transport, { timeout: REMOTE_MCP_REPLY_TIMEOUT_MS });
        return await fn(client);
      } finally {
        await transport.close();
      }
    },
    stop: async () => {
      if (targetUrlBeforeHarness === undefined) {
        delete process.env.RAH_MCP_TARGET_URL;
      } else {
        process.env.RAH_MCP_TARGET_URL = targetUrlBeforeHarness;
      }
      if (doorTokenBeforeHarness === undefined) {
        delete process.env.RAH_MCP_DOOR_TOKEN;
      } else {
        process.env.RAH_MCP_DOOR_TOKEN = doorTokenBeforeHarness;
      }
      await new Promise<void>((resolve, reject) => {
        raHAppStubServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
