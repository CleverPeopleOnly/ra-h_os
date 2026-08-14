/**
 * Fixed-credence writes — the app-side twin of the standalone door's
 * setBeliefFixedCredence, with identical semantics: set the node's
 * belief_credence to the asserted number, mark belief_credence_is_fixed = 1,
 * stamp belief_computed_at, and append a belief_movements row ONLY when the
 * credence actually changed — re-asserting the same number is not a change
 * and logs nothing.
 *
 * samai owns the belief engine since the belief-storage split, so no engine
 * runs on either write here. The un-fix door, clearBeliefFixedCredence,
 * clears the flag and writes the three display columns to NULL DIRECTLY:
 * withdrawing an assertion leaves the node never-assessed until samai next
 * writes its display belief through the remote door.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';
import type { BeliefMovementTrigger } from '@/services/belief/beliefService';

// The one trigger a fixed-credence assertion stamps on its movement row.
const BELIEF_FIXED_CREDENCE_SET_TRIGGER: BeliefMovementTrigger = 'belief-fixed-credence-set';

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

  // Single timestamp shared by the node write and any movement row. The
  // stored belief_uncertainty clears to NULL alongside the assertion: it was
  // samai's uncertainty about a credence this write has just overwritten, so
  // leaving it would pair samai's stale figure with the human's number. The
  // read surface answers 0 for a fixed node regardless (the dogmatic
  // opinion), so nothing the UI or doors report changes — NULLing is purely
  // about not storing a stale value.
  const beliefComputedAt = new Date().toISOString();
  sqlite
    .prepare(
      `UPDATE nodes
          SET belief_credence = ?, belief_credence_is_fixed = 1, belief_computed_at = ?,
              belief_uncertainty = NULL
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
        BELIEF_FIXED_CREDENCE_SET_TRIGGER,
        beliefComputedAt
      );
  }

  return { beliefCredence: assertedBeliefCredence, beliefComputedAt };
}

// What one successful un-fix reports back: the node's credence after the
// withdrawal — always null, because a withdrawal leaves the node
// never-assessed; a real outcome and never an error.
export interface BeliefFixedCredenceClearance {
  // The node's credence after the withdrawal; null — never-assessed.
  beliefCredence: number | null;
}

// The un-fix door: withdraw one node's asserted credence. Clears
// belief_credence_is_fixed to 0 and writes credence, uncertainty and
// computed_at to NULL directly — no engine is involved (samai owns the
// engine), and the node stays never-assessed until samai next writes its
// display belief. No movement is logged: an ungraded outcome has no
// to_credence to record. Returns null when no such node exists — clearing an
// assertion about nothing must be an error at the caller, never a silent
// no-op.
export async function clearBeliefFixedCredence(
  nodeId: number
): Promise<BeliefFixedCredenceClearance | null> {
  const sqlite = getSQLiteClient();

  // The row's absence is what makes an unknown node a refusal.
  const nodeRow = sqlite.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId) as
    | { id: number }
    | undefined;
  if (nodeRow === undefined) {
    return null;
  }

  // Withdraw the assertion in one write: the flag clears and all three
  // display columns NULL together — the never-assessed state.
  sqlite
    .prepare(
      `UPDATE nodes
          SET belief_credence_is_fixed = 0,
              belief_credence = NULL, belief_uncertainty = NULL, belief_computed_at = NULL
        WHERE id = ?`
    )
    .run(nodeId);

  // Never-assessed is the whole outcome: null credence, reported honestly.
  return { beliefCredence: null };
}
