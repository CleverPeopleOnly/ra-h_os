import { NextRequest, NextResponse } from 'next/server';
import { nodeService } from '@/services/database/nodes';
import { recomputeNodeBelief } from '@/services/belief/beliefService';

export const runtime = 'nodejs';

/**
 * POST /api/belief/recompute — ask the belief engine to regrade one node.
 *
 * The endpoint both app-backed MCP doors' rah_recompute_node_belief forwards
 * to. It stands on the engine that already exists (recomputeNodeBelief), and
 * answers the credence that was actually persisted. A null credence is a REAL
 * answer, not an error: a node with no counted evidence is ungraded, and null
 * must never be coerced to 0.
 *
 * The engine itself would quietly answer "ungraded" for ANY id, so the route
 * checks existence first: a caller with a typo'd node id must not be told its
 * node is merely ungraded.
 */
export async function POST(request: NextRequest) {
  try {
    // The request body; anything unparseable is treated as an empty body and
    // refused by the node_id check below.
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const recomputedNodeId = body?.node_id;

    // A recompute that cannot name its node is refused before the engine runs.
    if (
      typeof recomputedNodeId !== 'number' ||
      !Number.isInteger(recomputedNodeId) ||
      recomputedNodeId <= 0
    ) {
      return NextResponse.json({
        success: false,
        error: 'node_id must be a positive integer naming the node whose belief_credence the engine should recompute.'
      }, { status: 400 });
    }

    // Existence check: an unknown node is an error, never an ungraded node.
    const nodeToRegrade = await nodeService.getNodeById(recomputedNodeId);
    if (!nodeToRegrade) {
      return NextResponse.json({
        success: false,
        error: `Cannot recompute belief for node #${recomputedNodeId}: no such node.`
      }, { status: 404 });
    }

    // The engine does the grading, persists the credence, stamps the counted
    // edges and appends a movement iff the credence actually moved.
    const beliefRecomputeResult = await recomputeNodeBelief(recomputedNodeId);

    // The reply carries the credence that was actually persisted — including
    // null for a node with no counted evidence, which stays ungraded.
    const summary =
      beliefRecomputeResult.beliefCredence === null
        ? `Node #${recomputedNodeId} has no counted evidence and stays ungraded.`
        : `Recomputed belief for node #${recomputedNodeId}.`;
    return NextResponse.json({
      success: true,
      node_id: recomputedNodeId,
      belief_credence: beliefRecomputeResult.beliefCredence,
      message: summary
    });
  } catch (error) {
    console.error('Error recomputing node belief:', error);

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to recompute node belief'
    }, { status: 500 });
  }
}
