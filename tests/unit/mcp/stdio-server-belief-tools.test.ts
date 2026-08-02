/**
 * Tests for the three NEW belief tools on the LOCAL MCP door
 * (apps/mcp-server/stdio-server.js):
 *
 *  - rah_set_belief_fixed_credence — assert one node's credence by hand,
 *  - rah_get_belief_movements — read the log of a node's credence changing,
 *  - rah_recompute_node_belief — ask the app's belief engine to regrade one
 *    node.
 *
 * This is the local-door twin of
 * tests/unit/mcp/remote-mcp-route-belief-tools.test.ts, same fixtures and the
 * same contract: validate at the schema, forward to the app's belief
 * endpoints (POST /api/belief/fixed-credence, GET /api/belief/movements,
 * POST /api/belief/recompute — pinned behaviourally in tests/unit/api/), and
 * pass the app's answer through. Both doors take the schemas from the shared
 * contract (src/services/belief/beliefMcpToolContract.js); the structural
 * agreement is pinned in
 * tests/unit/mcp/mcp-doors-agree-on-belief-tool-surface.test.ts. The
 * STANDALONE door is not in scope: it never grades, and its own
 * setBeliefFixedCredence is only the semantics reference.
 *
 * Seam (same as tests/unit/mcp/stdio-server-evidence.test.ts): the spawned
 * proxy is pointed at a local in-process HTTP stub via RAH_MCP_TARGET_URL;
 * the stub records every request so forwarding can be asserted. The spawned
 * proxy process is always terminated in the finally block of withMcpClient,
 * so no orphan survives a failure.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// One request the app stub received from the spawned proxy.
interface RecordedBeliefAppRequest {
  method: string;
  pathname: string;
  searchParams: Record<string, string>;
  body: Record<string, unknown> | null;
}

// The node every happy-path call in this file works on.
const ASSERTED_NODE_ID = 9;
// A node id the stubbed app has never heard of, for the refusal paths.
const UNKNOWN_NODE_ID = 424242;
// A node whose movement log is empty, for the quiet-success path.
const QUIET_NODE_ID = 10;
// A node whose recompute lands on "ungraded" (null credence).
const EVIDENCELESS_NODE_ID = 11;
// The timestamp the stubbed app stamps on every fixed-credence assertion.
const STUBBED_BELIEF_COMPUTED_AT = '2026-07-30T10:00:00.000Z';
// The credence the stubbed app answers for a graded recompute.
const STUBBED_RECOMPUTED_CREDENCE = 0.44;

// The movement log the stubbed app serves for ASSERTED_NODE_ID — already
// newest first, exactly as the app route answers it.
const stubbedMovementLogNewestFirst = [
  {
    id: 33,
    node_id: ASSERTED_NODE_ID,
    from_credence: 0.6,
    to_credence: 0.4,
    trigger: 'belief-fixed-credence-set',
    occurred_at: '2026-07-03T10:00:00.000Z',
  },
  {
    id: 32,
    node_id: ASSERTED_NODE_ID,
    from_credence: 0.3,
    to_credence: 0.6,
    trigger: 'belief-recompute',
    occurred_at: '2026-07-02T10:00:00.000Z',
  },
  {
    id: 31,
    node_id: ASSERTED_NODE_ID,
    from_credence: null,
    to_credence: 0.3,
    trigger: 'belief-recompute',
    occurred_at: '2026-07-01T10:00:00.000Z',
  },
];

// Every request the stub has received in the current test.
let recordedBeliefAppRequests: RecordedBeliefAppRequest[] = [];
// The in-process HTTP stub standing in for the running RA-H app.
let apiStubServer: http.Server;
// Base URL the spawned proxy is pointed at via RAH_MCP_TARGET_URL.
let apiStubBaseUrl = '';

// Collect and parse a JSON request body from an incoming stub request.
async function readJsonRequestBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString('utf8');
  return rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
}

// Answer one stub request with a JSON payload.
function answerWithJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// Record the request, then serve the three belief endpoints from the same
// fixtures the remote-door twin uses.
async function handleApiStubRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', apiStubBaseUrl);
  const method = req.method || 'GET';
  const body = method === 'POST' || method === 'PUT' ? await readJsonRequestBody(req) : null;
  recordedBeliefAppRequests.push({
    method,
    pathname: url.pathname,
    searchParams: Object.fromEntries(url.searchParams.entries()),
    body,
  });

  if (method === 'POST' && url.pathname === '/api/belief/fixed-credence') {
    const assertedNodeId = body?.node_id as number;
    const assertedBeliefCredence = body?.belief_credence as number;
    if (assertedNodeId === UNKNOWN_NODE_ID) {
      answerWithJson(res, 404, {
        success: false,
        error: `Cannot assert a credence about node #${UNKNOWN_NODE_ID}: no such node.`,
      });
      return;
    }
    answerWithJson(res, 200, {
      success: true,
      node_id: assertedNodeId,
      belief_credence: assertedBeliefCredence,
      belief_credence_is_fixed: 1,
      belief_computed_at: STUBBED_BELIEF_COMPUTED_AT,
      message: `Asserted belief_credence ${assertedBeliefCredence} on node #${assertedNodeId}.`,
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/belief/movements') {
    const requestedNodeId = Number(url.searchParams.get('node_id'));
    if (requestedNodeId === QUIET_NODE_ID) {
      answerWithJson(res, 200, { success: true, count: 0, movements: [] });
      return;
    }
    // Serve the fixture log, honouring a forwarded limit.
    const requestedLimit = url.searchParams.get('limit')
      ? Number(url.searchParams.get('limit'))
      : stubbedMovementLogNewestFirst.length;
    const servedMovements = stubbedMovementLogNewestFirst.slice(0, requestedLimit);
    answerWithJson(res, 200, {
      success: true,
      count: servedMovements.length,
      movements: servedMovements,
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/belief/recompute') {
    const recomputedNodeId = body?.node_id as number;
    if (recomputedNodeId === UNKNOWN_NODE_ID) {
      answerWithJson(res, 404, {
        success: false,
        error: `Cannot recompute belief for node #${UNKNOWN_NODE_ID}: no such node.`,
      });
      return;
    }
    if (recomputedNodeId === EVIDENCELESS_NODE_ID) {
      answerWithJson(res, 200, {
        success: true,
        node_id: recomputedNodeId,
        belief_credence: null,
        message: `Node #${recomputedNodeId} has no counted evidence and stays ungraded.`,
      });
      return;
    }
    answerWithJson(res, 200, {
      success: true,
      node_id: recomputedNodeId,
      belief_credence: STUBBED_RECOMPUTED_CREDENCE,
      message: `Recomputed belief for node #${recomputedNodeId}.`,
    });
    return;
  }

  answerWithJson(res, 404, {
    success: false,
    error: `Unhandled stub route: ${method} ${url.pathname}`,
  });
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

  const client = new Client({ name: 'ra-h-stdio-belief-tools-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// Find the requests the stub received for one belief endpoint.
function findRecordedBeliefRequests(method: string, pathname: string) {
  return recordedBeliefAppRequests.filter(
    (entry) => entry.method === method && entry.pathname === pathname
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
  recordedBeliefAppRequests = [];
});

describe('app-MCP proxy rah_set_belief_fixed_credence', () => {
  // The whole path: schema in, forwarded body, and the standalone-shaped
  // reply back out through structuredContent.
  it('forwards the assertion to the app and reports the standalone-shaped reply', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_set_belief_fixed_credence',
        arguments: { node_id: ASSERTED_NODE_ID, belief_credence: 0.7 },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const [forwardedAssertion] = findRecordedBeliefRequests('POST', '/api/belief/fixed-credence');
      expect(forwardedAssertion, 'the proxy should have POSTed to /api/belief/fixed-credence').toBeDefined();
      expect(forwardedAssertion.body).toMatchObject({
        node_id: ASSERTED_NODE_ID,
        belief_credence: 0.7,
      });
      expect(toolResult.structuredContent).toMatchObject({
        success: true,
        node_id: ASSERTED_NODE_ID,
        belief_credence: 0.7,
        belief_credence_is_fixed: 1,
        belief_computed_at: STUBBED_BELIEF_COMPUTED_AT,
      });
    });
  });

  // 0 is assessed-and-torn — a legitimate assertion that must forward
  // verbatim, never be dropped as falsy.
  it('accepts a credence of exactly 0 and forwards it verbatim', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_set_belief_fixed_credence',
        arguments: { node_id: ASSERTED_NODE_ID, belief_credence: 0 },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const [forwardedAssertion] = findRecordedBeliefRequests('POST', '/api/belief/fixed-credence');
      expect(Object.keys(forwardedAssertion?.body ?? {})).toContain('belief_credence');
      expect(forwardedAssertion?.body?.belief_credence).toBe(0);
    });
  });

  // The interval is OPEN: ±1 is refused at the schema, so no request ever
  // reaches the app.
  it('rejects a credence at or beyond plus/minus 1 and sends no request to the app', async () => {
    await withMcpClient(async (client) => {
      // Guard against a vacuous pass: an UNKNOWN tool also errors without a
      // request, so the refusal only means anything once the tool exists.
      const listedToolNames = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listedToolNames).toContain('rah_set_belief_fixed_credence');

      for (const rejectedCredence of [1, -1, 1.5, -2]) {
        const toolResult = await client.callTool({
          name: 'rah_set_belief_fixed_credence',
          arguments: { node_id: ASSERTED_NODE_ID, belief_credence: rejectedCredence },
        });

        expect(
          (toolResult as { isError?: boolean }).isError,
          `a credence of ${rejectedCredence} must be rejected — the interval is open`
        ).toBe(true);
      }
      expect(findRecordedBeliefRequests('POST', '/api/belief/fixed-credence')).toHaveLength(0);
    });
  });

  // The app's refusal for a node that does not exist surfaces as a tool
  // error naming the node.
  it('refuses an unknown node with an error naming it', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_set_belief_fixed_credence',
        arguments: { node_id: UNKNOWN_NODE_ID, belief_credence: 0.5 },
      });

      expect((toolResult as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(toolResult.content)).toContain(String(UNKNOWN_NODE_ID));
    });
  });
});

describe('app-MCP proxy rah_get_belief_movements', () => {
  // The read path: node_id rides the query string, and the app's
  // newest-first order passes through the proxy untouched.
  it('forwards node_id and reports the movement log newest first under the exact column names', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_get_belief_movements',
        arguments: { node_id: ASSERTED_NODE_ID },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const [forwardedMovementsRead] = findRecordedBeliefRequests('GET', '/api/belief/movements');
      expect(forwardedMovementsRead, 'the proxy should have GET /api/belief/movements').toBeDefined();
      expect(forwardedMovementsRead.searchParams.node_id).toBe(String(ASSERTED_NODE_ID));

      const movementsReadReply = (toolResult as { structuredContent?: unknown })
        .structuredContent as { count: number; movements: Array<Record<string, unknown>> };
      expect(movementsReadReply.count).toBe(3);
      expect(movementsReadReply.movements.map((movement) => movement.id)).toEqual([33, 32, 31]);
      expect(movementsReadReply.movements[0]).toEqual(stubbedMovementLogNewestFirst[0]);
      // The oldest movement's null from_credence (previously ungraded)
      // survives as null, never 0.
      expect(movementsReadReply.movements[2].from_credence).toBeNull();
    });
  });

  // A quiet node is a success, not an error.
  it('reports an empty log as a success with count 0', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_get_belief_movements',
        arguments: { node_id: QUIET_NODE_ID },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      expect(toolResult.structuredContent).toMatchObject({ count: 0, movements: [] });
    });
  });

  // An impossible page is refused at the schema; the app never hears of it.
  it('rejects a limit of 0 or over 100 and sends no request to the app', async () => {
    await withMcpClient(async (client) => {
      // Guard against a vacuous pass: an UNKNOWN tool also errors without a
      // request, so the refusal only means anything once the tool exists.
      const listedToolNames = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listedToolNames).toContain('rah_get_belief_movements');

      for (const rejectedLimit of [0, 101]) {
        const toolResult = await client.callTool({
          name: 'rah_get_belief_movements',
          arguments: { node_id: ASSERTED_NODE_ID, limit: rejectedLimit },
        });

        expect(
          (toolResult as { isError?: boolean }).isError,
          `a limit of ${rejectedLimit} must be rejected`
        ).toBe(true);
      }
      expect(findRecordedBeliefRequests('GET', '/api/belief/movements')).toHaveLength(0);
    });
  });
});

describe('app-MCP proxy rah_recompute_node_belief', () => {
  // The regrade path: node_id rides the POST body, and the app's graded
  // answer passes through.
  it('forwards the recompute to the app and reports the regraded credence', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_recompute_node_belief',
        arguments: { node_id: ASSERTED_NODE_ID },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const [forwardedRecompute] = findRecordedBeliefRequests('POST', '/api/belief/recompute');
      expect(forwardedRecompute, 'the proxy should have POSTed to /api/belief/recompute').toBeDefined();
      expect(forwardedRecompute.body).toMatchObject({ node_id: ASSERTED_NODE_ID });
      expect(toolResult.structuredContent).toMatchObject({
        success: true,
        node_id: ASSERTED_NODE_ID,
        belief_credence: STUBBED_RECOMPUTED_CREDENCE,
      });
    });
  });

  // Ungraded is a real answer: null credence, success, never 0.
  it('reports a null credence as a successful ungraded answer, never 0 and never an error', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_recompute_node_belief',
        arguments: { node_id: EVIDENCELESS_NODE_ID },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const recomputeReply = (toolResult as { structuredContent?: unknown })
        .structuredContent as { success: boolean; belief_credence: number | null };
      expect(recomputeReply.success).toBe(true);
      expect(recomputeReply.belief_credence).toBeNull();
      expect(recomputeReply.belief_credence).not.toBe(0);
    });
  });

  // A typo'd node id is an error, not an ungraded node.
  it('refuses an unknown node with an error naming it', async () => {
    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_recompute_node_belief',
        arguments: { node_id: UNKNOWN_NODE_ID },
      });

      expect((toolResult as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(toolResult.content)).toContain(String(UNKNOWN_NODE_ID));
    });
  });
});

describe('app-MCP proxy advertises the new belief tools', () => {
  // Discoverability: each new tool is listed with an input schema AND an
  // output schema, so an external agent can learn the whole contract.
  it('lists all three belief tools with input and output schemas', async () => {
    await withMcpClient(async (client) => {
      const listedTools = await client.listTools();

      for (const beliefToolName of [
        'rah_set_belief_fixed_credence',
        'rah_get_belief_movements',
        'rah_recompute_node_belief',
      ]) {
        const advertisedBeliefTool = listedTools.tools.find(
          (tool) => tool.name === beliefToolName
        );
        expect(advertisedBeliefTool, `the proxy must advertise ${beliefToolName}`).toBeDefined();
        expect(
          advertisedBeliefTool?.inputSchema,
          `${beliefToolName} must declare an input schema`
        ).toBeDefined();
        expect(
          advertisedBeliefTool?.outputSchema,
          `${beliefToolName} must declare an output schema`
        ).toBeDefined();
      }
    });
  });
});
