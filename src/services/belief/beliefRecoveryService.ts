/**
 * Belief recovery sweep (MR-B).
 *
 * Purpose: evidence edges written by the standalone MCP server while the app
 * was closed carry NULL belief_evidence_contribution (the standalone
 * server never grades — grading is app-owned). At app startup this sweep
 * finds every node with such ungraded evidence and regrades it via
 * recomputeNodeBelief, so node credences catch up with offline writes.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';
import { recomputeNodeBelief } from '@/services/belief/beliefService';

// Outcome of one recovery sweep: which nodes were regraded.
export interface BeliefRecoveryResult {
  // IDs of the nodes whose belief was recomputed because they had evidence
  // edges with a NULL belief_evidence_contribution stamp.
  regradedNodeIds: number[];
}

// Find every node with ungraded evidence (incoming edges whose
// belief_evidence_support is set but belief_evidence_contribution is NULL) and
// recompute its belief. Fully-stamped nodes and nodes without evidence edges
// must be left untouched, which makes the sweep idempotent: regrading stamps
// every evidence edge, so a rerun finds nothing left to do.
export async function recoverUngradedEvidence(): Promise<BeliefRecoveryResult> {
  const sqlite = getSQLiteClient();

  // Distinct target nodes carrying at least one evidence edge that was never
  // graded (support set, contribution stamp NULL) — i.e. offline writes. A
  // NULL support means the edge is not evidence, so it is never pending work.
  const ungradedEvidenceNodeRows = sqlite
    .prepare(
      `SELECT DISTINCT to_node_id AS node_id
       FROM edges
       WHERE belief_evidence_support IS NOT NULL
         AND belief_evidence_contribution IS NULL
       ORDER BY to_node_id ASC`
    )
    .all() as Array<{ node_id: number }>;

  // Every node the sweep actually regraded, in the order it processed them.
  const regradedNodeIds: number[] = [];
  for (const ungradedEvidenceNodeRow of ungradedEvidenceNodeRows) {
    await recomputeNodeBelief(ungradedEvidenceNodeRow.node_id);
    regradedNodeIds.push(ungradedEvidenceNodeRow.node_id);
  }

  return { regradedNodeIds };
}
