/**
 * FAILING-FIRST tests for the evidence-leaves-the-edges-table slice on the
 * LOCAL app-backed MCP door (apps/mcp-server/stdio-server.js): THE EDGE TOOLS
 * NO LONGER SPEAK EVIDENCE.
 *
 * The same post-slice contract tests/unit/mcp/remote-mcp-route-edge-tools-
 * shed-evidence.test.ts pins on the remote door, pinned again here because
 * the two doors declare their tools in two separate files and that is exactly
 * how the belief surface drifted before:
 *
 *  - rah_create_edge and rah_update_edge no longer advertise
 *    belief_evidence_support, and rah_query_edges no longer advertises either
 *    evidence field per edge,
 *  - a STALE caller still sending belief_evidence_support on either write is
 *    NOT an error — the call succeeds and the request forwarded to the app
 *    carries no evidence key,
 *  - rah_query_edges answers carry NEITHER evidence field, even when the app
 *    behind the door still reports rows bearing them.
 *
 * Seam (same as tests/unit/mcp/stdio-server-evidence.test.ts): the spawned
 * proxy is pointed at a local in-process HTTP stub via RAH_MCP_TARGET_URL,
 * and the stub records every request. No real app and no database is
 * involved. The spawned proxy process is always terminated in the finally
 * block of withMcpClient, so no orphan processes survive a failure.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The evidence field the write tools must no longer advertise or forward.
const removedEdgeWriteEvidenceFieldName = 'belief_evidence_support';

// The two evidence fields an edge read answer must no longer carry.
const removedEdgeReadEvidenceFieldNames = [
  'belief_evidence_support',
  'belief_evidence_contribution',
];

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

// Route the stub's requests: record everything, answer the three edge routes
// the tools under test forward to. GET /api/edges deliberately answers a
// LEGACY row still carrying evidence values, so the no-relay pin below is
// proven against a not-yet-migrated app rather than a conveniently clean one.
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
        data: { id: 42, from_node_id: 1, to_node_id: 2, explanation: 'came from the fixture source' },
        message: 'Edge created successfully',
      })
    );
    return;
  }

  if (method === 'PUT' && url.pathname === '/api/edges/7') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        data: { id: 7, from_node_id: 1, to_node_id: 2, explanation: 'corrected fixture explanation' },
        message: 'Edge updated successfully',
      })
    );
    return;
  }

  if (method === 'GET' && url.pathname === '/api/edges') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        data: [
          {
            id: 11,
            from_node_id: 1,
            to_node_id: 2,
            context: { type: 'source_of' },
            explanation: 'came from the fixture source',
            created_at: '2026-06-01T00:00:00.000Z',
            belief_evidence_support: 0.9,
            belief_evidence_contribution: 0.72,
          },
        ],
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

  const client = new Client({ name: 'ra-h-stdio-shed-evidence-test', version: '1.0.0' });
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

// Property names a tool's advertised input schema declares.
function inputSchemaPropertyNames(advertisedTool: {
  inputSchema?: { properties?: Record<string, unknown> };
}): string[] {
  return Object.keys(advertisedTool.inputSchema?.properties ?? {});
}

// Property names of the per-edge item object inside an edge-read tool's
// advertised output schema.
function edgeReadItemPropertyNames(advertisedTool: {
  outputSchema?: {
    properties?: Record<string, { items?: { properties?: Record<string, unknown> } }>;
  };
}): string[] {
  return Object.keys(advertisedTool.outputSchema?.properties?.edges?.items?.properties ?? {});
}

// Extract a tool call's structured content with a caller-chosen shape.
function getStructured<T>(result: unknown): T {
  return (result as { structuredContent?: unknown }).structuredContent as T;
}

describe('stdio door edge tools shed evidence', () => {
  // The advertised surface: no evidence field anywhere on the edge tools.
  it('the edge tools no longer advertise any evidence field', async () => {
    const advertisedTools = await withMcpClient(async (client) => (await client.listTools()).tools);

    for (const edgeWriteToolName of ['rah_create_edge', 'rah_update_edge']) {
      const edgeWriteTool = advertisedTools.find((tool) => tool.name === edgeWriteToolName);
      expect(edgeWriteTool, `${edgeWriteToolName} must still exist`).toBeDefined();
      expect(
        inputSchemaPropertyNames(edgeWriteTool!),
        `${edgeWriteToolName} must not advertise ${removedEdgeWriteEvidenceFieldName}`
      ).not.toContain(removedEdgeWriteEvidenceFieldName);
    }

    const edgeReadTool = advertisedTools.find((tool) => tool.name === 'rah_query_edges');
    expect(edgeReadTool, 'rah_query_edges must still exist').toBeDefined();
    for (const removedFieldName of removedEdgeReadEvidenceFieldNames) {
      expect(
        edgeReadItemPropertyNames(edgeReadTool!),
        `rah_query_edges must not advertise ${removedFieldName} per edge`
      ).not.toContain(removedFieldName);
    }
  });

  // The stale-caller create: schema strips the key, the call succeeds, the
  // forwarded body is evidence-free.
  it('rah_create_edge tolerates a stale belief_evidence_support and forwards no evidence key', async () => {
    const createResult = await withMcpClient((client) =>
      client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 1,
          targetId: 2,
          explanation: 'came from the fixture source',
          confirmed_by_user: true,
          // The stale caller's key: no longer part of the contract.
          belief_evidence_support: 0.9,
        },
      })
    );

    expect(getStructured<{ success: boolean; edgeId: number }>(createResult)).toMatchObject({
      success: true,
      edgeId: 42,
    });

    const forwardedEdgeCreateRequest = recordedApiRequests.find(
      (request) => request.method === 'POST' && request.pathname === '/api/edges'
    );
    expect(forwardedEdgeCreateRequest, 'the create must reach the app').toBeDefined();
    expect(
      Object.keys(forwardedEdgeCreateRequest!.body ?? {}),
      'the forwarded create body must not carry an evidence key'
    ).not.toContain(removedEdgeWriteEvidenceFieldName);
  });

  // The stale-caller update: same tolerance, same clean forwarded body.
  it('rah_update_edge tolerates a stale belief_evidence_support and forwards no evidence key', async () => {
    const updateResult = await withMcpClient((client) =>
      client.callTool({
        name: 'rah_update_edge',
        arguments: {
          id: 7,
          explanation: 'corrected fixture explanation',
          confirmed_by_user: true,
          // The stale caller's key, ignored exactly as on create.
          belief_evidence_support: 0.4,
        },
      })
    );

    expect(getStructured<{ success: boolean; edgeId: number }>(updateResult)).toMatchObject({
      success: true,
      edgeId: 7,
    });

    const forwardedEdgeUpdateRequest = recordedApiRequests.find(
      (request) => request.method === 'PUT' && request.pathname === '/api/edges/7'
    );
    expect(forwardedEdgeUpdateRequest, 'the update must reach the app').toBeDefined();
    expect(
      Object.keys(forwardedEdgeUpdateRequest!.body ?? {}),
      'the forwarded update body must not carry an evidence key'
    ).not.toContain(removedEdgeWriteEvidenceFieldName);
  });

  // The read answer: a legacy app row still bearing evidence values must be
  // answered WITHOUT either field — the contract shed them.
  it('rah_query_edges answers edges without either evidence field', async () => {
    const queryResult = await withMcpClient((client) =>
      client.callTool({ name: 'rah_query_edges', arguments: { nodeId: 1 } })
    );

    const answeredEdges = getStructured<{ edges: Array<Record<string, unknown>> }>(
      queryResult
    ).edges;
    expect(answeredEdges).toHaveLength(1);
    for (const removedFieldName of removedEdgeReadEvidenceFieldNames) {
      expect(
        Object.prototype.hasOwnProperty.call(answeredEdges[0], removedFieldName),
        `rah_query_edges answer must not carry ${removedFieldName}`
      ).toBe(false);
    }
  });
});
