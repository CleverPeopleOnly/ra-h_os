/**
 * Graph-event journal reads and the ack cursor — the app-side service over
 * the trigger-written graph_events table and its single-row graph_events_ack
 * cursor. A consumer reads the unacknowledged events (id greater than the
 * cursor), mirrors them, then acknowledges up to the highest id it handled;
 * the cursor only ever moves FORWARD, so twice-acknowledged events are never
 * re-delivered and a stale consumer cannot rewind another's progress.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';

// One graph_events row as the journal stores it and the REST layer answers
// it: every column under its own name, NULL where the column does not apply
// to the event type (e.g. node_id on an edge_deleted row).
export interface GraphEventRow {
  id: number;
  event_type: 'edge_deleted' | 'node_deleted' | 'edge_reoriented';
  edge_id: number | null;
  node_id: number | null;
  from_node_id: number | null;
  to_node_id: number | null;
  old_from_node_id: number | null;
  old_to_node_id: number | null;
  occurred_at: string;
}

// Read the unacknowledged journal events — id greater than the ack cursor —
// oldest first (id ascending, the order the cursor semantics depend on),
// capped at the given page size so a long-unread journal cannot flood a
// caller.
export function readUnacknowledgedGraphEvents(graphEventPageLimit: number): GraphEventRow[] {
  const sqlite = getSQLiteClient();
  return sqlite
    .prepare(
      `SELECT id, event_type, edge_id, node_id, from_node_id, to_node_id,
              old_from_node_id, old_to_node_id, occurred_at
       FROM graph_events
       WHERE id > (SELECT acked_event_id FROM graph_events_ack WHERE id = 1)
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(graphEventPageLimit) as GraphEventRow[];
}

// Move the ack cursor FORWARD to upToEventId — MAX keeps an upToEventId at or
// below the cursor from moving it backward — and answer the cursor as it
// stands AFTER the call, which that rule may have left unchanged.
export function acknowledgeGraphEventsUpTo(upToEventId: number): number {
  const sqlite = getSQLiteClient();
  sqlite
    .prepare('UPDATE graph_events_ack SET acked_event_id = MAX(acked_event_id, ?) WHERE id = 1')
    .run(upToEventId);
  // The cursor after the forward-only move — read back rather than computed
  // client-side, so the answer is what the table actually holds.
  const ackCursorRow = sqlite
    .prepare('SELECT acked_event_id FROM graph_events_ack WHERE id = 1')
    .get() as { acked_event_id: number };
  return ackCursorRow.acked_event_id;
}
