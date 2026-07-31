/**
 * Correcting ONLY an edge's support through the LOCAL MCP door
 * (apps/mcp-server/stdio-server.js, tool rah_update_edge).
 *
 * WHY THIS FILE EXISTS. rah_update_edge requires a non-empty `explanation` on
 * every write, and there is no read-one-edge-by-id tool to fetch the stored one
 * and hand it straight back. The explanation is the recorded human reasoning
 * for why the connection exists; a correction to how strongly the source talks
 * about its neighbour is not an occasion to rewrite it. So today a caller who
 * only wants to fix a support must either invent prose over the words already
 * there or give up. Both are wrong answers.
 *
 * Two things have to be true for a support-only correction to survive the trip:
 *
 *  - `explanation` must be OPTIONAL on this tool, and
 *  - when it is absent the door must send NO `context` key at all. This is
 *    load-bearing rather than tidy: PUT /api/edges/[id] spreads the body into
 *    the update payload and edgeService.updateEdge writes `context` WHOLESALE,
 *    so a body carrying `context: { created_via: 'mcp' }` with no explanation
 *    inside it would overwrite the stored context and destroy the very
 *    explanation this change exists to protect.
 *
 * With the context gone, `created_via` has to travel TOP-LEVEL instead — and it
 * must still travel. The route derives created_via from the body and DEFAULTS
 * IT TO 'ui' when it finds none, and the confirmation gate only fires for
 * agent/mcp/workflow. A door that simply dropped created_via to dodge the
 * context problem would route every MCP support write down the unguarded 'ui'
 * path, so confirmed_by_user would stop being enforced app-side altogether.
 *
 * UN-ASSESSMENT rides the same path: `belief_evidence_support: null` returns a
 * graded evidence edge to a plain relationship, and the door must forward the
 * key present AND null — a dropped key reads as "no support supplied" and
 * leaves the edge graded exactly as it was.
 *
 * Seam (same as tests/unit/mcp/stdio-server-update-edge-support.test.ts): the
 * spawned door is pointed at a local in-process HTTP stub via
 * RAH_MCP_TARGET_URL and the stub records every request body. No real app and
 * no database is involved. The spawned process is always terminated in the
 * finally block of withLocalMcpDoorClient, so no orphan survives a failure.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The edge id every correction in this file is aimed at.
const CORRECTED_EDGE_ID = 31;

// The explanation the stored edge already carries — the words a support-only
// correction must leave alone. Only the tests that deliberately edit the
// explanation ever send it.
const STORED_EDGE_EXPLANATION =
  'The source node reports a measured result bearing on the target node.';

// One recorded request the HTTP stub received from the door under test.
type RecordedApiRequest = {
  method: string;
  pathname: string;
  body: Record<string, unknown> | null;
};

// The in-process HTTP stub standing in for the running RA-H app.
let apiStubServer: http.Server;
// Base URL the spawned door is pointed at via RAH_MCP_TARGET_URL.
let apiStubBaseUrl = '';
// Every request the stub received, in arrival order.
let recordedApiRequests: RecordedApiRequest[] = [];

// Collect and parse a JSON request body from an incoming stub request.
async function readJsonRequestBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

// Record every request, and answer PUT /api/edges/<id> with a successful update
// so an accepted tool call completes and the assertions can be about the body.
async function handleApiStubRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', apiStubBaseUrl);
  const method = req.method || 'GET';
  const body = method === 'POST' || method === 'PUT' ? await readJsonRequestBody(req) : null;

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

// Spawn the local door against the stub, run the callback with a connected MCP
// client, then ALWAYS close the transport (terminating the door process).
async function withLocalMcpDoorClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
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

  const client = new Client({
    name: 'ra-h-stdio-support-only-correction-test',
    version: '1.0.0',
  });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// Call rah_update_edge with exactly the arguments given — no explanation is
// added for the caller, because absence of the explanation is the thing under
// test here.
async function callUpdateEdgeTool(
  client: Client,
  updateEdgeArguments: Record<string, unknown>
): Promise<{ isError?: boolean }> {
  return (await client.callTool({
    name: 'rah_update_edge',
    arguments: { id: CORRECTED_EDGE_ID, ...updateEdgeArguments },
  })) as { isError?: boolean };
}

// The (single) PUT /api/edges/<id> request the stub recorded, if any.
function findRecordedUpdateEdgeRequest(): RecordedApiRequest | undefined {
  return recordedApiRequests.find(
    (entry) => entry.method === 'PUT' && entry.pathname === `/api/edges/${CORRECTED_EDGE_ID}`
  );
}

// How many update requests reached the app — 0 is what a refused correction
// must produce.
function countRecordedUpdateEdgeRequests(): number {
  return recordedApiRequests.filter(
    (entry) => entry.method === 'PUT' && entry.pathname === `/api/edges/${CORRECTED_EDGE_ID}`
  ).length;
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

describe('local MCP door rah_update_edge corrects support without an explanation', () => {
  // The headline: a support correction must be expressible at all. Today the
  // schema refuses the call outright, so the only way to fix a mis-graded
  // support is to rewrite the human reasoning stored beside it.
  it('accepts a support-only correction and forwards the corrected support', async () => {
    await withLocalMcpDoorClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        belief_evidence_support: 0.4,
      });

      expect(
        updateEdgeToolResult.isError ?? false,
        'a support-only correction must be accepted without an explanation'
      ).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(updateEdgeRequest, 'the door should have PUT to /api/edges/<id>').toBeDefined();
      expect(updateEdgeRequest?.body?.belief_evidence_support).toBeCloseTo(0.4, 10);
    });
  });

  // The destructive case this whole change is guarding against: the app writes
  // `context` wholesale, so a context sent without an explanation inside it
  // would overwrite the stored one and delete the recorded reasoning.
  it('sends no context key at all when no explanation is supplied', async () => {
    await withLocalMcpDoorClient(async (client) => {
      await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        belief_evidence_support: 0.4,
      });

      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      // Asserted first so this test cannot pass merely because the door
      // refused the call and sent nothing at all.
      expect(updateEdgeRequest, 'the door should have PUT to /api/edges/<id>').toBeDefined();
      expect(
        Object.keys(updateEdgeRequest?.body ?? {}),
        'a context key with no explanation inside it would wipe the stored explanation'
      ).not.toContain('context');
    });
  });

  // Without created_via the route defaults it to 'ui', and the 'ui' path skips
  // the confirmation gate entirely — so dropping created_via to avoid sending a
  // context would silently disarm app-side confirmation for every MCP support
  // write. It must ride top-level instead, alongside the confirmation flag.
  it('still identifies itself as an mcp write and carries the confirmation flag', async () => {
    await withLocalMcpDoorClient(async (client) => {
      await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        belief_evidence_support: 0.4,
      });

      expect(findRecordedUpdateEdgeRequest()?.body).toMatchObject({
        created_via: 'mcp',
        confirmed_by_user: true,
      });
    });
  });

  // Un-assessment is the write the nullable schema exists for: it returns a
  // graded evidence edge to a plain relationship, clears the edge's
  // contribution and regrades the target. A dropped key would leave the edge
  // graded, which is indistinguishable from the correction never happening.
  it('forwards an un-assessment as a present-and-null support with no context', async () => {
    await withLocalMcpDoorClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        belief_evidence_support: null,
      });

      expect(
        updateEdgeToolResult.isError ?? false,
        'an un-assessment must be accepted without an explanation'
      ).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(Object.keys(updateEdgeRequest?.body ?? {})).toContain('belief_evidence_support');
      expect(updateEdgeRequest?.body?.belief_evidence_support).toBeNull();
      expect(Object.keys(updateEdgeRequest?.body ?? {})).not.toContain('context');
    });
  });

  // An un-assessment is still a write, so it must not become a way around the
  // confirmation gate — and a support-only body is exactly the shape that would
  // slip past an app-side check keyed on the explanation instead.
  it('refuses an unconfirmed support-only correction and sends no request to the app', async () => {
    await withLocalMcpDoorClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: false,
        belief_evidence_support: 0.4,
      });

      expect(
        updateEdgeToolResult.isError,
        'an unconfirmed support-only correction must be refused'
      ).toBe(true);
      expect(countRecordedUpdateEdgeRequests()).toBe(0);
    });
  });

  // Optionality must apply to the explanation ONLY as absence. A present but
  // blank explanation is a caller trying to write nothing over the stored
  // reasoning, which is the same destruction by a different route.
  it('refuses a whitespace-only explanation and sends no request to the app', async () => {
    await withLocalMcpDoorClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        explanation: '   ',
        belief_evidence_support: 0.4,
      });

      expect(
        updateEdgeToolResult.isError,
        'a blank explanation must be refused, not treated as an omitted one'
      ).toBe(true);
      expect(countRecordedUpdateEdgeRequests()).toBe(0);
    });
  });

  // GUARD: the empty string was already refused by the min(1) schema and must
  // stay refused once the field becomes optional.
  it('GUARD: refuses an empty-string explanation and sends no request to the app', async () => {
    await withLocalMcpDoorClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        explanation: '',
        belief_evidence_support: 0.4,
      });

      expect(updateEdgeToolResult.isError).toBe(true);
      expect(countRecordedUpdateEdgeRequests()).toBe(0);
    });
  });

  // GUARD: the explanation-only correction is the tool's original job and must
  // not regress. It still travels inside context, and still invents no support
  // — a support key added here would turn a plain relationship into evidence.
  it('GUARD: an explanation-only correction still sends context and no support key', async () => {
    await withLocalMcpDoorClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        explanation: STORED_EDGE_EXPLANATION,
      });

      expect(updateEdgeToolResult.isError ?? false).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(updateEdgeRequest?.body).toMatchObject({
        context: { explanation: STORED_EDGE_EXPLANATION, created_via: 'mcp' },
        confirmed_by_user: true,
      });
      expect(Object.keys(updateEdgeRequest?.body ?? {})).not.toContain('belief_evidence_support');
    });
  });

  // GUARD: correcting both at once is still one write. Making the explanation
  // optional must not turn the two fields into alternatives.
  it('GUARD: an explanation and a support together are sent together', async () => {
    await withLocalMcpDoorClient(async (client) => {
      const updateEdgeToolResult = await callUpdateEdgeTool(client, {
        confirmed_by_user: true,
        explanation: STORED_EDGE_EXPLANATION,
        belief_evidence_support: 0.7,
      });

      expect(updateEdgeToolResult.isError ?? false).toBe(false);
      const updateEdgeRequest = findRecordedUpdateEdgeRequest();
      expect(updateEdgeRequest?.body).toMatchObject({
        context: { explanation: STORED_EDGE_EXPLANATION, created_via: 'mcp' },
        confirmed_by_user: true,
      });
      expect(updateEdgeRequest?.body?.belief_evidence_support).toBeCloseTo(0.7, 10);
    });
  });

  // Discoverability: an agent learns what it may omit from the advertised
  // schema alone. If explanation stays required there, no client will ever
  // attempt a support-only correction however permissive the handler becomes.
  it('advertises explanation as optional while id and confirmed_by_user stay required', async () => {
    await withLocalMcpDoorClient(async (client) => {
      const listedTools = await client.listTools();
      const updateEdgeTool = listedTools.tools.find((tool) => tool.name === 'rah_update_edge');
      expect(updateEdgeTool).toBeDefined();

      const requiredInputProperties =
        (updateEdgeTool?.inputSchema as { required?: string[] }).required ?? [];
      expect(
        requiredInputProperties,
        'explanation must not be required, or a support-only correction is undiscoverable'
      ).not.toContain('explanation');
      // The confirmation gate is untouched by this change and must stay visible.
      expect(requiredInputProperties).toContain('confirmed_by_user');
      expect(requiredInputProperties).toContain('id');
    });
  });

  // Discoverability for the un-assessment: an agent must be able to read off
  // the advertised schema that null is a legal support here.
  it('advertises a nullable belief_evidence_support on the update tool', async () => {
    await withLocalMcpDoorClient(async (client) => {
      const listedTools = await client.listTools();
      const updateEdgeTool = listedTools.tools.find((tool) => tool.name === 'rah_update_edge');

      const advertisedSupportSchema = (
        updateEdgeTool?.inputSchema as { properties?: Record<string, unknown> }
      ).properties?.belief_evidence_support;
      expect(advertisedSupportSchema).toBeDefined();
      expect(
        JSON.stringify(advertisedSupportSchema),
        'the advertised support schema must admit null'
      ).toContain('null');
    });
  });
});
