/**
 * Belief recovery sweep (MR-B stub — NOT IMPLEMENTED YET).
 *
 * Purpose: evidence edges written by the standalone MCP server while the app
 * was closed carry NULL belief_evidence_contribution (the standalone
 * server never grades — grading is app-owned). At app startup this sweep
 * finds every node with such ungraded evidence and regrades it via
 * recomputeNodeBelief, so belief values catch up with offline writes.
 *
 * The tests in tests/unit/belief/beliefRecovery.test.ts pin the contract;
 * this stub exists so the test suite compiles and fails RED for the intended
 * reason (missing behavior), not for a missing module.
 */

// Outcome of one recovery sweep: which nodes were regraded.
export interface BeliefRecoveryResult {
  // IDs of the nodes whose belief was recomputed because they had evidence
  // edges with a NULL belief_evidence_contribution stamp.
  regradedNodeIds: number[];
}

// Find every node with ungraded evidence (incoming edges whose
// belief_evidence_direction is set but belief_evidence_contribution is NULL) and
// recompute its belief. Fully-stamped nodes and nodes without evidence edges
// must be left untouched.
export async function recoverUngradedEvidence(): Promise<BeliefRecoveryResult> {
  throw new Error(
    'recoverUngradedEvidence is not implemented yet (MR-B belief recovery sweep pending).'
  );
}
