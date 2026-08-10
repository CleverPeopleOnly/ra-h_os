/**
 * Belief-evidence EDGE READS through the app-MCP proxy
 * (apps/mcp-server/stdio-server.js, tool rah_query_edges).
 *
 * The shipped tool maps each edge the app returned down to
 * { id, from_node_id, to_node_id, type, weight } — so both belief columns the
 * app can already read are thrown away before any external agent sees them,
 * and the tool can only ask for a node and a page size. This file pins the
 * contract instead:
 *
 *  - every returned edge carries belief_evidence_support and
 *    belief_evidence_contribution verbatim, INCLUDING NULL: support NULL means
 *    the edge is not evidence at all, and a support with contribution NULL
 *    means evidence nobody has graded yet — the state the app's recovery sweep
 *    looks for, which must never be coerced to 0,
 *  - the tool sends nodeId, direction, limit and offset to GET /api/edges,
 *    with 'both' when the caller omits the direction,
 *  - a direction the read path does not implement, and a negative offset, are
 *    tool errors that reach the app as no request at all,
 *  - the advertised input schema names direction and offset, and the advertised
 *    output schema names both belief columns, so an external agent can discover
 *    the evidence side of the graph. (The MCP SDK validates structuredContent
 *    against the output schema, so the read is not usable until both are in
 *    step.)
 *
 * Seam (same as tests/unit/mcp/stdio-server-evidence.test.ts): the spawned
 * proxy is pointed at a local in-process HTTP stub via RAH_MCP_TARGET_URL, and
 * the stub records every request — including its query string — and answers
 * GET /api/edges with three seeded edges, one in each evidence state. No real
 * app and no database is involved. The spawned proxy process is always
 * terminated in the finally block of withMcpClient, so no orphan processes
 * survive a failure.
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

// One edge row as an edge read must carry it: identity columns plus BOTH
// belief columns, each nullable because NULL is a meaningful state on both.
interface BeliefEdgeReadRow {
  id: number;
  from_node_id: number;
  to_node_id: number;
  belief_evidence_support: number | null;
  belief_evidence_contribution: number | null;
}

// The three edge states the read path must keep distinct, as the app would
// return them: a plain relationship edge (support NULL), an ungraded evidence
// edge (support set, contribution NULL), and a graded evidence edge (both).
const threeStateEdgeReadRows: BeliefEdgeReadRow[] = [
  {
    id: 11,
    from_node_id: 2,
    to_node_id: 1,
    belief_evidence_support: null,
    belief_evidence_contribution: null,
  },
  {
    id: 12,
    from_node_id: 3,
    to_node_id: 1,
    belief_evidence_support: 0.5,
    belief_evidence_contribution: null,
  },
  {
    id: 13,
    from_node_id: 4,
    to_node_id: 1,
    belief_evidence_support: 0.75,
    belief_evidence_contribution: 0.6,
  },
];

// The in-process HTTP stub standing in for the running RA-H app.
let apiStubServer: http.Server;
// Base URL the spawned proxy is pointed at via RAH_MCP_TARGET_URL.
let apiStubBaseUrl = '';
// Every request the stub received, in arrival order.
let recordedApiRequests: RecordedApiRequest[] = [];

// Route the stub's requests: record method, path and query string, then answer
// GET /api/edges with the three seeded edges so the tool call completes.
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
        data: threeStateEdgeReadRows,
        count: threeStateEdgeReadRows.length,
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

describe('app-MCP proxy rah_query_edges belief-evidence edge reads', () => {
  // The pass-through the defect breaks: both belief columns must survive the
  // proxy's own mapping step for all three edge states, with NULL left as
  // NULL. An ungraded evidence edge reported as contribution 0 would look
  // graded-and-worthless to the agent reading it.
  it('surfaces belief_evidence_support and belief_evidence_contribution for plain, ungraded and graded edges', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_query_edges',
        arguments: { nodeId: 1, direction: 'into' },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const structured = getStructured<{ count: number; edges: BeliefEdgeReadRow[] }>(toolResult);
      expect(structured.count).toBe(3);

      const plainEdge = structured.edges.find(edge => edge.id === 11);
      // The key must be PRESENT and null: dropping it would make an
      // unassessed edge indistinguishable from one the tool forgot to report.
      expect(Object.keys(plainEdge ?? {})).toContain('belief_evidence_support');
      expect(Object.keys(plainEdge ?? {})).toContain('belief_evidence_contribution');
      expect(plainEdge?.belief_evidence_support).toBeNull();
      expect(plainEdge?.belief_evidence_contribution).toBeNull();

      const ungradedEvidenceEdge = structured.edges.find(edge => edge.id === 12);
      expect(ungradedEvidenceEdge?.belief_evidence_support).toBeCloseTo(0.5, 10);
      // NULL, never 0: this edge is evidence that has not been graded yet.
      expect(ungradedEvidenceEdge?.belief_evidence_contribution).toBeNull();

      const gradedEvidenceEdge = structured.edges.find(edge => edge.id === 13);
      expect(gradedEvidenceEdge?.belief_evidence_support).toBeCloseTo(0.75, 10);
      expect(gradedEvidenceEdge?.belief_evidence_contribution).toBeCloseTo(0.6, 10);
    });
  });

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

  // The out_of side must be reachable too — under canon (spec §8) it is the
  // side carrying a node's own evidence basis.
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
  // graph. (Canon note, spec §8: a node's evidence basis is its OUTGOING
  // support-bearing edges — the 'out_of' side.)
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
  // advertised schemas, so direction and offset must be on the input schema
  // and both belief columns on the output schema. The SDK also validates
  // structuredContent against the output schema, so the two must be in step
  // for the read above to be usable at all.
  it('advertises direction and offset on the input schema and both belief columns on the output schema', async () => {
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

      const outputSchemaJson = JSON.stringify(queryEdgesTool?.outputSchema);
      expect(outputSchemaJson).toContain('belief_evidence_support');
      expect(outputSchemaJson).toContain('belief_evidence_contribution');
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
