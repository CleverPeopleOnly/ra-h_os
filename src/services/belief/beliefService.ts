/**
 * Belief service — interim shape for the evidence-leaves-the-edges-table
 * slice.
 *
 * Belief evidence moved out of this fork into samai's own store, so no edge
 * carries evidence any more and every node's evidence basis is EMPTY BY
 * DEFINITION. Until later slices delete the engine wholesale, a recompute of
 * a NON-FIXED node lands never-assessed — credence NULL, computed_at NULL,
 * both evidence masses NULL — no matter what edges the node has, and null
 * credence rides the normal result shape as a real answer. A FIXED node
 * keeps its human-asserted credence through a recompute (the fixed
 * short-circuit survives). Nothing propagates: with no evidence edges to
 * walk there is no sweep, so a recompute touches exactly the one node it was
 * asked about.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';
import type { SQLiteClient } from '@/services/database/sqlite-client';

// The actual cause of a movement, one value per entry point (spec §5). Only
// the fixed-credence assertion still logs movements — the other values are
// kept so the vocabulary of the existing belief_movements log stays readable.
export type BeliefMovementTrigger =
  | 'evidence-edge-write'
  | 'embed-grade'
  | 'recovery-sweep'
  | 'propagation'
  | 'mcp-recompute'
  | 'belief-fixed-credence-set'
  | 'belief-fixed-credence-cleared'
  | 'model-migration';

// One per-edge contribution as a recompute reports it. With no edge carrying
// evidence any more a recompute never has one to report, but the result
// shape keeps the field so callers read one contract before and after the
// evidence removal.
export interface BeliefEdgeContribution {
  // The edge this contribution belonged to.
  edgeId: number;
  // The signed amount the edge contributed.
  effectiveContribution: number;
}

// One recorded change of a node's credence.
export interface BeliefMovementRecord {
  // Credence before the regrade; null when the node was previously ungraded.
  fromCredence: number | null;
  // Credence after the regrade.
  toCredence: number;
  // The entry point that caused the regrade (spec §5).
  trigger: string;
}

// Full outcome of one recomputeNodeBelief call.
export interface BeliefRecomputeResult {
  // New credence: the asserted credence of a fixed node, or null — a node
  // with no evidence basis (which is now every non-fixed node) is ungraded.
  beliefCredence: number | null;
  // Movement appended for the node, or null when nothing was logged. With no
  // evidence to grade from, a recompute never logs one.
  movement: BeliefMovementRecord | null;
  // Per-edge contributions counted during the regrade: always empty now.
  contributions: BeliefEdgeContribution[];
}

// The belief state a recompute finds on the node it grades before writing
// anything: the credence the node currently holds, and whether a human
// asserted that credence by hand (in which case the recompute leaves it
// alone).
interface BeliefStateRowBeforeRecompute {
  belief_credence: number | null;
  belief_credence_is_fixed: number;
}

// Recompute one node's belief. With no edge carrying evidence, this reduces
// to two cases:
//  - a node whose belief_credence_is_fixed is set has its credence ASSERTED
//    by a human, so it is returned untouched: nothing written, nothing
//    logged,
//  - every other node lands NEVER ASSESSED: credence, timestamp and both
//    evidence masses cleared to NULL together, with no movement row — an
//    ungraded outcome has no to_credence to record.
// The movementTrigger parameter is kept so every caller still names its
// entry point, even though a recompute no longer has a movement to stamp it
// on.
export async function recomputeNodeBelief(
  nodeId: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  movementTrigger: BeliefMovementTrigger = 'mcp-recompute'
): Promise<BeliefRecomputeResult> {
  const sqlite: SQLiteClient = getSQLiteClient();

  // Belief state of the node before this recompute: the credence it holds,
  // and whether that credence was asserted by a human.
  const nodeBeliefStateRow = sqlite
    .prepare('SELECT belief_credence, belief_credence_is_fixed FROM nodes WHERE id = ?')
    .get(nodeId) as BeliefStateRowBeforeRecompute | undefined;

  // An asserted credence is not derived from the graph, so a recompute is a
  // no-op on it: the stored credence is reported back and nothing is written.
  if (nodeBeliefStateRow?.belief_credence_is_fixed) {
    return {
      beliefCredence: nodeBeliefStateRow.belief_credence ?? null,
      movement: null,
      contributions: [],
    };
  }

  // Never assessed is the only outcome left for a non-fixed node (§3 row 7):
  // credence, timestamp and BOTH masses cleared to NULL together — the
  // masses move as a pair, never one at a time.
  sqlite
    .prepare(
      `UPDATE nodes
          SET belief_credence = NULL, belief_computed_at = NULL,
              belief_evidence_for_mass = NULL, belief_evidence_against_mass = NULL
        WHERE id = ?`
    )
    .run(nodeId);

  return {
    beliefCredence: null,
    movement: null,
    contributions: [],
  };
}
