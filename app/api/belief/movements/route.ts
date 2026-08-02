import { NextRequest, NextResponse } from 'next/server';
import { readBeliefMovementsNewestFirst } from '@/services/belief/beliefMovements';

export const runtime = 'nodejs';

// The page cap on a movement read, and the default page when the caller
// names none: a long-lived node must not flood a caller with its whole log.
const BELIEF_MOVEMENTS_PAGE_LIMIT_MAX = 100;
const BELIEF_MOVEMENTS_PAGE_LIMIT_DEFAULT = 50;

/**
 * GET /api/belief/movements?node_id=N[&limit=M] — read the log of one node's
 * credence changing, newest movement first, under the exact belief_movements
 * column names. The endpoint both app-backed MCP doors'
 * rah_get_belief_movements forwards to.
 *
 * An empty log answers 200 with an empty list: a credence that has never
 * changed is a success state, not an error. A read that cannot name its node,
 * or asks for an impossible page, is refused with 400 rather than silently
 * reinterpreted.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const nodeIdParam = searchParams.get('node_id');
    const limitParam = searchParams.get('limit');

    // node_id is required and must be a plain positive integer — a read
    // without one names no node.
    if (nodeIdParam === null || !/^\d+$/.test(nodeIdParam) || Number(nodeIdParam) <= 0) {
      return NextResponse.json({
        success: false,
        error: 'node_id must be a positive integer naming the node whose movement log is being read.'
      }, { status: 400 });
    }
    const requestedNodeId = Number(nodeIdParam);

    // The page size: a reasonable default when omitted, an integer 1..100
    // otherwise. Anything else — zero, negative, fractional, over the cap —
    // is a refusal, not a reinterpretation.
    let movementPageLimit = BELIEF_MOVEMENTS_PAGE_LIMIT_DEFAULT;
    if (limitParam !== null) {
      if (
        !/^\d+$/.test(limitParam) ||
        Number(limitParam) < 1 ||
        Number(limitParam) > BELIEF_MOVEMENTS_PAGE_LIMIT_MAX
      ) {
        return NextResponse.json({
          success: false,
          error: `limit must be an integer from 1 to ${BELIEF_MOVEMENTS_PAGE_LIMIT_MAX}.`
        }, { status: 400 });
      }
      movementPageLimit = Number(limitParam);
    }

    // The node's movement log, newest first, capped at the page limit.
    const beliefMovements = readBeliefMovementsNewestFirst(requestedNodeId, movementPageLimit);

    return NextResponse.json({
      success: true,
      count: beliefMovements.length,
      movements: beliefMovements
    });
  } catch (error) {
    console.error('Error reading belief movements:', error);

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read belief movements'
    }, { status: 500 });
  }
}
