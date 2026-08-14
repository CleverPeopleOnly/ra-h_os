/**
 * Fixed-credence writes — the app-side twin of the standalone door's
 * setBeliefFixedCredence, with identical semantics: set the node's
 * belief_credence to the asserted number, mark belief_credence_is_fixed = 1,
 * stamp belief_computed_at, and append a belief_movements row ONLY when the
 * credence actually changed — re-asserting the same number is not a change
 * and logs nothing.
 *
 * Belief evidence left the edges table (it lives in samai's own store now),
 * so neither door propagates anywhere: there are no evidence edges through
 * which an assertion could reach another node. The un-fix door,
 * clearBeliefFixedCredence, clears the flag and immediately recomputes the
 * node — which, with no evidence basis left to read, lands it never-assessed
 * and logs no movement (an ungraded outcome has no to_credence to record).
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';
import { recomputeNodeBelief } from '@/services/belief/beliefService';

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

  // Single timestamp shared by the node write and any movement row. The two
  // evidence masses clear to NULL alongside the assertion (spec §2: a fixed
  // credence is the dogmatic opinion — there is no evidence ledger behind an
  // assertion, so masses left by an earlier engine grading would be stale).
  const beliefComputedAt = new Date().toISOString();
  sqlite
    .prepare(
      `UPDATE nodes
          SET belief_credence = ?, belief_credence_is_fixed = 1, belief_computed_at = ?,
              belief_evidence_for_mass = NULL, belief_evidence_against_mass = NULL
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

// What one successful un-fix reports back: the credence the immediate
// recompute landed on — null for a now-ungraded node, a real outcome and
// never an error.
export interface BeliefFixedCredenceClearance {
  // The node's credence after the recompute; null when it landed ungraded.
  beliefCredence: number | null;
}

// The un-fix door (v2): withdraw one node's asserted credence. Clears
// belief_credence_is_fixed to 0 and IMMEDIATELY recomputes the node — which,
// with no edge carrying evidence any more, lands it never-assessed. No
// movement is logged: an ungraded outcome has no to_credence to record.
// Returns null when no such node exists — clearing an assertion about
// nothing must be an error at the caller, never a silent no-op.
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

  // Withdraw the assertion: the flag clears, and the engine owns the credence
  // again from this write on.
  sqlite.prepare('UPDATE nodes SET belief_credence_is_fixed = 0 WHERE id = ?').run(nodeId);

  // The immediate recompute: with no edge carrying evidence, it clears the
  // node to never-assessed and reports null — a real outcome, not an error.
  const regradeResult = await recomputeNodeBelief(nodeId, 'belief-fixed-credence-cleared');
  return { beliefCredence: regradeResult.beliefCredence };
}
