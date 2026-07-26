/**
 * Belief service — recomputes a node's belief value from its incoming
 * evidence edges, persists the result (nodes.belief_value +
 * belief_computed_at), stamps each evidence edge's
 * evidence_effective_contribution, and appends a belief_movements row
 * whenever the value actually changed.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';
import {
  DEFAULT_ORIGIN_TRUST,
  beliefGradingPolicyV1,
  type EvidenceContribution,
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
  evidence_direction: string;
  evidence_strength: number;
  evidence_origin_key: string | null;
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
//  - loads its incoming evidence edges (evidence_direction IS NOT NULL),
//  - weights each by the from-node origin's trust score (DEFAULT_ORIGIN_TRUST
//    when the origin is unknown),
//  - grades via beliefGradingPolicyV1 and persists nodes.belief_value +
//    belief_computed_at,
//  - stamps each edge's evidence_effective_contribution,
//  - appends a belief_movements row iff the value actually changed.
// A node with zero evidence edges stays/becomes ungraded (belief_value NULL)
// with no movement row and no stamps.
export async function recomputeNodeBelief(nodeId: number): Promise<BeliefRecomputeResult> {
  const sqlite = getSQLiteClient();

  // All evidence edges pointing at this node, with each from-node's metadata
  // so the origin's trust weight can be resolved.
  const evidenceEdges = sqlite
    .prepare(
      `SELECT e.id, e.evidence_direction, e.evidence_strength, e.evidence_origin_key,
              n.metadata AS from_node_metadata
       FROM edges e
       JOIN nodes n ON n.id = e.from_node_id
       WHERE e.to_node_id = ? AND e.evidence_direction IS NOT NULL`
    )
    .all(nodeId) as EvidenceEdgeRow[];

  // Belief value before this recompute; null when the node was ungraded.
  const previousBeliefRow = sqlite
    .prepare('SELECT belief_value FROM nodes WHERE id = ?')
    .get(nodeId) as { belief_value: number | null } | undefined;
  const previousBeliefValue = previousBeliefRow?.belief_value ?? null;

  if (evidenceEdges.length === 0) {
    // Ungraded is a real state: clear any stale value, record nothing else.
    if (previousBeliefValue !== null) {
      sqlite
        .prepare('UPDATE nodes SET belief_value = NULL, belief_computed_at = NULL WHERE id = ?')
        .run(nodeId);
    }
    return { beliefValue: null, movement: null, contributions: [] };
  }

  // Signed effective contribution per edge: strength × origin trust weight,
  // negative for 'against' evidence.
  const contributions: BeliefEdgeContribution[] = [];
  // Same contributions in the shape the grading policy consumes.
  const policyContributions: EvidenceContribution[] = [];
  for (const evidenceEdge of evidenceEdges) {
    const trustOriginKey = readTrustOriginKeyFromMetadata(evidenceEdge.from_node_metadata);
    // Origin trust weight: source_trust score when known, else the default.
    const trustWeight =
      (trustOriginKey !== null ? await getTrustScore(trustOriginKey) : null) ??
      DEFAULT_ORIGIN_TRUST;
    const directionSign = evidenceEdge.evidence_direction === 'against' ? -1 : 1;
    const effectiveContribution = directionSign * evidenceEdge.evidence_strength * trustWeight;
    contributions.push({ edgeId: evidenceEdge.id, effectiveContribution });
    policyContributions.push({
      edgeId: evidenceEdge.id,
      signedContribution: effectiveContribution,
      evidenceOriginKey: evidenceEdge.evidence_origin_key,
    });
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
    'UPDATE edges SET evidence_effective_contribution = ? WHERE id = ?'
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
