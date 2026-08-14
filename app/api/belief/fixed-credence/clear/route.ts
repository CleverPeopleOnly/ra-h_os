import { NextRequest, NextResponse } from 'next/server';
import { clearBeliefFixedCredence } from '@/services/belief/beliefFixedCredence';

export const runtime = 'nodejs';

/**
 * POST /api/belief/fixed-credence/clear — withdraw one node's asserted
 * credence (the un-fix door).
 *
 * The endpoint both app-backed MCP doors' rah_clear_belief_fixed_credence
 * forwards to. It clears belief_credence_is_fixed and writes the three
 * display columns to NULL directly — no engine runs (samai owns the belief
 * engine since the storage split), so the node is never-assessed until samai
 * next writes its display belief. The reply's belief_credence is nullable:
 * null is a real outcome, never an error, and never coerced to 0.
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

    // The write itself: flag cleared and the display columns NULLed together,
    // with no movement logged. null back means no such node.
    const fixedCredenceClearance = await clearBeliefFixedCredence(clearedNodeId);
    if (fixedCredenceClearance === null) {
      return NextResponse.json({
        success: false,
        error: `Cannot withdraw the asserted credence of node #${clearedNodeId}: no such node.`
      }, { status: 404 });
    }

    // The reply mirrors the set endpoint's shape, signs flipped by the door's
    // meaning: the flag is 0 and the credence is null — never-assessed.
    const summary = `Withdrew the asserted credence of node #${clearedNodeId}; it is now ungraded until samai next writes its display belief.`;
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
