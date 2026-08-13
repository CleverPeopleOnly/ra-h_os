/**
 * FAILING-FIRST tests for the REMOTE MCP door's graph-event journal tools
 * (app/api/mcp/route.ts): rah_read_graph_events and
 * rah_acknowledge_graph_events. The stdio doors do NOT get these tools in
 * this slice — only the remote route is under test here.
 *
 * THE FEATURE. The database journals graph deaths and re-orientations into
 * a `graph_events` table with a single-row ack cursor `graph_events_ack`
 * (pinned in tests/unit/journal/graph-event-journal-triggers.test.ts). This
 * file pins the one door a remote consumer reads that journal through:
 *  - rah_read_graph_events answers the UNACKNOWLEDGED events (id greater
 *    than the cursor), ordered by id ascending, honouring a `limit`;
 *  - rah_acknowledge_graph_events takes `upToEventId` and moves the cursor
 *    FORWARD ONLY — an upToEventId at or below the cursor leaves it where
 *    it is; the cursor never moves backward.
 *
 * SEAM — the same stub harness as
 * tests/unit/mcp/remote-mcp-route-edge-write-answers-carry-stored-row.test.ts:
 * a real MCP client over the real transport into the exported POST handler,
 * with an in-process HTTP stub standing in for the RA-H app. The route is a
 * proxy: every tool reaches the app over REST via callRaHApi. THE REST
 * SURFACE THE IMPLEMENTATION MUST BUILD TO (the stub below is its
 * specification):
 *  - GET  /api/graph-events?limit=N
 *      → { success: true, data: GraphEventRow[] } — the unacknowledged
 *        events, id ascending, at most N of them;
 *  - POST /api/graph-events/acknowledge with body { upToEventId }
 *      → { success: true, acked_event_id } — acked_event_id being the
 *        cursor AFTER the call, which the forward-only rule may have left
 *        unchanged.
 * The forward-only rule itself is enforced app-side (the cursor lives in
 * SQLite behind the app); what THIS seam pins about it is that the door
 * forwards upToEventId untouched and answers the app's cursor honestly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live harness for this file.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;

// One journal event as the app's REST layer answers it and as the door must
// relay it: every graph_events column under its own name, NULL where the
// column does not apply to the event type.
type GraphEventAnswerRow = {
  id: number;
  event_type: 'edge_deleted' | 'node_deleted' | 'edge_reoriented';
  edge_id: number | null;
  node_id: number | null;
  from_node_id: number | null;
  to_node_id: number | null;
  old_from_node_id: number | null;
  old_to_node_id: number | null;
  occurred_at: string;
};

// The structured answer shape pinned on rah_read_graph_events.
type ReadGraphEventsStructuredAnswer = {
  count: number;
  events: GraphEventAnswerRow[];
};

// The structured answer shape pinned on rah_acknowledge_graph_events:
// acked_event_id is the cursor AFTER the call, as the app answered it.
type AcknowledgeGraphEventsStructuredAnswer = {
  success: boolean;
  acked_event_id: number;
};

// The three fixture journal rows every test reads — one of each event type,
// ids ascending, exactly the column payloads the triggers write.
const EDGE_DELETED_EVENT_ROW: GraphEventAnswerRow = {
  id: 1,
  event_type: 'edge_deleted',
  edge_id: 41,
  node_id: null,
  from_node_id: 7,
  to_node_id: 9,
  old_from_node_id: null,
  old_to_node_id: null,
  occurred_at: '2026-08-13 00:00:01',
};

const NODE_DELETED_EVENT_ROW: GraphEventAnswerRow = {
  id: 2,
  event_type: 'node_deleted',
  edge_id: null,
  node_id: 7,
  from_node_id: null,
  to_node_id: null,
  old_from_node_id: null,
  old_to_node_id: null,
  occurred_at: '2026-08-13 00:00:02',
};

const EDGE_REORIENTED_EVENT_ROW: GraphEventAnswerRow = {
  id: 3,
  event_type: 'edge_reoriented',
  edge_id: 43,
  node_id: null,
  from_node_id: 9,
  to_node_id: 8,
  old_from_node_id: 8,
  old_to_node_id: 9,
  occurred_at: '2026-08-13 00:00:03',
};

// All fixture journal rows, id ascending — the order the journal stores and
// the REST layer answers.
const ALL_GRAPH_EVENT_FIXTURE_ROWS: GraphEventAnswerRow[] = [
  EDGE_DELETED_EVENT_ROW,
  NODE_DELETED_EVENT_ROW,
  EDGE_REORIENTED_EVENT_ROW,
];

/**
 * Install the miniature of the app's graph-event REST surface described in
 * the file header. It keeps the ack cursor in a closure the way the real app
 * keeps it in graph_events_ack, and enforces the app-side forward-only rule
 * (Math.max) so a following read through the door reflects a cursor the app
 * refused to move backward. Returns a reader for the cursor so a test can
 * check where the "app" believes it is.
 */
function installGraphEventRestStub(initialAckedEventId = 0): {
  currentStubAckedEventId: () => number;
} {
  // The stub's stand-in for graph_events_ack.acked_event_id.
  let stubAckedEventId = initialAckedEventId;

  remoteMcpDoorHarness.respondWith((request) => {
    // The read: unacknowledged events, id ascending, at most `limit`.
    if (request.method === 'GET' && request.pathname === '/api/graph-events') {
      const requestedLimit = request.searchParams.limit
        ? Number(request.searchParams.limit)
        : ALL_GRAPH_EVENT_FIXTURE_ROWS.length;
      const unacknowledgedEvents = ALL_GRAPH_EVENT_FIXTURE_ROWS.filter(
        (graphEventRow) => graphEventRow.id > stubAckedEventId
      ).slice(0, requestedLimit);
      return { payload: { success: true, data: unacknowledgedEvents } };
    }

    // The acknowledgement: forward-only cursor move, answered as the cursor
    // AFTER the call.
    if (request.method === 'POST' && request.pathname === '/api/graph-events/acknowledge') {
      const upToEventId = Number((request.body ?? {}).upToEventId);
      stubAckedEventId = Math.max(stubAckedEventId, upToEventId);
      return { payload: { success: true, acked_event_id: stubAckedEventId } };
    }

    return undefined;
  });

  return { currentStubAckedEventId: () => stubAckedEventId };
}

// Ask the door for the unacknowledged journal events.
async function callReadGraphEventsTool(client: Client, args: { limit?: number } = {}) {
  return client.callTool({ name: 'rah_read_graph_events', arguments: args });
}

// Ask the door to move the ack cursor up to the given event id.
async function callAcknowledgeGraphEventsTool(client: Client, upToEventId: number) {
  return client.callTool({
    name: 'rah_acknowledge_graph_events',
    arguments: { upToEventId },
  });
}

// Extract a tool call's structured answer under the given pinned shape.
function structuredAnswerOf<TStructuredAnswer>(toolResult: unknown): TStructuredAnswer {
  return (toolResult as { structuredContent?: unknown }).structuredContent as TStructuredAnswer;
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

describe('remote MCP door rah_read_graph_events', () => {
  // The headline read: with nothing acknowledged, the tool answers ALL the
  // journal events, id ascending, each carrying its event_type and its full
  // column payload — a consumer must never have to make a second call to
  // learn which edge died or where a re-pointed edge now points.
  it('answers the unacknowledged events in id order, each carrying event_type and its payload fields', async () => {
    installGraphEventRestStub();

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await callReadGraphEventsTool(client);

      expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const structuredAnswer = structuredAnswerOf<ReadGraphEventsStructuredAnswer>(toolResult);
      expect(structuredAnswer.count).toBe(ALL_GRAPH_EVENT_FIXTURE_ROWS.length);
      // Id order, ascending — the order the cursor semantics depend on.
      expect(structuredAnswer.events.map((graphEventRow) => graphEventRow.id)).toEqual([1, 2, 3]);
      // Each event type arrives with its own payload columns intact.
      expect(structuredAnswer.events[0]).toMatchObject({
        event_type: 'edge_deleted',
        edge_id: EDGE_DELETED_EVENT_ROW.edge_id,
        from_node_id: EDGE_DELETED_EVENT_ROW.from_node_id,
        to_node_id: EDGE_DELETED_EVENT_ROW.to_node_id,
      });
      expect(structuredAnswer.events[1]).toMatchObject({
        event_type: 'node_deleted',
        node_id: NODE_DELETED_EVENT_ROW.node_id,
      });
      expect(structuredAnswer.events[2]).toMatchObject({
        event_type: 'edge_reoriented',
        edge_id: EDGE_REORIENTED_EVENT_ROW.edge_id,
        old_from_node_id: EDGE_REORIENTED_EVENT_ROW.old_from_node_id,
        old_to_node_id: EDGE_REORIENTED_EVENT_ROW.old_to_node_id,
        from_node_id: EDGE_REORIENTED_EVENT_ROW.from_node_id,
        to_node_id: EDGE_REORIENTED_EVENT_ROW.to_node_id,
      });
      // Every event is stamped with when it happened.
      for (const answeredGraphEvent of structuredAnswer.events) {
        expect(typeof answeredGraphEvent.occurred_at).toBe('string');
      }
    });
  });

  // The limit must reach the app AND bound the answer: a consumer paging a
  // large journal asks for 2 and gets the FIRST 2 (lowest ids — the cursor
  // only ever advances over a contiguous acknowledged prefix).
  it('honours limit: asks the app for that many and answers no more', async () => {
    installGraphEventRestStub();

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const toolResult = await callReadGraphEventsTool(client, { limit: 2 });

      const structuredAnswer = structuredAnswerOf<ReadGraphEventsStructuredAnswer>(toolResult);
      expect(structuredAnswer.count).toBe(2);
      expect(structuredAnswer.events.map((graphEventRow) => graphEventRow.id)).toEqual([1, 2]);

      // The limit rode the request to the app, so the bound is enforced at
      // the store, not by the door trimming an oversized answer.
      const recordedReadRequest = remoteMcpDoorHarness
        .recordedAppRequests()
        .find((appRequest) => appRequest.pathname === '/api/graph-events');
      expect(recordedReadRequest, 'the door must call GET /api/graph-events').toBeDefined();
      expect(recordedReadRequest?.searchParams.limit).toBe('2');
    });
  });
});

describe('remote MCP door rah_acknowledge_graph_events', () => {
  // Acknowledging up to N must make the following read start after N: the
  // door sends upToEventId to the app, and the next read answers only
  // events with id greater than N.
  it('after acknowledging up to N, a following read excludes events with id at or below N', async () => {
    installGraphEventRestStub();

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const acknowledgeToolResult = await callAcknowledgeGraphEventsTool(client, 2);

      expect((acknowledgeToolResult as { isError?: boolean }).isError ?? false).toBe(false);
      const acknowledgeAnswer =
        structuredAnswerOf<AcknowledgeGraphEventsStructuredAnswer>(acknowledgeToolResult);
      expect(acknowledgeAnswer.success).toBe(true);
      // The answered cursor is where the app now stands.
      expect(acknowledgeAnswer.acked_event_id).toBe(2);

      // The door forwarded the caller's upToEventId untouched.
      const recordedAcknowledgeRequest = remoteMcpDoorHarness
        .recordedAppRequests()
        .find((appRequest) => appRequest.pathname === '/api/graph-events/acknowledge');
      expect(
        recordedAcknowledgeRequest,
        'the door must call POST /api/graph-events/acknowledge'
      ).toBeDefined();
      expect(recordedAcknowledgeRequest?.body?.upToEventId).toBe(2);

      // The following read starts after the acknowledged prefix.
      const followingReadResult = await callReadGraphEventsTool(client);
      const followingReadAnswer =
        structuredAnswerOf<ReadGraphEventsStructuredAnswer>(followingReadResult);
      expect(followingReadAnswer.events.map((graphEventRow) => graphEventRow.id)).toEqual([3]);
    });
  });

  // FORWARD ONLY. An upToEventId at or below the cursor leaves the cursor
  // where it is: the door forwards the low value untouched (no client-side
  // clamping games), the app-side rule refuses the backward move, and the
  // door answers the UNMOVED cursor honestly — so a following read is
  // unchanged and nothing is re-delivered twice-acknowledged events.
  it('acknowledging an upToEventId below the cursor leaves the cursor unmoved and a following read unchanged', async () => {
    // The app's cursor already stands at 2 when this test begins.
    const graphEventRestStub = installGraphEventRestStub(2);

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const backwardAcknowledgeResult = await callAcknowledgeGraphEventsTool(client, 1);

      expect((backwardAcknowledgeResult as { isError?: boolean }).isError ?? false).toBe(false);
      const backwardAcknowledgeAnswer =
        structuredAnswerOf<AcknowledgeGraphEventsStructuredAnswer>(backwardAcknowledgeResult);
      // The answered cursor is the UNMOVED one, not an echo of the request.
      expect(backwardAcknowledgeAnswer.acked_event_id).toBe(2);
      // The app's cursor really did not move backward.
      expect(graphEventRestStub.currentStubAckedEventId()).toBe(2);

      // The door forwarded the low upToEventId as given — the refusal to
      // move is the app's decision, not the door's silent edit.
      const recordedAcknowledgeRequest = remoteMcpDoorHarness
        .recordedAppRequests()
        .find((appRequest) => appRequest.pathname === '/api/graph-events/acknowledge');
      expect(recordedAcknowledgeRequest?.body?.upToEventId).toBe(1);

      // A following read is unchanged: still only the events after id 2.
      const followingReadResult = await callReadGraphEventsTool(client);
      const followingReadAnswer =
        structuredAnswerOf<ReadGraphEventsStructuredAnswer>(followingReadResult);
      expect(followingReadAnswer.events.map((graphEventRow) => graphEventRow.id)).toEqual([3]);
    });
  });
});

describe('remote MCP door graph-event tool registry', () => {
  // Discoverability: an external agent reads the advertised contract, not
  // the handlers. Both tools must be listed with output schemas declaring
  // the fields their answers carry.
  it('both graph-event tools are advertised with output schemas declaring their answer fields', async () => {
    // Neither tool is called, so the stub serves nothing.
    remoteMcpDoorHarness.respondWith(() => undefined);

    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const listedTools = await client.listTools();

      // The read tool must declare the events array and every journal column
      // an answered event carries.
      const advertisedReadTool = listedTools.tools.find(
        (tool) => tool.name === 'rah_read_graph_events'
      );
      expect(advertisedReadTool, 'the door must advertise rah_read_graph_events').toBeDefined();
      const readOutputSchemaJson = JSON.stringify(advertisedReadTool?.outputSchema ?? {});
      for (const answeredEventFieldName of [
        'events',
        'event_type',
        'edge_id',
        'node_id',
        'from_node_id',
        'to_node_id',
        'old_from_node_id',
        'old_to_node_id',
        'occurred_at',
      ]) {
        expect(
          readOutputSchemaJson,
          `rah_read_graph_events must declare ${answeredEventFieldName} on its output schema`
        ).toContain(answeredEventFieldName);
      }

      // The acknowledge tool must declare the cursor it answers.
      const advertisedAcknowledgeTool = listedTools.tools.find(
        (tool) => tool.name === 'rah_acknowledge_graph_events'
      );
      expect(
        advertisedAcknowledgeTool,
        'the door must advertise rah_acknowledge_graph_events'
      ).toBeDefined();
      const acknowledgeOutputSchemaJson = JSON.stringify(
        advertisedAcknowledgeTool?.outputSchema ?? {}
      );
      expect(
        acknowledgeOutputSchemaJson,
        'rah_acknowledge_graph_events must declare acked_event_id on its output schema'
      ).toContain('acked_event_id');
    });
  });
});
