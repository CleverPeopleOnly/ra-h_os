/**
 * Fixed-credence writes — the app-side twin of the standalone door's
 * setBeliefFixedCredence, with identical semantics: set the node's
 * belief_credence to the asserted number, mark belief_credence_is_fixed = 1,
 * stamp belief_computed_at, and append a belief_movements row ONLY when the
 * credence actually changed — re-asserting the same number is not a change
 * and logs nothing.
 *
 * A fixed credence is the bootstrap a graph needs before anything in it can
 * be graded: a node's credence is also the credence carried by every piece of
 * evidence that node supplies, so until at least one node has a credence
 * there is nothing for the engine to grade from.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';

// What one successful fixed-credence assertion wrote: the credence now stored
// on the node and the shared timestamp stamped on the node (and on the
// movement row, when one was logged).
export interface BeliefFixedCredenceAssertion {
  // The credence now stored on the node — the literal number asserted.
  beliefCredence: number;
  // When the assertion was stamped; shared by the node and any movement row.
  beliefComputedAt: string;
}

// The node's belief state before an assertion, read to decide whether the
// credence actually changes (and therefore whether a movement is logged).
interface BeliefStateRowBeforeAssertion {
  belief_credence: number | null;
}

// Assert one node's credence by hand. Returns null when no such node exists —
// asserting a credence about nothing must be an error at the caller, never a
// silent no-op. The caller is responsible for range-checking the credence
// against the open interval (-1, +1) before this write runs.
export function setBeliefFixedCredence(
  nodeId: number,
  assertedBeliefCredence: number
): BeliefFixedCredenceAssertion | null {
  const sqlite = getSQLiteClient();

  // The node's credence before this assertion; the row's absence is what
  // makes an unknown node a refusal rather than a silent no-op.
  const nodeBeliefStateRow = sqlite
    .prepare('SELECT belief_credence FROM nodes WHERE id = ?')
    .get(nodeId) as BeliefStateRowBeforeAssertion | undefined;
  if (nodeBeliefStateRow === undefined) {
    return null;
  }
  const previousBeliefCredence = nodeBeliefStateRow.belief_credence ?? null;

  // Single timestamp shared by the node write and any movement row.
  const beliefComputedAt = new Date().toISOString();
  sqlite
    .prepare(
      `UPDATE nodes
          SET belief_credence = ?, belief_credence_is_fixed = 1, belief_computed_at = ?
        WHERE id = ?`
    )
    .run(assertedBeliefCredence, beliefComputedAt, nodeId);

  // The credence and its timestamp are written unconditionally; only the
  // movement row is conditional, because a movement records the credence
  // CHANGING and re-asserting the same number is not a change. The comparison
  // is EXACT: an asserted credence is a literal number compared against a
  // literal number, with no arithmetic drift for a tolerance to absorb.
  const beliefCredenceChanged = previousBeliefCredence !== assertedBeliefCredence;
  if (beliefCredenceChanged) {
    sqlite
      .prepare(
        `INSERT INTO belief_movements (node_id, from_credence, to_credence, "trigger", occurred_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        nodeId,
        previousBeliefCredence,
        assertedBeliefCredence,
        'belief-fixed-credence-set',
        beliefComputedAt
      );
  }

  return { beliefCredence: assertedBeliefCredence, beliefComputedAt };
}
