/**
 * Correcting an edge's SUPPORT through the app-MCP proxy
 * (apps/mcp-server/stdio-server.js, tool rah_update_edge).
 *
 * belief_evidence_support can be written when an edge is created
 * (rah_create_edge forwards it) but the update tool accepts only an explanation
 * and the confirmation flag, so a support written once could never be
 * corrected. This file pins the write door:
 *
 *  - the tool accepts an optional belief_evidence_support and forwards it as a
 *    top-level field of the PUT body it sends to /api/edges/[id], so it reaches
 *    the edges column rather than the app-owned context JSON,
 *  - it sends the field ONLY when the caller supplied one, mirroring the
 *    pass-through convention rah_create_edge already follows: an
 *    explanation-only correction must still send an evidence-free body, because
 *    a support key invented for it would turn a plain relationship edge into
 *    assessed evidence,
 *  - support is UNSIGNED, 0..1, and this door enforces that range exactly as
 *    rah_create_edge's does (see tests/unit/mcp/stdio-server-evidence.test.ts
 *    and tests/unit/mcp/stdio-server-support-range.test.ts): every negative
 *    value and every value above 1 is a tool error that reaches the app as no
 *    request at all, while exactly 0 and exactly 1 are accepted and forwarded.
 *    0 is a recorded judgement — assessed, carries nothing — so it must arrive
 *    as the key 0 and never as an omitted field,
 *  - confirmed_by_user stays MANDATORY: a support correction is a write, so it
 *    must not become a way around the confirmation gate.
 *
 * Seam (same as tests/unit/mcp/stdio-server-evidence.test.ts): the spawned
 * proxy is pointed at a local in-process HTTP stub via RAH_MCP_TARGET_URL and
 * the stub records every request body. No real app and no database is involved.
 * The spawned proxy process is always terminated in the finally block of
 * withMcpClient, so no orphan processes survive a failure.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The edge id every correction in this file is aimed at.
const CORRECTED_EDGE_ID = 31;

// The explanation an accepted correction carries: long enough and specific
// enough to pass the app's edge-explanation quality rules.
const CORRECTED_EDGE_EXPLANATION =
  'The source node reports a measured result bearing on the claim node.';

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

// Route the stub's requests: record everything, answer PUT /api/edges/<id> with
// a successful update so an accepted tool call completes.
async function handleApiStubRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', apiStubBaseUrl);
  const method = req.method || 'GET';
  const body = method === 'POST' || method === 'PUT' ? await readJsonBody(req) : null;

  recordedApiRequests.push({ method, pathname: url.pathname, body });

  if (method === 'PUT' && url.pathname === `/api/edges/${CORRECTED_EDGE_ID}`) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        data: { id: CORRECTED_EDGE_ID },
        message: 'Edge updated successfully',
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

  const client = new Client({ name: 'ra-h-stdio-update-edge-support-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// Find the (single) PUT /api/edges/<id> request the stub recorded, if any.
function findRecordedUpdateEdgeRequest(): RecordedApiRequest | undefined {
  return recordedApiRequests.find(
    (entry) => entry.method === 'PUT' && entry.pathname === `/api/edges/${CORRECTED_EDGE_ID}`
  );
}

// How many update requests reached the app — 0 is what a rejected correction
// must produce.
function countRecordedUpdateEdgeRequests(): number {
  return recordedApiRequests.filter(
    (entry) => entry.method === 'PUT' && entry.pathname === `/api/edges/${CORRECTED_EDGE_ID}`
  ).length;
}

// Call rah_update_edge as a confirmed correction, optionally carrying a support.
async function callUpdateEdgeTool(
  client: Client,
  correction: { belief_evidence_support?: number; confirmed_by_user?: boolean }
): Promise<{ isError?: boolean }> {
  return (await client.callTool({
    name: 'rah_update_edge',
    arguments: {
      id: CORRECTED_EDGE_ID,
      explanation: CORRECTED_EDGE_EXPLANATION,
      confirmed_by_user: correction.confirmed_by_user ?? true,
      ...(correction.belief_evidence_support === undefined
        ? {}
        : { belief_evidence_support: correction.belief_evidence_support }),
    },
  })) as { isError?: boolean };
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

describe('app-MCP proxy rah_update_edge support correction', () => {
  // The correction the missing field makes impossible today: an in-range
  // support must reach the app verbatim, as a top-level body field so it lands
  // in the edges column rather than the app-owned context JSON.
  it('forwards an in-range belief_evidence_support as a top-level field of the PUT body', async () => {
    await withMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        belief_evidence_support: 0.42,
      });

      expect(updateEdgeToolResult.isError ?? false).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(updateEdgeRequest, 'proxy should have PUT to /api/edges/<id>').toBeDefined();
      expect(updateEdgeRequest?.body?.belief_evidence_support).toBeCloseTo(0.42, 10);
      // The existing confirmed-explanation payload still travels alongside it.
      expect(updateEdgeRequest?.body).toMatchObject({ confirmed_by_user: true });
    });
  });

  // A support of exactly 0 is a recorded judgement — assessed, carries nothing.
  // The key must be PRESENT and 0: a dropped key would arrive at the app as
  // "no support supplied" and leave the old value in place.
  it('accepts a belief_evidence_support of exactly 0 and forwards the key with value 0', async () => {
    await withMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        belief_evidence_support: 0,
      });

      expect(updateEdgeToolResult.isError ?? false).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(Object.keys(updateEdgeRequest?.body ?? {})).toContain('belief_evidence_support');
      expect(updateEdgeRequest?.body?.belief_evidence_support).toBe(0);
    });
  });

  // The upper boundary of the unsigned range is in range: a correction to
  // full-strength evidence must be forwarded verbatim.
  it('accepts a belief_evidence_support of exactly 1 and forwards it', async () => {
    await withMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        belief_evidence_support: 1,
      });

      expect(updateEdgeToolResult.isError ?? false).toBe(false);
      expect(findRecordedUpdateEdgeRequest()?.body?.belief_evidence_support).toBe(1);
    });
  });

  // Support is unsigned: a negative value is not a contradiction, it is an
  // invalid write. Contradiction is expressed by the source NODE's negative
  // credence, so every negative correction must be refused before the app sees
  // it.
  it('rejects every negative belief_evidence_support and sends no request to the app', async () => {
    await withMcpClient(async (client) => {
      for (const rejectedNegativeSupport of [-0.1, -1, -1.5]) {
        const updateEdgeToolResult = await callUpdateEdgeTool(client, {
          belief_evidence_support: rejectedNegativeSupport,
        });

        expect(
          updateEdgeToolResult.isError,
          `a support of ${rejectedNegativeSupport} must be rejected — support is unsigned`
        ).toBe(true);
      }
      expect(countRecordedUpdateEdgeRequests()).toBe(0);
    });
  });

  // The unsigned range tops out at 1, so anything above it is out of bounds and
  // must never be forwarded.
  it('rejects a belief_evidence_support above 1 and sends no request to the app', async () => {
    await withMcpClient(async (client) => {
      for (const outOfRangeSupport of [1.5, 2]) {
        const updateEdgeToolResult = await callUpdateEdgeTool(client, {
          belief_evidence_support: outOfRangeSupport,
        });

        expect(
          updateEdgeToolResult.isError,
          `support ${outOfRangeSupport} must be rejected`
        ).toBe(true);
      }
      expect(countRecordedUpdateEdgeRequests()).toBe(0);
    });
  });

  // A support correction is a WRITE, so it must not become a way around the
  // confirmation gate: an unconfirmed correction is refused even when the
  // support itself is perfectly in range.
  it('rejects a support correction that is not confirmed by the user and sends no request to the app', async () => {
    await withMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        belief_evidence_support: 0.42,
        confirmed_by_user: false,
      });

      expect(
        updateEdgeToolResult.isError,
        'an unconfirmed support correction must be rejected'
      ).toBe(true);
      expect(countRecordedUpdateEdgeRequests()).toBe(0);
    });
  });

  // Discoverability: an external agent learns it can correct a support from the
  // advertised input schema, and learns the confirmation flag is still required.
  it('advertises belief_evidence_support and a required confirmed_by_user on the rah_update_edge input schema', async () => {
    await withMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const updateEdgeTool = listedTools.tools.find((tool) => tool.name === 'rah_update_edge');
      expect(updateEdgeTool).toBeDefined();

      const inputSchemaJson = JSON.stringify(updateEdgeTool?.inputSchema);
      expect(inputSchemaJson).toContain('belief_evidence_support');
      // The merged-away pair must never appear on a belief write door.
      expect(inputSchemaJson).not.toContain('belief_evidence_direction');
      expect(inputSchemaJson).not.toContain('belief_evidence_strength');
      expect(updateEdgeTool?.inputSchema?.required as string[]).toContain('confirmed_by_user');
    });
  });

  // GUARD: an explanation-only correction must keep working exactly as it does
  // today, and must send an EVIDENCE-FREE body — a support key invented for it
  // would turn a plain relationship edge into assessed evidence.
  it('GUARD: an explanation-only correction still sends the confirmed explanation with no evidence field', async () => {
    await withMcpClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {});

      expect(updateEdgeToolResult.isError ?? false).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(updateEdgeRequest, 'proxy should have PUT to /api/edges/<id>').toBeDefined();
      expect(updateEdgeRequest?.body).toMatchObject({
        context: { explanation: CORRECTED_EDGE_EXPLANATION, created_via: 'mcp' },
        confirmed_by_user: true,
      });
      expect(Object.keys(updateEdgeRequest?.body ?? {})).not.toContain('belief_evidence_support');
    });
  });
});
