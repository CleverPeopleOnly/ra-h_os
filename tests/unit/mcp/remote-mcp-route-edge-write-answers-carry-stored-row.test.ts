/**
 * FAILING-FIRST tests for the REMOTE MCP door's edge-write ANSWERS
 * (app/api/mcp/route.ts): rah_create_edge and rah_update_edge must answer
 * with the FULL STORED EDGE ROW, not just success + prose.
 *
 * WHY. Today the door builds its create answer as roughly
 * `{ success: true, edgeId: edge?.id || 0, message }` and DISCARDS the row the
 * REST layer already returns (app/api/edges/route.ts answers `data: edge` on a
 * 201). Three lies follow:
 *  - the caller never learns the FINAL stored orientation — RA-H's classifier
 *    may swap from/to relative to the caller's input (the inference swap in
 *    src/services/database/edges.ts, pinned at the REST seam in
 *    tests/unit/belief/edgeSwapCollisionPin.test.ts), and the answer hides
 *    which way the edge actually landed;
 *  - the REST duplicate branch answers success with a message but NO id, so
 *    the door answers `edgeId: 0` — an id that names no edge;
 *  - rah_update_edge answers only success + prose, discarding the updated row
 *    the REST PUT already returns.
 *
 * The shape pinned here: the structured answer keeps its existing fields
 * (success, edgeId with the REAL id, message) and gains
 *  - `edge`: the stored row as the REST layer returned it — at minimum id,
 *    from_node_id, to_node_id, explanation — reflecting the FINAL stored
 *    orientation, and
 *  - `already_existed`: an explicit boolean indication on the duplicate path
 *    (true when the answer describes an edge that was already there).
 *
 * Seam: tests/unit/mcp/helpers/remoteMcpDoorHarness.ts — a real MCP client
 * over the real transport into the exported POST handler in process, with an
 * in-process stub standing in for the RA-H app. Each stub reply below restates
 * the REAL REST answer for its scenario: the 201 create shape is live today,
 * the swap shape is pinned green in edgeSwapCollisionPin.test.ts, and the
 * duplicate shape (existing row in `data`) is pinned red in
 * tests/unit/api/edgesRouteDuplicateCreateAnswersExistingRow.test.ts — the
 * REST half of this same slice.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live harness for this file.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;

// The structured answer shape this slice pins on both write tools. `edge` and
// `already_existed` are the fields current code lacks — their absence is what
// makes these tests fail today.
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

// The explanation a plain (non-swapping) create in this file sends; specific
// enough to pass the app's edge-explanation quality check.
const PLAIN_EDGE_EXPLANATION = 'Reports a measured result that bears on the neighbouring node.';

// The swap-inducing explanation: a "Contains…" prefix hits the deterministic
// heuristic classifier (part_of, swap_direction: true — no LLM), so the app
// stores the ends REVERSED relative to the caller's input. Same fixture prose
// as tests/unit/belief/edgeSwapCollisionPin.test.ts, where the REST layer's
// swapped 201 answer is pinned green.
const SWAP_INDUCING_EXPLANATION = 'Contains the finding the derived claim rests on.';

// The stored row the app answers for the plain create: same orientation the
// caller asked for (sourceId 2 → targetId 1), with the id the store assigned.
const PLAIN_CREATED_EDGE_ROW = {
  id: 91,
  from_node_id: 2,
  to_node_id: 1,
  explanation: PLAIN_EDGE_EXPLANATION,
  source: 'helper_name',
  created_at: '2026-08-13T00:00:00.000Z',
};

// The stored row the app answers for the swap scenario: the caller writes
// 5 → 7, the classifier re-orients, and the STORE holds 7 → 5. The door must
// report these stored ends, never echo the caller's input.
const SWAPPED_CREATED_EDGE_ROW = {
  id: 92,
  from_node_id: 7,
  to_node_id: 5,
  explanation: SWAP_INDUCING_EXPLANATION,
  source: 'helper_name',
  created_at: '2026-08-13T00:00:00.000Z',
};

// The row of the edge that ALREADY occupies the 2 → 1 slot in the duplicate
// scenario. Its explanation deliberately differs from the request's, so an
// answer echoing the request is distinguishable from one carrying the store.
const ALREADY_EXISTING_EDGE_ROW = {
  id: 88,
  from_node_id: 2,
  to_node_id: 1,
  explanation: 'The stored reasoning recorded when this edge was first written.',
  source: 'helper_name',
  created_at: '2026-08-01T00:00:00.000Z',
};

// The edge id every update in this file corrects, and the row the app answers
// after the correction (the REST PUT already returns `data: edge` today).
const UPDATED_EDGE_ID = 42;
const UPDATED_EDGE_ROW = {
  id: UPDATED_EDGE_ID,
  from_node_id: 9,
  to_node_id: 4,
  explanation: 'The corrected reasoning for why the connection exists.',
  source: 'helper_name',
  created_at: '2026-08-02T00:00:00.000Z',
};

// Ask the remote door to create an edge with the caller-chosen ends and prose.
async function callCreateEdgeTool(
  client: Client,
  callerEnds: { sourceId: number; targetId: number },
  explanation: string
) {
  return client.callTool({
    name: 'rah_create_edge',
    arguments: {
      ...callerEnds,
      explanation,
      confirmed_by_user: true,
    },
  });
}

// Ask the remote door to correct the edge this file updates.
async function callUpdateEdgeTool(client: Client) {
  return client.callTool({
    name: 'rah_update_edge',
    arguments: {
      id: UPDATED_EDGE_ID,
      explanation: UPDATED_EDGE_ROW.explanation,
      confirmed_by_user: true,
    },
  });
}

// Extract a tool call's structured answer under the pinned shape.
function structuredAnswerOf(toolResult: unknown): EdgeWriteStructuredAnswer {
  return (toolResult as { structuredContent?: unknown })
    .structuredContent as EdgeWriteStructuredAnswer;
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
});

afterAll(async () => {
  await remoteMcpDoorHarness.stop();
});

beforeEach(() => {
  remoteMcpDoorHarness.resetRecordedAppRequests();
});

describe('remote MCP door rah_create_edge answers carry the stored row', () => {
  // The headline: a successful create must hand back the row the store wrote,
  // not just an id and prose. The stub answers the REST 201 shape that is live
  // today — `data` carrying the full row — so the only thing under test is
  // whether the door RELAYS it.
  it('a successful create answers the stored edge row alongside success, the real edgeId and message', async () => {
    remoteMcpDoorHarness.respondWith((request) => {
      if (request.method === 'POST' && request.pathname === '/api/edges') {
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
    });

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await callCreateEdgeTool(
        client,
        { sourceId: 2, targetId: 1 },
        PLAIN_EDGE_EXPLANATION
      );

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const structuredAnswer = structuredAnswerOf(toolResult);
      // The existing fields stay, with the REAL id.
      expect(structuredAnswer.success).toBe(true);
      expect(structuredAnswer.edgeId).toBe(PLAIN_CREATED_EDGE_ROW.id);
      expect(typeof structuredAnswer.message).toBe('string');
      // The new field: the stored row, as the REST layer returned it.
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
      // A fresh create is not an already-existed answer: absent or false both
      // read as "newly created", true would be a lie here.
      expect(Boolean(structuredAnswer.already_existed)).toBe(false);
    });
  });

  // The orientation truth the row exists to carry: when the classifier swaps
  // the ends (the "Contains…" heuristic — deterministic, pinned at the REST
  // seam in edgeSwapCollisionPin.test.ts), the answer must show the SWAPPED
  // stored ends, not the caller's input. The stub answers exactly what that
  // pin records the REST layer answering.
  it('a create the classifier re-oriented answers the SWAPPED stored ends, not the caller input', async () => {
    remoteMcpDoorHarness.respondWith((request) => {
      if (request.method === 'POST' && request.pathname === '/api/edges') {
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
    });

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      // Written 5 → 7; stored (and answered by the app) as 7 → 5.
      const toolResult = await callCreateEdgeTool(
        client,
        { sourceId: 5, targetId: 7 },
        SWAP_INDUCING_EXPLANATION
      );

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const structuredAnswer = structuredAnswerOf(toolResult);
      expect(
        structuredAnswer.edge,
        'the create answer must carry the stored edge row under `edge`'
      ).toBeDefined();
      // The stored orientation, which is the REVERSE of the caller's input.
      expect(structuredAnswer.edge?.from_node_id).toBe(SWAPPED_CREATED_EDGE_ROW.from_node_id);
      expect(structuredAnswer.edge?.to_node_id).toBe(SWAPPED_CREATED_EDGE_ROW.to_node_id);
      expect(structuredAnswer.edgeId).toBe(SWAPPED_CREATED_EDGE_ROW.id);
    });
  });

  // The duplicate path must answer honestly: still success (unchanged REST
  // semantics), but with an EXPLICIT already-existed indication and the
  // EXISTING edge's row — its real id, never 0. The stub answers the honest
  // REST duplicate shape this slice introduces (pinned red at the REST seam
  // in tests/unit/api/edgesRouteDuplicateCreateAnswersExistingRow.test.ts).
  it('a duplicate create answers the EXISTING edge row with already_existed and its real id, never 0', async () => {
    remoteMcpDoorHarness.respondWith((request) => {
      if (request.method === 'POST' && request.pathname === '/api/edges') {
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
    });

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await callCreateEdgeTool(
        client,
        { sourceId: 2, targetId: 1 },
        PLAIN_EDGE_EXPLANATION
      );

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const structuredAnswer = structuredAnswerOf(toolResult);
      // Unchanged semantics: the duplicate is still a success answer.
      expect(structuredAnswer.success).toBe(true);
      // The explicit indication: a caller must not have to parse prose to
      // learn nothing new was written.
      expect(
        structuredAnswer.already_existed,
        'a duplicate create must answer already_existed: true'
      ).toBe(true);
      // The honest id: the EXISTING edge's, and never the 0 the door invents
      // today when the app answer carries no id.
      expect(structuredAnswer.edgeId).toBe(ALREADY_EXISTING_EDGE_ROW.id);
      expect(structuredAnswer.edgeId).not.toBe(0);
      // The existing edge's row, stored orientation and stored prose — not an
      // echo of the refused request.
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
  });
});

describe('remote MCP door rah_update_edge answers carry the updated stored row', () => {
  // The update answer is prose-only today, even though the REST PUT already
  // returns `data: edge`. It must answer the same shape as create: success,
  // the edge's id, message, and the UPDATED stored row.
  it('an update answers the updated stored edge row in the same shape as create', async () => {
    remoteMcpDoorHarness.respondWith((request) => {
      if (request.method === 'PUT' && request.pathname === `/api/edges/${UPDATED_EDGE_ID}`) {
        return {
          payload: {
            success: true,
            data: UPDATED_EDGE_ROW,
            message: 'Edge updated successfully',
          },
        };
      }
      return undefined;
    });

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await callUpdateEdgeTool(client);

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
  });
});

describe('remote MCP door edge-write output schemas advertise the stored row', () => {
  // Discoverability: an external agent reads the advertised contract, not the
  // handler. Both write tools must DECLARE the row on their output schemas —
  // today rah_create_edge declares only success/edgeId/message and
  // rah_update_edge declares only success/message (not even an id).
  it('rah_create_edge and rah_update_edge declare the stored row fields on their output schemas', async () => {
    // Neither tool is called, so the stub serves nothing.
    remoteMcpDoorHarness.respondWith(() => undefined);

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();

      for (const writeToolName of ['rah_create_edge', 'rah_update_edge']) {
        // The advertised tool under inspection.
        const advertisedTool = listedTools.tools.find((tool) => tool.name === writeToolName);
        expect(advertisedTool, `the door must advertise ${writeToolName}`).toBeDefined();

        // The whole output schema as text: the row's field names must appear
        // somewhere on it for an agent to learn the answer carries them.
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
  });
});
