/**
 * Belief service — recomputes a node's belief value from its incoming
 * evidence edges, persists the result (nodes.belief_value +
 * belief_computed_at), stamps each evidence edge's
 * belief_evidence_contribution, and appends a belief_movements row
 * whenever the value actually changed.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';
import {
  beliefGradingPolicyV1,
  type BeliefEvidenceContribution,
} from '@/services/belief/beliefGradingPolicy';
import { getTrustScore } from '@/services/belief/sourceTrustService';

// Signed effective contribution (strength × trustWeight) stamped on one
// evidence edge during a recompute.
export interface BeliefEdgeContribution {
  // The evidence edge this contribution belongs to.
  edgeId: number;
  // strength × trustWeight, negative for 'against' evidence edges.
  effectiveContribution: number;
}

// One recorded change of a node's belief value.
export interface BeliefMovementRecord {
  // Value before the recompute; null when the node was previously ungraded.
  fromValue: number | null;
  // Value after the recompute.
  toValue: number;
  // What caused the recompute (e.g. an edge insert or an embed pass).
  trigger: string;
}

// Full outcome of one recomputeNodeBelief call.
export interface BeliefRecomputeResult {
  // New belief value, or null when the node has no evidence edges (ungraded).
  beliefValue: number | null;
  // Movement appended by this recompute, or null when nothing changed.
  movement: BeliefMovementRecord | null;
  // Per-edge effective contributions stamped during this recompute.
  contributions: BeliefEdgeContribution[];
}

// One incoming evidence edge row as read for grading, joined with the
// from-node's metadata JSON (where trustOriginKey lives).
interface EvidenceEdgeRow {
  id: number;
  belief_evidence_direction: string;
  belief_evidence_strength: number;
  belief_evidence_origin_key: string | null;
  from_node_metadata: string | null;
}

// Two belief values within this distance count as "unchanged" — no
// belief_movements row is appended for a recompute that lands this close.
const BELIEF_CHANGE_EPSILON = 1e-12;

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

// Recompute and persist the belief value for one node:
//  - loads its incoming evidence edges (belief_evidence_direction IS NOT NULL),
//  - weights each by the from-node origin's real trust score — an edge whose
//    origin has no trustOriginKey, or whose key has no belief_source_trust
//    row, is UNASSESSED and is excluded from grading entirely (no fallback
//    trust weight is invented),
//  - grades the counted (assessed) contributions via beliefGradingPolicyV1
//    and persists nodes.belief_value + belief_computed_at,
//  - stamps belief_evidence_contribution on assessed edges only,
//  - appends a belief_movements row iff the value actually changed.
// A node with zero counted contributions stays/becomes ungraded
// (belief_value NULL) with no movement row and no stamps — whether that's
// because it has no evidence edges at all, or only unassessed ones.
export async function recomputeNodeBelief(nodeId: number): Promise<BeliefRecomputeResult> {
  const sqlite = getSQLiteClient();

  // All evidence edges pointing at this node, with each from-node's metadata
  // so the origin's trust weight can be resolved.
  const evidenceEdges = sqlite
    .prepare(
      `SELECT e.id, e.belief_evidence_direction, e.belief_evidence_strength, e.belief_evidence_origin_key,
              n.metadata AS from_node_metadata
       FROM edges e
       JOIN nodes n ON n.id = e.from_node_id
       WHERE e.to_node_id = ? AND e.belief_evidence_direction IS NOT NULL`
    )
    .all(nodeId) as EvidenceEdgeRow[];

  // Belief value before this recompute; null when the node was ungraded.
  // Read before the loop so both the "no evidence edges" and "no assessed
  // contributions" paths can share the same post-loop NULL branch below.
  const previousBeliefRow = sqlite
    .prepare('SELECT belief_value FROM nodes WHERE id = ?')
    .get(nodeId) as { belief_value: number | null } | undefined;
  const previousBeliefValue = previousBeliefRow?.belief_value ?? null;

  // Signed effective contribution per ASSESSED edge: strength × origin trust
  // weight, negative for 'against' evidence. Unassessed edges (no resolvable
  // trust score) are skipped entirely — never added here, never stamped.
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
    const directionSign = evidenceEdge.belief_evidence_direction === 'against' ? -1 : 1;
    const effectiveContribution = directionSign * evidenceEdge.belief_evidence_strength * trustScore;
    contributions.push({ edgeId: evidenceEdge.id, effectiveContribution });
    policyContributions.push({
      edgeId: evidenceEdge.id,
      signedContribution: effectiveContribution,
      beliefEvidenceOriginKey: evidenceEdge.belief_evidence_origin_key,
    });
  }

  if (policyContributions.length === 0) {
    // Ungraded is a real state: clear any stale value, record nothing else.
    // Reached both when there were no evidence edges at all and when every
    // edge present was unassessed.
    if (previousBeliefValue !== null) {
      sqlite
        .prepare('UPDATE nodes SET belief_value = NULL, belief_computed_at = NULL WHERE id = ?')
        .run(nodeId);
    }
    return { beliefValue: null, movement: null, contributions: [] };
  }

  // The graded belief value under the pinned v1 policy.
  const newBeliefValue = beliefGradingPolicyV1.gradeBelief(policyContributions);
  // Single timestamp shared by the node stamp and any movement row.
  const computedAt = new Date().toISOString();

  sqlite
    .prepare('UPDATE nodes SET belief_value = ?, belief_computed_at = ? WHERE id = ?')
    .run(newBeliefValue, computedAt, nodeId);

  // Stamp each evidence edge with its signed effective contribution.
  const stampEvidenceEdge = sqlite.prepare(
    'UPDATE edges SET belief_evidence_contribution = ? WHERE id = ?'
  );
  for (const contribution of contributions) {
    stampEvidenceEdge.run(contribution.effectiveContribution, contribution.edgeId);
  }

  // Append a movement row only when the value actually moved.
  const beliefValueChanged =
    previousBeliefValue === null ||
    Math.abs(newBeliefValue - previousBeliefValue) > BELIEF_CHANGE_EPSILON;
  let movement: BeliefMovementRecord | null = null;
  if (beliefValueChanged) {
    movement = {
      fromValue: previousBeliefValue,
      toValue: newBeliefValue,
      trigger: 'belief-recompute',
    };
    sqlite
      .prepare(
        `INSERT INTO belief_movements (node_id, from_value, to_value, "trigger", occurred_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(nodeId, previousBeliefValue, newBeliefValue, movement.trigger, computedAt);
  }

  return { beliefValue: newBeliefValue, movement, contributions };
}
