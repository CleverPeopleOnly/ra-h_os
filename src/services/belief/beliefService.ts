/**
 * Belief service — regrades a node's belief from its evidence basis and
 * SWEEPS the change forward (docs/belief-model-subjective-logic.md §2–§5,
 * direction per the §8 canon amendment).
 *
 * An evidence edge runs in RA-H's canonical direction, Derivative→Source: the
 * derived node points at the node it derives from ("my credence derives from
 * you"). A node's evidence basis is therefore its OUTGOING support-bearing
 * edges, and each edge's source credence is read from the edge's TARGET.
 *
 * A regrade persists the node's two evidence masses
 * (nodes.belief_evidence_for_mass / belief_evidence_against_mass), the cached
 * credence projection (nodes.belief_credence + belief_computed_at), stamps
 * each evidence edge's belief_evidence_contribution, and appends a
 * belief_movements row whenever the credence actually changed. When a
 * regraded node's projection moves by more than
 * BELIEF_CREDENCE_CHANGE_EPSILON, every node DERIVING FROM it — the from-ends
 * of its INCOMING support-bearing edges — is regraded in the same sweep
 * (movement trigger 'propagation'), with a visited set so each node regrades
 * at most once per sweep — the echo guard that terminates cycles. The whole
 * sweep runs inside ONE better-sqlite3 transaction, so a failure mid-way
 * leaves no partial writes behind.
 *
 * A source is just a node: its influence over the evidence it supplies IS its
 * own nodes.belief_credence — the same number and the same word as the belief
 * of any other node.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';
import type { SQLiteClient } from '@/services/database/sqlite-client';
import {
  accumulateBeliefEvidenceMasses,
  beliefGradingPolicyV2,
  type BeliefEvidenceContribution,
} from '@/services/belief/beliefGradingPolicy';

// The actual cause of a movement, one value per entry point (spec §5). The v1
// constant is retired: the log must answer WHY a credence moved.
export type BeliefMovementTrigger =
  | 'evidence-edge-write'
  | 'embed-grade'
  | 'recovery-sweep'
  | 'propagation'
  | 'mcp-recompute'
  | 'belief-fixed-credence-set'
  | 'belief-fixed-credence-cleared'
  | 'model-migration';

// Signed effective contribution (the source node's credence × the edge's
// unsigned support) stamped on one evidence edge during a regrade.
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
  // Credence before the regrade; null when the node was previously ungraded.
  fromCredence: number | null;
  // Credence after the regrade.
  toCredence: number;
  // The entry point that caused the regrade (spec §5).
  trigger: string;
}

// Full outcome of one recomputeNodeBelief call, reported for the ROOT node of
// the sweep (downstream propagation regrades log their own movements).
export interface BeliefRecomputeResult {
  // New credence, or null when the node has no counted evidence (ungraded).
  beliefCredence: number | null;
  // Movement appended for the root node, or null when nothing changed.
  movement: BeliefMovementRecord | null;
  // Per-edge effective contributions stamped during the root regrade.
  contributions: BeliefEdgeContribution[];
}

// One evidence edge row of a node's basis as read for grading — an OUTGOING
// support-bearing edge (canon: Derivative→Source), joined with the source
// node's own credence read from the edge's TARGET — the weight the edge's
// evidence carries.
interface EvidenceEdgeRow {
  id: number;
  // How strongly the source node talks about the derived node, unsigned
  // 0..1. Which way the evidence cuts comes from the source node's credence,
  // never from this number.
  belief_evidence_support: number;
  // The source node's own credence (the edge's to-node under canon); NULL
  // when nobody has graded that node.
  source_node_belief_credence: number | null;
}

// The belief state a regrade finds on the node it grades before writing
// anything:
// the credence the node currently holds, and whether a human asserted that
// credence by hand (in which case the regrade leaves it alone).
interface BeliefStateRowBeforeRecompute {
  belief_credence: number | null;
  belief_credence_is_fixed: number;
}

// Two credences within this distance count as "unchanged": no movement row is
// appended, and the sweep does not propagate onward (spec §4 step 3).
export const BELIEF_CREDENCE_CHANGE_EPSILON = 1e-12;

// True when a node's projection moved between two regrades: a transition into
// or out of the ungraded state (NULL) is always a move, and two numbers count
// as moved only beyond the epsilon gate.
function beliefCredenceMoved(
  previousBeliefCredence: number | null,
  newBeliefCredence: number | null
): boolean {
  if ((previousBeliefCredence === null) !== (newBeliefCredence === null)) {
    return true;
  }
  if (previousBeliefCredence === null || newBeliefCredence === null) {
    return false;
  }
  return Math.abs(newBeliefCredence - previousBeliefCredence) > BELIEF_CREDENCE_CHANGE_EPSILON;
}

// What one single-node regrade inside a sweep found and wrote.
interface BeliefNodeRegradeOutcome {
  // Credence before the regrade, as stored.
  previousBeliefCredence: number | null;
  // Credence after the regrade (null = ungraded).
  newBeliefCredence: number | null;
  // Movement appended for this node, or null when nothing changed (an
  // ungraded outcome is never a movement: to_credence is NOT NULL).
  movement: BeliefMovementRecord | null;
  // Per-edge effective contributions stamped during this regrade.
  contributions: BeliefEdgeContribution[];
  // False when the node's credence is human-asserted (fixed): nothing was
  // read, written or logged, and the sweep must not propagate from it.
  regraded: boolean;
}

// Regrade exactly one node from its evidence basis — the single-node core
// of every sweep. Must run inside the sweep's transaction:
//  - a node whose belief_credence_is_fixed is set has its credence ASSERTED
//    by a human, so it is returned untouched: nothing written, nothing
//    stamped, nothing logged,
//  - otherwise its OUTGOING evidence edges (belief_evidence_support IS NOT
//    NULL — a NULL support is the one thing that makes an edge not evidence)
//    are weighted by their TO-node's own belief_credence — the source each
//    edge derives from under canon: a source nobody has graded (credence
//    NULL) casts no vote and its edge's stamp clears, but every graded
//    source is COUNTED — a disbelieved source contributes negatively and a
//    zero-credence source casts a counted vote of zero,
//  - zero COUNTED contributions leaves the node NEVER ASSESSED: credence,
//    timestamp and both masses cleared to NULL (§3 row 7, the service half),
//  - otherwise the contributions accumulate into the two evidence masses,
//    both masses are persisted beside the cached credence projection, counted
//    edges are stamped, and a movement is appended iff the credence moved.
function regradeOneBeliefNodeLocked(
  sqlite: SQLiteClient,
  nodeId: number,
  movementTrigger: BeliefMovementTrigger
): BeliefNodeRegradeOutcome {
  // Belief state of the node before this regrade: the credence it currently
  // holds, and whether that credence was asserted by a human.
  const nodeBeliefStateRow = sqlite
    .prepare('SELECT belief_credence, belief_credence_is_fixed FROM nodes WHERE id = ?')
    .get(nodeId) as BeliefStateRowBeforeRecompute | undefined;
  const previousBeliefCredence = nodeBeliefStateRow?.belief_credence ?? null;

  // An asserted credence is not derived from the graph, so a regrade is a
  // no-op on it: the stored credence is reported back and nothing is written.
  if (nodeBeliefStateRow?.belief_credence_is_fixed) {
    return {
      previousBeliefCredence,
      newBeliefCredence: previousBeliefCredence,
      movement: null,
      contributions: [],
      regraded: false,
    };
  }

  // The node's evidence basis: its outgoing support-bearing edges (canon:
  // the derived node points at its sources), each carrying its source node's
  // own credence — the weight that edge's evidence gets.
  const evidenceEdges = sqlite
    .prepare(
      `SELECT e.id, e.belief_evidence_support,
              n.belief_credence AS source_node_belief_credence
       FROM edges e
       JOIN nodes n ON n.id = e.to_node_id
       WHERE e.from_node_id = ? AND e.belief_evidence_support IS NOT NULL`
    )
    .all(nodeId) as EvidenceEdgeRow[];

  // Signed effective contribution per COUNTED edge: the source node's signed
  // credence × the edge's unsigned support, so the sign of the product is the
  // sign of the source's credence.
  const contributions: BeliefEdgeContribution[] = [];
  // Same contributions in the shape the grading policy consumes.
  const policyContributions: BeliefEvidenceContribution[] = [];
  // Edges that cast no vote this time round and must therefore carry no
  // contribution stamp, so an earlier regrade's stamp is cleared.
  const skippedEvidenceEdgeIds: number[] = [];
  for (const evidenceEdge of evidenceEdges) {
    if (evidenceEdge.source_node_belief_credence === null) {
      // The source has never been graded, so it says nothing about anything.
      skippedEvidenceEdgeIds.push(evidenceEdge.id);
      continue;
    }
    // Every graded source is counted — including a disbelieved one, whose
    // negative credence makes its contribution count AGAINST the derived
    // node, and a zero-credence one, whose counted contribution is exactly 0.
    const effectiveContribution =
      evidenceEdge.source_node_belief_credence * evidenceEdge.belief_evidence_support;
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
    // Never assessed is a real state (§3 row 7): credence, timestamp and BOTH
    // masses cleared to NULL together — the masses move as a pair, never one
    // at a time. Reached both when there were no evidence edges at all and
    // when every edge present came from a never-graded source. No movement:
    // an ungraded outcome has no to_credence to record.
    sqlite
      .prepare(
        `UPDATE nodes
            SET belief_credence = NULL, belief_computed_at = NULL,
                belief_evidence_for_mass = NULL, belief_evidence_against_mass = NULL
          WHERE id = ?`
      )
      .run(nodeId);
    return {
      previousBeliefCredence,
      newBeliefCredence: null,
      movement: null,
      contributions: [],
      regraded: true,
    };
  }

  // The two unsigned evidence masses the counted contributions accumulate to
  // (spec §2: split by sign), and the cached credence the pinned v2 policy
  // grades them to — the same projection of the same masses, taken through
  // the policy door so the service/policy boundary stays the graded one.
  const evidenceMasses = accumulateBeliefEvidenceMasses(policyContributions);
  const newBeliefCredence = beliefGradingPolicyV2.gradeBelief(policyContributions);
  // Single timestamp shared by the node stamp and any movement row.
  const computedAt = new Date().toISOString();

  sqlite
    .prepare(
      `UPDATE nodes
          SET belief_credence = ?, belief_computed_at = ?,
              belief_evidence_for_mass = ?, belief_evidence_against_mass = ?
        WHERE id = ?`
    )
    .run(
      newBeliefCredence,
      computedAt,
      evidenceMasses.beliefEvidenceForMass,
      evidenceMasses.beliefEvidenceAgainstMass,
      nodeId
    );

  // Stamp each counted evidence edge with its signed effective contribution.
  for (const contribution of contributions) {
    stampEvidenceEdge.run(contribution.effectiveContribution, contribution.edgeId);
  }

  // Append a movement row only when the credence actually moved, naming the
  // entry point that caused it (spec §5).
  let movement: BeliefMovementRecord | null = null;
  if (beliefCredenceMoved(previousBeliefCredence, newBeliefCredence)) {
    movement = {
      fromCredence: previousBeliefCredence,
      toCredence: newBeliefCredence,
      trigger: movementTrigger,
    };
    sqlite
      .prepare(
        `INSERT INTO belief_movements (node_id, from_credence, to_credence, "trigger", occurred_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(nodeId, previousBeliefCredence, newBeliefCredence, movementTrigger, computedAt);
  }

  return {
    previousBeliefCredence,
    newBeliefCredence,
    movement,
    contributions,
    regraded: true,
  };
}

// One node waiting in a sweep's queue, with the movement trigger its regrade
// must log (the root carries the entry point's trigger; every downstream
// regrade is 'propagation').
interface BeliefSweepQueueEntry {
  nodeId: number;
  movementTrigger: BeliefMovementTrigger;
}

// Enqueue every node DERIVING FROM one node for regrade — the from-ends of
// its INCOMING support-bearing edges (canon: a derived node points at its
// source) — the propagation step of spec §4.
function enqueueNodesDerivingFromLocked(
  sqlite: SQLiteClient,
  sourceNodeId: number,
  sweepQueue: BeliefSweepQueueEntry[]
): void {
  // Distinct from-ends of the node's incoming evidence edges; a NULL support
  // means the edge is not evidence, so it carries nothing forward.
  const derivingNodeRows = sqlite
    .prepare(
      `SELECT DISTINCT from_node_id AS node_id
       FROM edges
       WHERE to_node_id = ? AND belief_evidence_support IS NOT NULL
       ORDER BY from_node_id ASC`
    )
    .all(sourceNodeId) as Array<{ node_id: number }>;
  for (const derivingNodeRow of derivingNodeRows) {
    sweepQueue.push({
      nodeId: derivingNodeRow.node_id,
      movementTrigger: 'propagation',
    });
  }
}

// Drain one sweep queue with a visited set: each node regrades AT MOST ONCE
// per sweep (the echo guard — a visited node is never re-entered, so cycles
// terminate), a fixed node is never regraded and never propagated FROM inside
// a sweep (spec §4 point 5: the nodes deriving from it enqueue only on
// set/clear-fixed, which the fixed-credence module drives directly), and a
// node whose projection moved enqueues the nodes deriving from it. Returns
// the root node's outcome. Must run inside one transaction.
function drainBeliefSweepQueueLocked(
  sqlite: SQLiteClient,
  sweepQueue: BeliefSweepQueueEntry[],
  visitedNodeIds: Set<number>
): BeliefNodeRegradeOutcome | null {
  // The first entry's outcome — the root of the sweep, reported to callers.
  let rootRegradeOutcome: BeliefNodeRegradeOutcome | null = null;
  while (sweepQueue.length > 0) {
    const sweepQueueEntry = sweepQueue.shift() as BeliefSweepQueueEntry;
    if (visitedNodeIds.has(sweepQueueEntry.nodeId)) {
      continue;
    }
    visitedNodeIds.add(sweepQueueEntry.nodeId);

    const regradeOutcome = regradeOneBeliefNodeLocked(
      sqlite,
      sweepQueueEntry.nodeId,
      sweepQueueEntry.movementTrigger
    );
    if (rootRegradeOutcome === null) {
      rootRegradeOutcome = regradeOutcome;
    }
    // A fixed node in the sweep's path is a wall, not a relay: never regraded
    // and never propagated from here.
    if (!regradeOutcome.regraded) {
      continue;
    }
    // The epsilon gate of spec §4 step 3: only a projection that actually
    // moved pushes the sweep onward.
    if (
      beliefCredenceMoved(regradeOutcome.previousBeliefCredence, regradeOutcome.newBeliefCredence)
    ) {
      enqueueNodesDerivingFromLocked(sqlite, sweepQueueEntry.nodeId, sweepQueue);
    }
  }
  return rootRegradeOutcome;
}

// Recompute one node's belief from its evidence basis (its outgoing
// support-bearing edges) and sweep the change through the nodes deriving
// from it (spec §4), all inside one better-sqlite3 transaction.
// movementTrigger names the entry point for the root regrade's movement row;
// downstream regrades log 'propagation'. Defaults to 'mcp-recompute' — the
// engine door the app's recompute endpoint forwards to.
export async function recomputeNodeBelief(
  nodeId: number,
  movementTrigger: BeliefMovementTrigger = 'mcp-recompute'
): Promise<BeliefRecomputeResult> {
  const sqlite = getSQLiteClient();

  // The whole sweep — every node write, edge stamp and movement row — commits
  // or rolls back as one unit (spec §4, fixing the bare multi-write audit
  // finding).
  const rootRegradeOutcome = sqlite.transaction(() =>
    drainBeliefSweepQueueLocked(sqlite, [{ nodeId, movementTrigger }], new Set<number>())
  );

  return {
    beliefCredence: rootRegradeOutcome?.newBeliefCredence ?? null,
    movement: rootRegradeOutcome?.movement ?? null,
    contributions: rootRegradeOutcome?.contributions ?? [],
  };
}

// Sweep FROM a source node without regrading the node itself: regrade every
// node DERIVING FROM it — the from-ends of its incoming support-bearing
// edges — and onward per spec §4, in one transaction. This is how a fixed
// node's projection change reaches the nodes deriving from it —
// set/clear-fixed are the only writes that move a fixed node's projection
// (spec §4 point 5), so the fixed-credence module calls this after such a
// write. Synchronous, because setBeliefFixedCredence is.
export function propagateBeliefFromSourceNode(sourceNodeId: number): void {
  const sqlite = getSQLiteClient();
  sqlite.transaction(() => {
    // The source itself is pre-visited: its credence was just written by the
    // caller and must not be regraded by its own sweep.
    const visitedNodeIds = new Set<number>([sourceNodeId]);
    const sweepQueue: BeliefSweepQueueEntry[] = [];
    enqueueNodesDerivingFromLocked(sqlite, sourceNodeId, sweepQueue);
    drainBeliefSweepQueueLocked(sqlite, sweepQueue, visitedNodeIds);
  });
}
