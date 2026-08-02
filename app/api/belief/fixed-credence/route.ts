import { NextRequest, NextResponse } from 'next/server';
import { setBeliefFixedCredence } from '@/services/belief/beliefFixedCredence';

export const runtime = 'nodejs';

/**
 * POST /api/belief/fixed-credence — assert one node's credence by hand.
 *
 * The app-side twin of the standalone MCP door's setBeliefFixedCredence, and
 * the endpoint both app-backed MCP doors' rah_set_belief_fixed_credence
 * forwards to. The doors' schemas already refuse an out-of-interval credence,
 * but the app is a public surface of its own and must not rely on a
 * well-behaved caller — so the open interval (-1, +1) is enforced here too:
 * ±1 would claim total certainty, which is not expressible.
 */
export async function POST(request: NextRequest) {
  try {
    // The request body; anything unparseable is treated as an empty body and
    // refused by the field checks below.
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const assertedNodeId = body?.node_id;
    const assertedBeliefCredence = body?.belief_credence;

    // A body that cannot name its node asserts about nothing.
    if (
      typeof assertedNodeId !== 'number' ||
      !Number.isInteger(assertedNodeId) ||
      assertedNodeId <= 0
    ) {
      return NextResponse.json({
        success: false,
        error: 'node_id must be a positive integer naming the node whose credence is being asserted.'
      }, { status: 400 });
    }

    // The credence must be a real number strictly inside the open interval.
    // The number test comes first and separately: a value that is not a number
    // cannot be in range, and no range comparison catches NaN — and a numeric
    // string must never be coerced into a credence.
    if (
      typeof assertedBeliefCredence !== 'number' ||
      !Number.isFinite(assertedBeliefCredence) ||
      assertedBeliefCredence <= -1 ||
      assertedBeliefCredence >= 1
    ) {
      return NextResponse.json({
        success: false,
        error:
          `belief_credence must be a number strictly between -1 and +1 (got ${String(assertedBeliefCredence)}). ` +
          '-1 and +1 are rejected — total certainty is not expressible. Use 0 for a node assessed and believed neither way.'
      }, { status: 400 });
    }

    // The write itself: node columns stamped, movement logged iff the
    // credence actually changed. null back means no such node exists.
    const fixedCredenceAssertion = setBeliefFixedCredence(assertedNodeId, assertedBeliefCredence);
    if (fixedCredenceAssertion === null) {
      return NextResponse.json({
        success: false,
        error: `Cannot assert a credence about node #${assertedNodeId}: no such node.`
      }, { status: 404 });
    }

    // The reply mirrors the standalone door's shape, field for field.
    const summary = `Asserted belief_credence ${assertedBeliefCredence} on node #${assertedNodeId}.`;
    return NextResponse.json({
      success: true,
      node_id: assertedNodeId,
      belief_credence: fixedCredenceAssertion.beliefCredence,
      belief_credence_is_fixed: 1,
      belief_computed_at: fixedCredenceAssertion.beliefComputedAt,
      message: summary
    });
  } catch (error) {
    console.error('Error asserting fixed belief credence:', error);

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to assert fixed belief credence'
    }, { status: 500 });
  }
}
