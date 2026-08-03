import { NextRequest, NextResponse } from 'next/server';
import { clearBeliefFixedCredence } from '@/services/belief/beliefFixedCredence';

export const runtime = 'nodejs';

/**
 * POST /api/belief/fixed-credence/clear — withdraw one node's asserted
 * credence (the v2 un-fix door, docs/belief-model-subjective-logic.md §2).
 *
 * The endpoint both app-backed MCP doors' rah_clear_belief_fixed_credence
 * forwards to. It clears belief_credence_is_fixed and immediately regrades
 * the node from its actual evidence (movement trigger
 * 'belief-fixed-credence-cleared'), sweeping the change through the node's
 * outgoing evidence. The reply's belief_credence is nullable: a node whose
 * evidence leaves it ungraded answers null — a real outcome, never an error,
 * and never coerced to 0.
 */
export async function POST(request: NextRequest) {
  try {
    // The request body; anything unparseable is treated as an empty body and
    // refused by the node_id check below.
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const clearedNodeId = body?.node_id;

    // A clear that cannot name its node withdraws nothing.
    if (
      typeof clearedNodeId !== 'number' ||
      !Number.isInteger(clearedNodeId) ||
      clearedNodeId <= 0
    ) {
      return NextResponse.json({
        success: false,
        error: 'node_id must be a positive integer naming the node whose asserted credence is being withdrawn.'
      }, { status: 400 });
    }

    // The write itself: flag cleared, node regraded from its actual evidence,
    // movement logged iff the credence moved. null back means no such node.
    const fixedCredenceClearance = await clearBeliefFixedCredence(clearedNodeId);
    if (fixedCredenceClearance === null) {
      return NextResponse.json({
        success: false,
        error: `Cannot withdraw the asserted credence of node #${clearedNodeId}: no such node.`
      }, { status: 404 });
    }

    // The reply mirrors the set endpoint's shape, signs flipped by the door's
    // meaning: the flag is 0 and the credence is whatever the regrade landed
    // on — including null for a now-ungraded node.
    const summary =
      fixedCredenceClearance.beliefCredence === null
        ? `Withdrew the asserted credence of node #${clearedNodeId}; it has no counted evidence and is now ungraded.`
        : `Withdrew the asserted credence of node #${clearedNodeId}; the engine regraded it from its evidence.`;
    return NextResponse.json({
      success: true,
      node_id: clearedNodeId,
      belief_credence: fixedCredenceClearance.beliefCredence,
      belief_credence_is_fixed: 0,
      message: summary
    });
  } catch (error) {
    console.error('Error clearing fixed belief credence:', error);

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to clear fixed belief credence'
    }, { status: 500 });
  }
}
