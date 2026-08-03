/**
 * Belief recovery sweep (docs/belief-model-subjective-logic.md §4, last
 * paragraph).
 *
 * The startup sweep regrades every node whose stored belief state cannot be
 * trusted. It recovers three shapes:
 *
 *  1. NEVER-STAMPED evidence: edges written by the standalone MCP server
 *     while the app was closed carry NULL belief_evidence_contribution (the
 *     standalone server never grades — grading is app-owned).
 *  2. STALE-STAMPED evidence (new in v2): an edge whose stamp differs from
 *     the live (source credence × support) by more than epsilon was graded
 *     when the source held a different credence — invisible to the v1 sweep,
 *     which keyed only on NULL stamps.
 *  3. MODEL-MIGRATION shape (new in v2): a node with incoming evidence whose
 *     belief_credence is non-NULL while its evidence masses are NULL was
 *     graded by the v1 engine, which stored no masses — regraded under the
 *     mass model, movement trigger 'model-migration', so the log says why the
 *     numbers changed.
 *
 * The sweep recovers BOTH stale-stamped and never-stamped evidence, so the v1
 * name (recoverUngradedEvidence) no longer said what the function does; the
 * export is runBeliefRecoverySweep.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';
import {
  BELIEF_CREDENCE_CHANGE_EPSILON,
  recomputeNodeBelief,
  type BeliefMovementTrigger,
} from '@/services/belief/beliefService';

// Outcome of one recovery sweep: which nodes were regraded.
export interface BeliefRecoveryResult {
  // IDs of the nodes the sweep regraded directly (nodes further regraded by
  // propagation log their own movements but are not sweep candidates).
  regradedNodeIds: number[];
}

// Find every node whose belief state needs recovering (see the module header
// for the three shapes) and regrade it via recomputeNodeBelief — which itself
// propagates onward, refreshing every stamp it touches. A node whose credence
// is human-asserted (belief_credence_is_fixed) is excluded outright: a
// regrade would leave it untouched anyway, and its unstamped incoming
// evidence matches the pending-work condition on every run, so without the
// filter it would be reported as work forever. Fully-stamped, fresh nodes and
// nodes without evidence edges are left untouched, which keeps the sweep
// idempotent: regrading refreshes every stamp and persists the masses, so a
// rerun finds nothing left to do.
export async function runBeliefRecoverySweep(): Promise<BeliefRecoveryResult> {
  const sqlite = getSQLiteClient();

  // The movement trigger each candidate's regrade must log, keyed by node.
  // Insertion order is processing order.
  const recoveryTriggerByNodeId = new Map<number, BeliefMovementTrigger>();

  // Shape 1 — never-stamped evidence: target nodes carrying at least one
  // evidence edge with a NULL contribution stamp (support set, stamp NULL —
  // i.e. offline writes). A NULL support means the edge is not evidence, so
  // it is never pending work.
  const neverStampedEvidenceNodeRows = sqlite
    .prepare(
      `SELECT DISTINCT e.to_node_id AS node_id
       FROM edges e
       JOIN nodes n ON n.id = e.to_node_id
       WHERE e.belief_evidence_support IS NOT NULL
         AND e.belief_evidence_contribution IS NULL
         AND n.belief_credence_is_fixed = 0
       ORDER BY e.to_node_id ASC`
    )
    .all() as Array<{ node_id: number }>;
  for (const neverStampedEvidenceNodeRow of neverStampedEvidenceNodeRows) {
    recoveryTriggerByNodeId.set(neverStampedEvidenceNodeRow.node_id, 'recovery-sweep');
  }

  // Shape 2 — stale-stamped evidence: a stamp that disagrees with the live
  // (source credence × support) by more than epsilon, including a stamp whose
  // source has since been un-graded (credence NULL — there is no live product
  // for the stamp to agree with, so it is stale by definition).
  const staleStampedEvidenceNodeRows = sqlite
    .prepare(
      `SELECT DISTINCT e.to_node_id AS node_id
       FROM edges e
       JOIN nodes target ON target.id = e.to_node_id
       JOIN nodes source ON source.id = e.from_node_id
       WHERE e.belief_evidence_support IS NOT NULL
         AND e.belief_evidence_contribution IS NOT NULL
         AND target.belief_credence_is_fixed = 0
         AND (
           source.belief_credence IS NULL
           OR ABS(e.belief_evidence_contribution - source.belief_credence * e.belief_evidence_support) > ?
         )
       ORDER BY e.to_node_id ASC`
    )
    .all(BELIEF_CREDENCE_CHANGE_EPSILON) as Array<{ node_id: number }>;
  for (const staleStampedEvidenceNodeRow of staleStampedEvidenceNodeRows) {
    if (!recoveryTriggerByNodeId.has(staleStampedEvidenceNodeRow.node_id)) {
      recoveryTriggerByNodeId.set(staleStampedEvidenceNodeRow.node_id, 'recovery-sweep');
    }
  }

  // Shape 3 — model migration: a node with incoming evidence graded under v1
  // (credence stored, masses never written). Restricted to nodes that HAVE
  // incoming evidence, because only such nodes were ever graded by the
  // engine — a credence with no evidence behind it has nothing to regrade
  // from, and regrading it would clear it rather than migrate it.
  const massLessGradedNodeRows = sqlite
    .prepare(
      `SELECT DISTINCT n.id AS node_id
       FROM nodes n
       JOIN edges e ON e.to_node_id = n.id AND e.belief_evidence_support IS NOT NULL
       WHERE n.belief_credence IS NOT NULL
         AND n.belief_evidence_for_mass IS NULL
         AND n.belief_credence_is_fixed = 0
       ORDER BY n.id ASC`
    )
    .all() as Array<{ node_id: number }>;
  for (const massLessGradedNodeRow of massLessGradedNodeRows) {
    if (!recoveryTriggerByNodeId.has(massLessGradedNodeRow.node_id)) {
      recoveryTriggerByNodeId.set(massLessGradedNodeRow.node_id, 'model-migration');
    }
  }

  // Every node the sweep regraded directly, in the order it processed them.
  const regradedNodeIds: number[] = [];
  for (const [recoveredNodeId, recoveryTrigger] of recoveryTriggerByNodeId) {
    await recomputeNodeBelief(recoveredNodeId, recoveryTrigger);
    regradedNodeIds.push(recoveredNodeId);
  }

  return { regradedNodeIds };
}
