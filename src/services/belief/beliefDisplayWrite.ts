/**
 * Display-belief writes — the plain column write behind POST
 * /api/belief/display. samai owns the belief engine since the belief-storage
 * split; the fork's node belief is a pure DISPLAY surface samai writes
 * through the remote MCP door, so this write lands (or clears) the three
 * display columns verbatim and does nothing else: no engine, no derivation,
 * and NO belief_movements row — movement history is samai's now.
 *
 * Exactly two legal shapes exist, and the CALLER validates them before this
 * write runs: a GRADE (credence, uncertainty and computed_at all non-null) or
 * an UNGRADE (all three null). This module only enforces what the stored row
 * itself decides: an unknown node is a refusal, and so is a FIXED node — a
 * hand-asserted credence is only changed through the assert/clear tools.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';

// The three display columns of one GRADE, exactly as they land on the row.
export interface DisplayBeliefGrade {
  // How much samai believes the node: signed, in [-1, +1].
  beliefCredence: number;
  // How little evidence that credence rests on: in (0, 1].
  beliefUncertainty: number;
  // When samai computed the grade (ISO-8601), stored verbatim.
  beliefComputedAt: string;
}

// The four belief columns of one node as stored after a display write — read
// back from the row, never echoed from the request.
export interface StoredDisplayBeliefRow {
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
}

// What one display write came to: written (with the stored row as it now
// stands), refused because no such node exists, or refused because the
// node's credence is hand-asserted.
export type DisplayBeliefWriteOutcome =
  | { outcome: 'written'; storedRow: StoredDisplayBeliefRow }
  | { outcome: 'unknown-node' }
  | { outcome: 'fixed-node' };

/**
 * Write one node's display belief: the three columns land verbatim on a
 * GRADE, or clear together on an UNGRADE (displayBeliefGrade null). Refuses
 * an unknown node and a fixed node without writing anything.
 */
export function writeDisplayBelief(
  nodeId: number,
  displayBeliefGrade: DisplayBeliefGrade | null
): DisplayBeliefWriteOutcome {
  const sqlite = getSQLiteClient();

  // The row's absence is what makes an unknown node a refusal, and its fixed
  // flag is what makes a hand-asserted node one.
  const nodeFixedFlagRow = sqlite
    .prepare('SELECT belief_credence_is_fixed FROM nodes WHERE id = ?')
    .get(nodeId) as { belief_credence_is_fixed: number } | undefined;
  if (nodeFixedFlagRow === undefined) {
    return { outcome: 'unknown-node' };
  }
  if (nodeFixedFlagRow.belief_credence_is_fixed === 1) {
    return { outcome: 'fixed-node' };
  }

  // The plain column write: three columns together, in both shapes. No
  // movement row — a display write records samai's conclusion, not a
  // fork-side credence change.
  sqlite
    .prepare(
      `UPDATE nodes
          SET belief_credence = ?, belief_uncertainty = ?, belief_computed_at = ?
        WHERE id = ?`
    )
    .run(
      displayBeliefGrade?.beliefCredence ?? null,
      displayBeliefGrade?.beliefUncertainty ?? null,
      displayBeliefGrade?.beliefComputedAt ?? null,
      nodeId
    );

  // The reply is the STORED row, read back so it reports what actually
  // landed rather than echoing the request.
  const storedRow = sqlite
    .prepare(
      `SELECT belief_credence, belief_uncertainty, belief_computed_at, belief_credence_is_fixed
         FROM nodes WHERE id = ?`
    )
    .get(nodeId) as StoredDisplayBeliefRow;
  return { outcome: 'written', storedRow };
}
