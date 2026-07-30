/**
 * Belief service — recomputes a node's credence from its incoming
 * evidence edges, persists the result (nodes.belief_credence +
 * belief_computed_at), stamps each evidence edge's
 * belief_evidence_contribution, and appends a belief_movements row
 * whenever the credence actually changed.
 *
 * A source is just a node: its influence over the evidence it supplies IS its
 * own nodes.belief_credence — the same number and the same word as the belief
 * of any other node.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';
import {
  beliefGradingPolicyV1,
  type BeliefEvidenceContribution,
} from '@/services/belief/beliefGradingPolicy';

// Signed effective contribution (the source node's credence × the edge's
// unsigned support) stamped on one evidence edge during a recompute.
export interface BeliefEdgeContribution {
  // The evidence edge this contribution belongs to.
  edgeId: number;
  // The source node's credence × the edge's support; negative exactly when
  // the source's credence is negative, because credence is the only signed
  // term in the product (support is unsigned, 0..1).
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
  // New credence, or null when the node has no counted evidence (ungraded).
  beliefCredence: number | null;
  // Movement appended by this recompute, or null when nothing changed.
  movement: BeliefMovementRecord | null;
  // Per-edge effective contributions stamped during this recompute.
  contributions: BeliefEdgeContribution[];
}

// One incoming evidence edge row as read for grading, joined with the
// from-node's own credence — the weight the edge's evidence carries.
interface EvidenceEdgeRow {
  id: number;
  // How strongly the source node talks about the target, unsigned 0..1.
  // Which way the evidence cuts comes from the source node's credence,
  // never from this number.
  belief_evidence_support: number;
  // The source node's own credence; NULL when nobody has graded that node.
  from_node_belief_credence: number | null;
}

// The belief state a recompute finds on its target before writing anything:
// the credence the node currently holds, and whether a human asserted that
// credence by hand (in which case the recompute leaves it alone).
interface BeliefStateRowBeforeRecompute {
  belief_credence: number | null;
  belief_credence_is_fixed: number;
}

// Two credences within this distance count as "unchanged" — no
// belief_movements row is appended for a recompute that lands this close.
const BELIEF_CREDENCE_CHANGE_EPSILON = 1e-12;

// Recompute and persist the credence for one node:
//  - a node whose belief_credence_is_fixed is set has its credence ASSERTED by
//    a human rather than derived from the graph, so it is returned untouched:
//    nothing is written, nothing is stamped and nothing is logged,
//  - otherwise it loads the node's incoming evidence edges
//    (belief_evidence_support IS NOT NULL — a NULL support is the one thing
//    that makes an edge not evidence),
//  - weights each by its FROM-node's own belief_credence: a source nobody has
//    graded (credence NULL) casts no vote and its edge is skipped, but every
//    graded source is COUNTED — a disbelieved source (credence < 0)
//    contributes negatively (its evidence counts against what it talks
//    about), and a source at credence exactly 0 casts a counted vote of zero,
//  - grades the counted contributions via beliefGradingPolicyV1 and persists
//    nodes.belief_credence + belief_computed_at,
//  - stamps belief_evidence_contribution on counted edges and clears it back
//    to NULL on skipped ones, because a stamp written when the source was
//    still graded is wrong once its credence has been cleared,
//  - appends a belief_movements row iff the credence actually changed.
// A node with zero counted contributions stays/becomes ungraded
// (belief_credence NULL) with no movement row — whether that is because it
// has no evidence edges at all, or only edges from never-graded sources. A
// node whose counted edges all contribute 0 grades to 0 (the formula gives
// exactly that for S = 0, C = 0), which is a real graded state, not NULL.
export async function recomputeNodeBelief(nodeId: number): Promise<BeliefRecomputeResult> {
  const sqlite = getSQLiteClient();

  // Belief state of the node before this recompute: the credence it currently
  // holds, and whether that credence was asserted by a human.
  const nodeBeliefStateRow = sqlite
    .prepare('SELECT belief_credence, belief_credence_is_fixed FROM nodes WHERE id = ?')
    .get(nodeId) as BeliefStateRowBeforeRecompute | undefined;
  const previousBeliefCredence = nodeBeliefStateRow?.belief_credence ?? null;

  // An asserted credence is not derived from the graph, so a recompute is a
  // no-op on it: the stored credence is reported back and nothing is written —
  // not the credence, not the timestamp, no stamps on its incoming edges.
  if (nodeBeliefStateRow?.belief_credence_is_fixed) {
    return { beliefCredence: previousBeliefCredence, movement: null, contributions: [] };
  }

  // All evidence edges pointing at this node, each carrying its source node's
  // own credence — the weight that edge's evidence gets.
  const evidenceEdges = sqlite
    .prepare(
      `SELECT e.id, e.belief_evidence_support,
              n.belief_credence AS from_node_belief_credence
       FROM edges e
       JOIN nodes n ON n.id = e.from_node_id
       WHERE e.to_node_id = ? AND e.belief_evidence_support IS NOT NULL`
    )
    .all(nodeId) as EvidenceEdgeRow[];

  // Signed effective contribution per COUNTED edge: the source node's signed
  // credence × the edge's unsigned support, so the sign of the product is the
  // sign of the source's credence.
  const contributions: BeliefEdgeContribution[] = [];
  // Same contributions in the shape the grading policy consumes.
  const policyContributions: BeliefEvidenceContribution[] = [];
  // Edges that cast no vote this time round and must therefore carry no
  // contribution stamp, so an earlier recompute's stamp is cleared.
  const skippedEvidenceEdgeIds: number[] = [];
  for (const evidenceEdge of evidenceEdges) {
    if (evidenceEdge.from_node_belief_credence === null) {
      // The source has never been graded, so it says nothing about anything.
      skippedEvidenceEdgeIds.push(evidenceEdge.id);
      continue;
    }
    // Every graded source is counted — including a disbelieved one, whose
    // negative credence makes its contribution count AGAINST the target, and
    // a zero-credence one, whose counted contribution is exactly 0.
    const effectiveContribution =
      evidenceEdge.from_node_belief_credence * evidenceEdge.belief_evidence_support;
    contributions.push({ edgeId: evidenceEdge.id, effectiveContribution });
    policyContributions.push({
      edgeId: evidenceEdge.id,
      signedContribution: effectiveContribution,
    });
  }

  // Writes belief_evidence_contribution on one edge (a number for a counted
  // edge, NULL for a skipped one).
  const stampEvidenceEdge = sqlite.prepare(
    'UPDATE edges SET belief_evidence_contribution = ? WHERE id = ?'
  );
  for (const skippedEvidenceEdgeId of skippedEvidenceEdgeIds) {
    stampEvidenceEdge.run(null, skippedEvidenceEdgeId);
  }

  if (policyContributions.length === 0) {
    // Ungraded is a real state: clear any stale credence, record nothing else.
    // Reached both when there were no evidence edges at all and when every
    // edge present came from a never-graded (credence NULL) source.
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

  // Stamp each counted evidence edge with its signed effective contribution.
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
