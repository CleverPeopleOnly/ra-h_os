/**
 * Belief service — recomputes a node's credence from its incoming
 * evidence edges, persists the result (nodes.belief_credence +
 * belief_computed_at), stamps each evidence edge's
 * belief_evidence_contribution, and appends a belief_movements row
 * whenever the credence actually changed.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';
import {
  beliefGradingPolicyV1,
  type BeliefEvidenceContribution,
} from '@/services/belief/beliefGradingPolicy';
import { getTrustScore } from '@/services/belief/sourceTrustService';

// Signed effective contribution (support × the source's trust score) stamped
// on one evidence edge during a recompute.
export interface BeliefEdgeContribution {
  // The evidence edge this contribution belongs to.
  edgeId: number;
  // support × the source's trust score; negative when the edge's support is
  // negative, because support is the only signed term in the product.
  effectiveContribution: number;
}

// One recorded change of a node's credence.
export interface BeliefMovementRecord {
  // Credence before the recompute; null when the node was previously ungraded.
  fromCredence: number | null;
  // Credence after the recompute.
  toCredence: number;
  // What caused the recompute (e.g. an edge insert or an embed pass).
  trigger: string;
}

// Full outcome of one recomputeNodeBelief call.
export interface BeliefRecomputeResult {
  // New credence, or null when the node has no evidence edges (ungraded).
  beliefCredence: number | null;
  // Movement appended by this recompute, or null when nothing changed.
  movement: BeliefMovementRecord | null;
  // Per-edge effective contributions stamped during this recompute.
  contributions: BeliefEdgeContribution[];
}

// One incoming evidence edge row as read for grading, joined with the
// from-node's metadata JSON (where trustOriginKey lives).
interface EvidenceEdgeRow {
  id: number;
  // How this edge bears on its target, as one signed number in -1..+1:
  // positive supports the target, negative contradicts it.
  belief_evidence_support: number;
  from_node_metadata: string | null;
}

// Two credences within this distance count as "unchanged" — no
// belief_movements row is appended for a recompute that lands this close.
const BELIEF_CREDENCE_CHANGE_EPSILON = 1e-12;

// Extract the trustOriginKey from a node's metadata JSON; null when the
// metadata is absent, unparseable, or carries no usable key.
function readTrustOriginKeyFromMetadata(metadataJson: string | null): string | null {
  if (!metadataJson) {
    return null;
  }
  try {
    const metadata = JSON.parse(metadataJson) as { trustOriginKey?: unknown };
    return typeof metadata.trustOriginKey === 'string' && metadata.trustOriginKey.length > 0
      ? metadata.trustOriginKey
      : null;
  } catch {
    return null;
  }
}

// Recompute and persist the credence for one node:
//  - loads its incoming evidence edges (belief_evidence_support IS NOT NULL —
//    a NULL support is the one thing that makes an edge not evidence),
//  - weights each by the from-node origin's real trust score — an edge whose
//    origin has no trustOriginKey, or whose key has no belief_source_trust
//    row, is UNASSESSED and is excluded from grading entirely (no fallback
//    trust weight is invented),
//  - grades the counted (assessed) contributions via beliefGradingPolicyV1
//    and persists nodes.belief_credence + belief_computed_at,
//  - stamps belief_evidence_contribution on assessed edges only,
//  - appends a belief_movements row iff the credence actually changed.
// A node with zero counted contributions stays/becomes ungraded
// (belief_credence NULL) with no movement row and no stamps — whether that's
// because it has no evidence edges at all, or only unassessed ones.
export async function recomputeNodeBelief(nodeId: number): Promise<BeliefRecomputeResult> {
  const sqlite = getSQLiteClient();

  // All evidence edges pointing at this node, with each from-node's metadata
  // so the origin's trust weight can be resolved.
  const evidenceEdges = sqlite
    .prepare(
      `SELECT e.id, e.belief_evidence_support,
              n.metadata AS from_node_metadata
       FROM edges e
       JOIN nodes n ON n.id = e.from_node_id
       WHERE e.to_node_id = ? AND e.belief_evidence_support IS NOT NULL`
    )
    .all(nodeId) as EvidenceEdgeRow[];

  // Credence before this recompute; null when the node was ungraded.
  // Read before the loop so both the "no evidence edges" and "no assessed
  // contributions" paths can share the same post-loop NULL branch below.
  const previousBeliefRow = sqlite
    .prepare('SELECT belief_credence FROM nodes WHERE id = ?')
    .get(nodeId) as { belief_credence: number | null } | undefined;
  const previousBeliefCredence = previousBeliefRow?.belief_credence ?? null;

  // Signed effective contribution per ASSESSED edge: the edge's signed
  // support × its origin's trust weight, so the sign of the product is the
  // sign of the support. Unassessed edges (no resolvable trust score) are
  // skipped entirely — never added here, never stamped.
  const contributions: BeliefEdgeContribution[] = [];
  // Same contributions in the shape the grading policy consumes.
  const policyContributions: BeliefEvidenceContribution[] = [];
  for (const evidenceEdge of evidenceEdges) {
    const trustOriginKey = readTrustOriginKeyFromMetadata(evidenceEdge.from_node_metadata);
    // Origin trust score: only a real belief_source_trust row counts.
    const trustScore = trustOriginKey !== null ? await getTrustScore(trustOriginKey) : null;
    if (trustScore === null || trustScore === undefined) {
      // Unassessed source: not evidence. Skip — no contribution, no stamp.
      continue;
    }
    const effectiveContribution = evidenceEdge.belief_evidence_support * trustScore;
    contributions.push({ edgeId: evidenceEdge.id, effectiveContribution });
    policyContributions.push({
      edgeId: evidenceEdge.id,
      signedContribution: effectiveContribution,
    });
  }

  if (policyContributions.length === 0) {
    // Ungraded is a real state: clear any stale credence, record nothing else.
    // Reached both when there were no evidence edges at all and when every
    // edge present was unassessed.
    if (previousBeliefCredence !== null) {
      sqlite
        .prepare('UPDATE nodes SET belief_credence = NULL, belief_computed_at = NULL WHERE id = ?')
        .run(nodeId);
    }
    return { beliefCredence: null, movement: null, contributions: [] };
  }

  // The graded credence under the pinned v1 policy.
  const newBeliefCredence = beliefGradingPolicyV1.gradeBelief(policyContributions);
  // Single timestamp shared by the node stamp and any movement row.
  const computedAt = new Date().toISOString();

  sqlite
    .prepare('UPDATE nodes SET belief_credence = ?, belief_computed_at = ? WHERE id = ?')
    .run(newBeliefCredence, computedAt, nodeId);

  // Stamp each evidence edge with its signed effective contribution.
  const stampEvidenceEdge = sqlite.prepare(
    'UPDATE edges SET belief_evidence_contribution = ? WHERE id = ?'
  );
  for (const contribution of contributions) {
    stampEvidenceEdge.run(contribution.effectiveContribution, contribution.edgeId);
  }

  // Append a movement row only when the credence actually moved.
  const beliefCredenceChanged =
    previousBeliefCredence === null ||
    Math.abs(newBeliefCredence - previousBeliefCredence) > BELIEF_CREDENCE_CHANGE_EPSILON;
  let movement: BeliefMovementRecord | null = null;
  if (beliefCredenceChanged) {
    movement = {
      fromCredence: previousBeliefCredence,
      toCredence: newBeliefCredence,
      trigger: 'belief-recompute',
    };
    sqlite
      .prepare(
        `INSERT INTO belief_movements (node_id, from_credence, to_credence, "trigger", occurred_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(nodeId, previousBeliefCredence, newBeliefCredence, movement.trigger, computedAt);
  }

  return { beliefCredence: newBeliefCredence, movement, contributions };
}
