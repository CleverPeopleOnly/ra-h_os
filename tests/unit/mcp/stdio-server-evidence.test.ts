/**
 * Tests for the app-MCP proxy (apps/mcp-server/stdio-server.js): the
 * rah_create_edge tool must accept the one signed writable evidence field
 * (belief_evidence_support) and include it in the POST body it sends to
 * /api/edges.
 *
 * belief_evidence_direction and belief_evidence_strength are MERGED AWAY into
 * that signed field: the tool must no longer advertise either on its input
 * schema and must never forward them. A stale client that still passes them
 * must still get a successful edge creation — the fields are dropped by the
 * schema, not rejected, and the resulting edge is a plain non-evidence one.
 *
 * This proxy is also the app-side write path that validates evidence today
 * (its Zod schema bounds the range), so the support range rules are pinned
 * here as well as on the standalone server. Support is UNSIGNED, 0..1 — the
 * sign of a contribution comes from the source NODE's credence, never from
 * support — so every negative value and every value above 1 is a tool error
 * that never reaches the app, while exactly 0 is ACCEPTED and forwarded:
 * NULL means the edge was never assessed as evidence, 0 means it was
 * assessed and carries nothing, and the proxy must not collapse the two.
 * (The in-range acceptance of 1 and of values between 0 and 1 is pinned in
 * tests/unit/mcp/stdio-server-support-range.test.ts.)
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

describe('app-MCP proxy rah_create_edge evidence forwarding', () => {
  // EDITED from the two-field forwarding case: the one signed evidence
  // argument must appear in the POST body, while stale
  // belief_evidence_direction / belief_evidence_strength arguments are
  // dropped — the tool call still succeeds and neither reaches the app.
  it('includes belief_evidence_support in the POST body and drops stale belief_evidence_direction / belief_evidence_strength', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result that supports the claim node.',
          confirmed_by_user: true,
          belief_evidence_support: 0.9,
          belief_evidence_direction: 'against',
          belief_evidence_strength: 0.4,
        },
      });

      // Ignored, not rejected: the stale arguments still yield a successful
      // edge creation rather than a tool error.
      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);

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
      // The signed evidence field must reach the app.
      expect(createEdgeRequest?.body).toMatchObject({
        belief_evidence_support: 0.9,
      });
      // Neither merged-away field may be forwarded. The stale pair said
      // 'against' 0.4: if either survived, the edge's meaning would flip.
      const forwardedBodyKeys = Object.keys(createEdgeRequest?.body ?? {});
      expect(forwardedBodyKeys).not.toContain('belief_evidence_direction');
      expect(forwardedBodyKeys).not.toContain('belief_evidence_strength');
    });
  });

  // REWRITTEN from "forwards a negative belief_evidence_support with its
  // sign intact". Support is UNSIGNED (0..1): a negative value is not a
  // contradiction, it is an invalid write — contradiction is expressed by
  // the source NODE's negative credence. So every negative value, from a
  // small one through the old signed range's -1 boundary and beyond, must be
  // a tool error that never produces a request to the app.
  it('rejects every negative belief_evidence_support with a tool error and sends no request to /api/edges', async () => {
    await withMcpClient(async (client) => {
      for (const rejectedNegativeSupport of [-0.1, -0.9, -1, -1.5]) {
        const toolResult = await client.callTool({
          name: 'rah_create_edge',
          arguments: {
            sourceId: 2,
            targetId: 1,
            explanation: 'Reports a measured result about the claim node.',
            confirmed_by_user: true,
            belief_evidence_support: rejectedNegativeSupport,
          },
        });

        expect(
          (toolResult as { isError?: boolean }).isError,
          `a support of ${rejectedNegativeSupport} must be rejected — support is unsigned`
        ).toBe(true);
      }
      // None of the rejected calls produced a request to the app.
      expect(
        recordedApiRequests.filter(
          (entry) => entry.method === 'POST' && entry.pathname === '/api/edges'
        )
      ).toHaveLength(0);
    });
  });

  // CORRECTED from "a support of exactly 0 is rejected". A support of 0 is a
  // legitimate, recordable judgement: NULL means the edge was never assessed
  // as evidence, 0 means it WAS assessed and leans neither way. Rejecting 0
  // would force a classifier that genuinely finds no lean to invent one. So
  // the proxy must accept it and forward it verbatim — a zero that reached
  // the app as an omitted field would arrive as "not evidence" instead.
  it('accepts a belief_evidence_support of exactly 0 and forwards it in the POST body', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: 'Reports a measured result that bears neither way on the claim node.',
          confirmed_by_user: true,
          belief_evidence_support: 0,
        },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);

      const createEdgeRequest = recordedApiRequests.find(
        (entry) => entry.method === 'POST' && entry.pathname === '/api/edges'
      );
      expect(createEdgeRequest, 'proxy should have POSTed to /api/edges').toBeDefined();
      // The key must be present AND zero: dropping it would turn an assessed
      // "leans neither way" into an unassessed plain edge at the app.
      expect(Object.keys(createEdgeRequest?.body ?? {})).toContain('belief_evidence_support');
      expect(createEdgeRequest?.body?.belief_evidence_support).toBe(0);
    });
  });

  // The unsigned range tops out at 1: anything above it is out of bounds, so
  // the tool must error and POST nothing. (Negative values have their own
  // rejection test above — they are the semantic change, not a mere bound.)
  it('rejects a belief_evidence_support above 1 and sends no request to /api/edges', async () => {
    await withMcpClient(async (client) => {
      for (const outOfRangeSupport of [1.5, 2]) {
        const toolResult = await client.callTool({
          name: 'rah_create_edge',
          arguments: {
            sourceId: 2,
            targetId: 1,
            explanation: 'Reports a measured result that supports the claim node.',
            confirmed_by_user: true,
            belief_evidence_support: outOfRangeSupport,
          },
        });

        expect(
          (toolResult as { isError?: boolean }).isError,
          `support ${outOfRangeSupport} must be rejected`
        ).toBe(true);
      }
      expect(
        recordedApiRequests.filter(
          (entry) => entry.method === 'POST' && entry.pathname === '/api/edges'
        )
      ).toHaveLength(0);
    });
  });

  // EDITED from the two-field discoverability case: the advertised input
  // schema must name the one signed evidence field and must no longer
  // advertise either merged-away field to any external agent.
  it('advertises belief_evidence_support and neither belief_evidence_direction nor belief_evidence_strength in the rah_create_edge input schema', async () => {
    await withMcpClient(async (client) => {
      const result = await client.listTools();
      const createEdgeTool = result.tools.find((tool) => tool.name === 'rah_create_edge');
      expect(createEdgeTool).toBeDefined();

      const inputSchemaJson = JSON.stringify(createEdgeTool?.inputSchema);
      expect(inputSchemaJson).toContain('belief_evidence_support');
      expect(inputSchemaJson).not.toContain('belief_evidence_direction');
      expect(inputSchemaJson).not.toContain('belief_evidence_strength');
      expect(inputSchemaJson).not.toContain('belief_evidence_origin_key');
    });
  });
});
