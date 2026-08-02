/**
 * Movement reads — the log of a node's credence changing, served newest
 * first. A movement's from_credence is NULL exactly when the node was
 * previously ungraded (a different history from a recorded 0), and an empty
 * log is a success state: the node's credence has simply never changed.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';

// One belief_movements row as a movement read reports it — the table's
// columns by their exact names.
export interface BeliefMovementReadRow {
  id: number;
  node_id: number;
  // The credence before the change; null when the node was previously
  // ungraded — never 0, which would claim it had been assessed.
  from_credence: number | null;
  // The credence after the change; always present — a movement to nowhere is
  // not a movement.
  to_credence: number;
  // What caused the credence to change.
  trigger: string;
  // When the credence changed.
  occurred_at: string;
}

// Read one node's movement log, newest movement first, capped at the given
// page size so a long-lived node cannot flood a caller with its whole
// history. Movement rows are appended in chronological order, so id order IS
// time order and DESC gives newest first deterministically.
export function readBeliefMovementsNewestFirst(
  nodeId: number,
  movementPageLimit: number
): BeliefMovementReadRow[] {
  const sqlite = getSQLiteClient();
  return sqlite
    .prepare(
      `SELECT id, node_id, from_credence, to_credence, "trigger", occurred_at
       FROM belief_movements
       WHERE node_id = ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(nodeId, movementPageLimit) as BeliefMovementReadRow[];
}
