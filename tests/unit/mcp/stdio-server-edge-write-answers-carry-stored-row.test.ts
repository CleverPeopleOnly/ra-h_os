/**
 * FAILING-FIRST tests for the LOCAL app-backed MCP door's edge-write ANSWERS
 * (apps/mcp-server/stdio-server.js): rah_create_edge and rah_update_edge must
 * answer with the FULL STORED EDGE ROW, not just success + prose — the same
 * shape the remote door is gaining in this slice (see
 * tests/unit/mcp/remote-mcp-route-edge-write-answers-carry-stored-row.test.ts,
 * whose header carries the full why; this door mirrors the remote door's
 * handlers line for line, including the same three lies: the discarded row,
 * the `edgeId: 0` on the duplicate path, and the prose-only update answer).
 *
 * The pinned shape is identical to the remote door's: the structured answer
 * keeps success, edgeId (the REAL id) and message, and gains
 *  - `edge`: the stored row as the app's REST layer returned it — at minimum
 *    id, from_node_id, to_node_id, explanation — in the FINAL stored
 *    orientation (the classifier may have swapped the caller's ends), and
 *  - `already_existed`: an explicit boolean on the duplicate path.
 * Cross-door agreement is pinned in
 * tests/unit/mcp/mcp-doors-agree-on-edge-write-answer-row.test.ts.
 *
 * Seam (same as tests/unit/mcp/stdio-server-update-edge-support.test.ts): the
 * spawned proxy is pointed at a local in-process HTTP stub via
 * RAH_MCP_TARGET_URL. Each stub reply restates the REAL REST answer for its
 * scenario: the 201 create shape is live today, the swap shape is pinned green
 * in tests/unit/belief/edgeSwapCollisionPin.test.ts, and the honest duplicate
 * shape (existing row + already_existed) is pinned red at the REST seam in
 * tests/unit/api/edgesRouteDuplicateCreateAnswersExistingRow.test.ts. The
 * spawned proxy process is always terminated in the finally block of
 * withMcpClient, so no orphan survives a failure.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The structured answer shape this slice pins on both write tools; `edge` and
// `already_existed` are the fields current code lacks.
type EdgeWriteStructuredAnswer = {
  success: boolean;
  edgeId: number;
  message: string;
  already_existed?: boolean;
  edge?: {
    id: number;
    from_node_id: number;
    to_node_id: number;
    explanation: string | null;
  };
};

// The explanation a plain (non-swapping) create in this file sends.
const PLAIN_EDGE_EXPLANATION = 'Reports a measured result that bears on the neighbouring node.';

// The swap-inducing explanation: the "Contains…" prefix hits the deterministic
// heuristic classifier (part_of, swap_direction: true — no LLM), the same
// fixture prose as tests/unit/belief/edgeSwapCollisionPin.test.ts.
const SWAP_INDUCING_EXPLANATION = 'Contains the finding the derived claim rests on.';

// The stored row the app stub answers for the plain create (caller 2 → 1).
const PLAIN_CREATED_EDGE_ROW = {
  id: 91,
  from_node_id: 2,
  to_node_id: 1,
  explanation: PLAIN_EDGE_EXPLANATION,
  source: 'helper_name',
  created_at: '2026-08-13T00:00:00.000Z',
};

// The stored row for the swap scenario: written 5 → 7, stored 7 → 5.
const SWAPPED_CREATED_EDGE_ROW = {
  id: 92,
  from_node_id: 7,
  to_node_id: 5,
  explanation: SWAP_INDUCING_EXPLANATION,
  source: 'helper_name',
  created_at: '2026-08-13T00:00:00.000Z',
};

// The row of the edge that ALREADY occupies the 2 → 1 slot in the duplicate
// scenario; its explanation differs from the request's so an echo cannot pass
// as the stored row.
const ALREADY_EXISTING_EDGE_ROW = {
  id: 88,
  from_node_id: 2,
  to_node_id: 1,
  explanation: 'The stored reasoning recorded when this edge was first written.',
  source: 'helper_name',
  created_at: '2026-08-01T00:00:00.000Z',
};

// The edge id every update in this file corrects, and the row the app stub
// answers after the correction (the REST PUT already returns `data: edge`).
const UPDATED_EDGE_ID = 42;
const UPDATED_EDGE_ROW = {
  id: UPDATED_EDGE_ID,
  from_node_id: 9,
  to_node_id: 4,
  explanation: 'The corrected reasoning for why the connection exists.',
  source: 'helper_name',
  created_at: '2026-08-02T00:00:00.000Z',
};

// What the stub answers one request with; status defaults to 200.
type ApiStubReply = { status?: number; payload: unknown };

// Decides the stub's answer for one request; undefined answers 404 so an
// unstubbed call fails loudly. Installed per test.
let apiStubResponder: (method: string, pathname: string) => ApiStubReply | undefined = () =>
  undefined;

// The in-process HTTP stub standing in for the running RA-H app.
let apiStubServer: http.Server;
// Base URL the spawned proxy is pointed at via RAH_MCP_TARGET_URL.
let apiStubBaseUrl = '';

// Drain a request's body (the proxy sends JSON bodies; nothing in this file
// asserts on them, but an undrained body can stall the socket).
async function drainRequestBody(req: http.IncomingMessage): Promise<void> {
  for await (const chunk of req) {
    void chunk;
  }
}

// Answer one stub request from the installed responder.
async function handleApiStubRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', apiStubBaseUrl);
  const method = req.method || 'GET';
  await drainRequestBody(req);

  const reply = apiStubResponder(method, url.pathname);
  if (reply) {
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.payload));
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

  const client = new Client({ name: 'ra-h-stdio-edge-answer-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

// Extract a tool call's structured answer under the pinned shape.
function structuredAnswerOf(toolResult: unknown): EdgeWriteStructuredAnswer {
  return (toolResult as { structuredContent?: unknown })
    .structuredContent as EdgeWriteStructuredAnswer;
}

beforeAll(async () => {
  apiStubServer = http.createServer((req, res) => {
    void handleApiStubRequest(req, res);
  });
  await new Promise<void>((resolve) => {
    apiStubServer.listen(0, '127.0.0.1', () => resolve());
  });
  apiStubBaseUrl = `http://127.0.0.1:${(apiStubServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    apiStubServer.close((error) => (error ? reject(error) : resolve()));
  });
});

// Each test installs its own stub behaviour; start every test unstubbed.
beforeEach(() => {
  apiStubResponder = () => undefined;
});

describe('local stdio door rah_create_edge answers carry the stored row', () => {
  // The headline: a successful create must hand back the row the store wrote.
  // The stub answers the REST 201 shape live today; the only thing under test
  // is whether this door RELAYS it.
  it('a successful create answers the stored edge row alongside success, the real edgeId and message', async () => {
    apiStubResponder = (method, pathname) => {
      if (method === 'POST' && pathname === '/api/edges') {
        return {
          status: 201,
          payload: {
            success: true,
            data: PLAIN_CREATED_EDGE_ROW,
            message: 'Edge created successfully between nodes 2 and 1',
          },
        };
      }
      return undefined;
    };

    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: PLAIN_EDGE_EXPLANATION,
          confirmed_by_user: true,
        },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const structuredAnswer = structuredAnswerOf(toolResult);
      // The existing fields stay, with the REAL id.
      expect(structuredAnswer.success).toBe(true);
      expect(structuredAnswer.edgeId).toBe(PLAIN_CREATED_EDGE_ROW.id);
      expect(typeof structuredAnswer.message).toBe('string');
      // The new field: the stored row, as the app's REST layer returned it.
      expect(
        structuredAnswer.edge,
        'the create answer must carry the stored edge row under `edge`'
      ).toBeDefined();
      expect(structuredAnswer.edge).toMatchObject({
        id: PLAIN_CREATED_EDGE_ROW.id,
        from_node_id: PLAIN_CREATED_EDGE_ROW.from_node_id,
        to_node_id: PLAIN_CREATED_EDGE_ROW.to_node_id,
        explanation: PLAIN_CREATED_EDGE_ROW.explanation,
      });
      // A fresh create is not an already-existed answer.
      expect(Boolean(structuredAnswer.already_existed)).toBe(false);
    });
  }, 30000);

  // When the classifier swaps the ends, the answer must show the SWAPPED
  // stored ends, not the caller's input. The stub answers what
  // edgeSwapCollisionPin.test.ts pins the REST layer answering.
  it('a create the classifier re-oriented answers the SWAPPED stored ends, not the caller input', async () => {
    apiStubResponder = (method, pathname) => {
      if (method === 'POST' && pathname === '/api/edges') {
        return {
          status: 201,
          payload: {
            success: true,
            data: SWAPPED_CREATED_EDGE_ROW,
            message: 'Edge created successfully between nodes 7 and 5',
          },
        };
      }
      return undefined;
    };

    await withMcpClient(async (client) => {
      // Written 5 → 7; stored (and answered by the app) as 7 → 5.
      const toolResult = await client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 5,
          targetId: 7,
          explanation: SWAP_INDUCING_EXPLANATION,
          confirmed_by_user: true,
        },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const structuredAnswer = structuredAnswerOf(toolResult);
      expect(
        structuredAnswer.edge,
        'the create answer must carry the stored edge row under `edge`'
      ).toBeDefined();
      // The stored orientation — the REVERSE of the caller's input.
      expect(structuredAnswer.edge?.from_node_id).toBe(SWAPPED_CREATED_EDGE_ROW.from_node_id);
      expect(structuredAnswer.edge?.to_node_id).toBe(SWAPPED_CREATED_EDGE_ROW.to_node_id);
      expect(structuredAnswer.edgeId).toBe(SWAPPED_CREATED_EDGE_ROW.id);
    });
  }, 30000);

  // The duplicate path must answer honestly: still success, but with the
  // explicit already-existed indication and the EXISTING edge's row — its
  // real id, never 0. The stub answers the honest REST duplicate shape this
  // slice introduces at the REST seam.
  it('a duplicate create answers the EXISTING edge row with already_existed and its real id, never 0', async () => {
    apiStubResponder = (method, pathname) => {
      if (method === 'POST' && pathname === '/api/edges') {
        return {
          status: 200,
          payload: {
            success: true,
            already_existed: true,
            data: ALREADY_EXISTING_EDGE_ROW,
            message: 'Edge already exists between nodes 2 and 1',
          },
        };
      }
      return undefined;
    };

    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_create_edge',
        arguments: {
          sourceId: 2,
          targetId: 1,
          explanation: PLAIN_EDGE_EXPLANATION,
          confirmed_by_user: true,
        },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const structuredAnswer = structuredAnswerOf(toolResult);
      // Unchanged semantics: the duplicate is still a success answer.
      expect(structuredAnswer.success).toBe(true);
      // The explicit indication, relayed structurally, never parsed from prose.
      expect(
        structuredAnswer.already_existed,
        'a duplicate create must answer already_existed: true'
      ).toBe(true);
      // The honest id: the EXISTING edge's, never the 0 this door invents
      // today when the app answer's row is missing an id.
      expect(structuredAnswer.edgeId).toBe(ALREADY_EXISTING_EDGE_ROW.id);
      expect(structuredAnswer.edgeId).not.toBe(0);
      // The existing edge's row — stored orientation and stored prose.
      expect(
        structuredAnswer.edge,
        'a duplicate create must carry the EXISTING edge row under `edge`'
      ).toBeDefined();
      expect(structuredAnswer.edge).toMatchObject({
        id: ALREADY_EXISTING_EDGE_ROW.id,
        from_node_id: ALREADY_EXISTING_EDGE_ROW.from_node_id,
        to_node_id: ALREADY_EXISTING_EDGE_ROW.to_node_id,
        explanation: ALREADY_EXISTING_EDGE_ROW.explanation,
      });
    });
  }, 30000);
});

describe('local stdio door rah_update_edge answers carry the updated stored row', () => {
  // The update answer is prose-only today, even though the REST PUT already
  // returns `data: edge`. It must answer the same shape as create.
  it('an update answers the updated stored edge row in the same shape as create', async () => {
    apiStubResponder = (method, pathname) => {
      if (method === 'PUT' && pathname === `/api/edges/${UPDATED_EDGE_ID}`) {
        return {
          payload: {
            success: true,
            data: UPDATED_EDGE_ROW,
            message: 'Edge updated successfully',
          },
        };
      }
      return undefined;
    };

    await withMcpClient(async (client) => {
      const toolResult = await client.callTool({
        name: 'rah_update_edge',
        arguments: {
          id: UPDATED_EDGE_ID,
          explanation: UPDATED_EDGE_ROW.explanation,
          confirmed_by_user: true,
        },
      });

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const structuredAnswer = structuredAnswerOf(toolResult);
      expect(structuredAnswer.success).toBe(true);
      // Same shape as create's answer: the id rides as edgeId…
      expect(
        structuredAnswer.edgeId,
        'the update answer must name the updated edge id as edgeId'
      ).toBe(UPDATED_EDGE_ID);
      expect(typeof structuredAnswer.message).toBe('string');
      // …and the updated stored row rides as `edge`.
      expect(
        structuredAnswer.edge,
        'the update answer must carry the updated stored row under `edge`'
      ).toBeDefined();
      expect(structuredAnswer.edge).toMatchObject({
        id: UPDATED_EDGE_ROW.id,
        from_node_id: UPDATED_EDGE_ROW.from_node_id,
        to_node_id: UPDATED_EDGE_ROW.to_node_id,
        explanation: UPDATED_EDGE_ROW.explanation,
      });
    });
  }, 30000);
});

describe('local stdio door edge-write output schemas advertise the stored row', () => {
  // Discoverability: this door declares output schemas today (unlike the
  // remote door before this slice), but they stop at success/edgeId/message —
  // the row must be declared for an agent to learn the answer carries it.
  it('rah_create_edge and rah_update_edge declare the stored row fields on their output schemas', async () => {
    await withMcpClient(async (client) => {
      const listedTools = await client.listTools();

      for (const writeToolName of ['rah_create_edge', 'rah_update_edge']) {
        // The advertised tool under inspection.
        const advertisedTool = listedTools.tools.find((tool) => tool.name === writeToolName);
        expect(advertisedTool, `the local door must advertise ${writeToolName}`).toBeDefined();

        // The whole output schema as text: the row's field names must appear
        // somewhere on it.
        const outputSchemaJson = JSON.stringify(advertisedTool?.outputSchema ?? {});
        for (const storedRowFieldName of ['from_node_id', 'to_node_id', 'explanation']) {
          expect(
            outputSchemaJson,
            `${writeToolName} must declare ${storedRowFieldName} on its output schema`
          ).toContain(storedRowFieldName);
        }
        // The update tool must also finally declare the id it answers.
        expect(
          outputSchemaJson,
          `${writeToolName} must declare edgeId on its output schema`
        ).toContain('edgeId');
      }
    });
  }, 30000);
});
