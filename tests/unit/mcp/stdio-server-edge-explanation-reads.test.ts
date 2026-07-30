/**
 * EDGE explanation and creation-timestamp round-trip through the app-MCP proxy
 * (apps/mcp-server/stdio-server.js, tool rah_query_edges).
 *
 * `edges.explanation` is a real column (see the DDL in
 * src/services/database/sqlite-client.ts) and GET /api/edges serialises the
 * rows verbatim, so both the explanation and `created_at` already reach the
 * tool. Its mapping then drops them, so the one thing every edge in this graph
 * is required to have — the reason the connection exists — never reaches the
 * agent reading the edge. This file pins the contract instead:
 *
 *  - each entry of structuredContent.edges carries `explanation` and
 *    `created_at` as the app returned them,
 *  - the same normalisation discipline the belief columns already follow on this
 *    mapping applies to the new fields: a MISSING key becomes null and a stored
 *    NULL stays null. An edge with no explanation must report null, NEVER an
 *    empty string — an empty string reads as "an explanation was written and it
 *    said nothing",
 *  - the advertised output schema names both fields, so an external agent can
 *    discover them. (The MCP SDK validates structuredContent against the
 *    advertised output schema, so the mapping and the schema are only usable
 *    once they are in step.)
 *
 * The belief columns' own pass-through is pinned once, in
 * tests/unit/mcp/stdio-server-belief-edge-reads.test.ts; the fixtures below
 * carry them for realism but this file does not assert them a second time.
 *
 * Seam (same as tests/unit/mcp/stdio-server-belief-edge-reads.test.ts): the
 * spawned proxy is pointed at a local in-process HTTP stub via
 * RAH_MCP_TARGET_URL, and the stub answers GET /api/edges with three seeded
 * edges, one in each explanation state. No real app and no database is
 * involved. The spawned proxy process is always terminated in the finally block
 * of withMcpClient, so no orphan processes survive a failure.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// One edge row as an edge read must carry it: the identity and belief columns
// the tool already reports, plus the explanation and creation timestamp it
// drops today. explanation is nullable because an edge that has none must say
// so with null rather than an empty string.
interface EdgeReadRow {
  id: number;
  from_node_id: number;
  to_node_id: number;
  source?: string;
  // Relationship label the tool derives from the row's type/source columns; set
  // on the tool's output, absent from the app rows the stub serves.
  type?: string | null;
  explanation?: string | null;
  created_at: string;
  belief_evidence_support: number | null;
  belief_evidence_contribution: number | null;
}

// Three explanation states the read path must keep distinct, as the app would
// serialise them straight off the row: a written explanation, a stored NULL,
// and a row where the key is absent from the JSON altogether.
const threeStateEdgeExplanationRows: EdgeReadRow[] = [
  {
    id: 21,
    from_node_id: 2,
    to_node_id: 1,
    source: 'user',
    explanation: 'The source node reports a measured result bearing on the claim node.',
    created_at: '2026-07-03T10:00:00.000Z',
    belief_evidence_support: 0.75,
    belief_evidence_contribution: 0.6,
  },
  {
    id: 22,
    from_node_id: 3,
    to_node_id: 1,
    source: 'user',
    explanation: null,
    created_at: '2026-07-04T10:00:00.000Z',
    belief_evidence_support: null,
    belief_evidence_contribution: null,
  },
  {
    id: 23,
    from_node_id: 4,
    to_node_id: 1,
    source: 'ai_similarity',
    created_at: '2026-07-05T10:00:00.000Z',
    belief_evidence_support: 0.5,
    belief_evidence_contribution: null,
  },
];

// The in-process HTTP stub standing in for the running RA-H app.
let apiStubServer: http.Server;
// Base URL the spawned proxy is pointed at via RAH_MCP_TARGET_URL.
let apiStubBaseUrl = '';

// Route the stub's requests: answer GET /api/edges with the three seeded edges
// in the app's own envelope ({ success, data, count }).
function handleApiStubRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', apiStubBaseUrl);
  const method = req.method || 'GET';

  if (method === 'GET' && url.pathname === '/api/edges') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        data: threeStateEdgeExplanationRows,
        count: threeStateEdgeExplanationRows.length,
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

  const client = new Client({ name: 'ra-h-stdio-edge-explanation-reads-test', version: '1.0.0' });
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

// Call rah_query_edges for the seeded target node and return the structured
// edge read.
async function callQueryEdgesTool(
  client: Client
): Promise<{ count: number; edges: EdgeReadRow[] }> {
  const edgeReadToolResult = await client.callTool({
    name: 'rah_query_edges',
    arguments: { nodeId: 1, direction: 'into' },
  });
  expect((edgeReadToolResult as { isError?: boolean }).isError ?? false).toBe(false);
  return getStructured<{ count: number; edges: EdgeReadRow[] }>(edgeReadToolResult);
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

describe('app-MCP proxy rah_query_edges explanation and creation-timestamp reads', () => {
  // The pass-through the defect breaks: the explanation an edge was required to
  // be created with, and the timestamp it was created at, must survive the
  // proxy's own mapping step.
  it('surfaces the explanation and created_at of an edge the app returned', async () => {
    await withMcpClient(async (client) => {
      const structuredEdgeRead = await callQueryEdgesTool(client);

      expect(structuredEdgeRead.count).toBe(3);
      const edgeWithWrittenExplanation = structuredEdgeRead.edges.find((edge) => edge.id === 21);
      expect(edgeWithWrittenExplanation?.explanation).toBe(
        'The source node reports a measured result bearing on the claim node.'
      );
      expect(edgeWithWrittenExplanation?.created_at).toBe('2026-07-03T10:00:00.000Z');
    });
  });

  // A stored NULL explanation must stay null, with the key PRESENT: dropping
  // the key would make an unexplained edge indistinguishable from one the tool
  // forgot to report on.
  it('reports a stored NULL explanation as null with the key present', async () => {
    await withMcpClient(async (client) => {
      const structuredEdgeRead = await callQueryEdgesTool(client);

      const edgeWithNullExplanation = structuredEdgeRead.edges.find((edge) => edge.id === 22);
      expect(Object.keys(edgeWithNullExplanation ?? {})).toContain('explanation');
      expect(edgeWithNullExplanation?.explanation).toBeNull();
      // Never the empty string: that would read as an explanation that was
      // written and said nothing, rather than one that was never written.
      expect(edgeWithNullExplanation?.explanation).not.toBe('');
      expect(edgeWithNullExplanation?.created_at).toBe('2026-07-04T10:00:00.000Z');
    });
  });

  // An absent key normalises to null, exactly as the belief columns on this
  // same mapping already do — never to undefined and never to an empty string.
  it('normalises a missing explanation key to null rather than an empty string', async () => {
    await withMcpClient(async (client) => {
      const structuredEdgeRead = await callQueryEdgesTool(client);

      const edgeWithoutExplanationKey = structuredEdgeRead.edges.find((edge) => edge.id === 23);
      expect(Object.keys(edgeWithoutExplanationKey ?? {})).toContain('explanation');
      expect(edgeWithoutExplanationKey?.explanation).toBeNull();
      expect(edgeWithoutExplanationKey?.explanation).not.toBe('');
      expect(edgeWithoutExplanationKey?.created_at).toBe('2026-07-05T10:00:00.000Z');
    });
  });

  // Discoverability: an external agent learns what an edge read returns from
  // the advertised output schema. The SDK also validates structuredContent
  // against that schema, so the mapping above is only usable once the schema
  // names both fields too.
  it('advertises explanation and created_at on the rah_query_edges output schema', async () => {
    await withMcpClient(async (client) => {
      const listedTools = await client.listTools();
      const queryEdgesTool = listedTools.tools.find((tool) => tool.name === 'rah_query_edges');
      expect(queryEdgesTool).toBeDefined();

      const outputSchemaJson = JSON.stringify(queryEdgesTool?.outputSchema);
      expect(outputSchemaJson).toContain('explanation');
      expect(outputSchemaJson).toContain('created_at');
    });
  });

  // GUARD: the identity fields the tool already reports must keep arriving
  // unchanged — adding explanation and created_at must not disturb them.
  it('GUARD: still reports id, from_node_id, to_node_id and type for every edge', async () => {
    await withMcpClient(async (client) => {
      const structuredEdgeRead = await callQueryEdgesTool(client);

      expect(structuredEdgeRead.edges.map((edge) => edge.id)).toEqual([21, 22, 23]);
      expect(structuredEdgeRead.edges[0]).toMatchObject({
        from_node_id: 2,
        to_node_id: 1,
        type: 'user',
      });
    });
  });
});
