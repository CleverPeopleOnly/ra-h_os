import { NextRequest, NextResponse } from 'next/server';
import { getSQLiteClient } from '@/services/database/sqlite-client';

export const runtime = 'nodejs';

// The four belief columns of one node as stored after the clear — read back
// from the row, never echoed from the request.
interface StoredFixedCredenceRow {
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
}

/**
 * POST /api/belief/fixed/clear — withdrawing a hand-asserted credence.
 *
 * The endpoint the remote MCP door's rah_clear_fixed_credence forwards to.
 * The clear drops belief_credence_is_fixed and NOTHING else: this store
 * never grades, so the regrade after a clear is samai's, done through the
 * display write afterwards — belief_credence, belief_uncertainty and
 * belief_computed_at keep the stale hand-asserted figures until then.
 *
 * An unknown node is 404 naming the node; clearing a node nobody asserted is
 * 409 saying plainly the node is not fixed — a caller error, never a silent
 * no-op, because the request was well-formed and the stored state is what
 * refuses it. The reply is the STORED row's four belief columns read back,
 * never an echo of the request.
 */
export async function POST(request: NextRequest) {
  try {
    // The request body; anything unparseable is treated as an empty body and
    // refused by the node check below.
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const clearedNodeId = body?.node_id;

    // A body that cannot name its node withdraws nothing.
    if (
      typeof clearedNodeId !== 'number' ||
      !Number.isInteger(clearedNodeId) ||
      clearedNodeId <= 0
    ) {
      return NextResponse.json({
        success: false,
        error: 'node_id must be a positive integer naming the node whose fixed credence is being cleared.'
      }, { status: 400 });
    }

    const sqlite = getSQLiteClient();

    // The row's absence is what makes an unknown node a refusal, and its
    // unraised flag is what makes a clear with nothing to withdraw one.
    const nodeFixedFlagRow = sqlite
      .prepare('SELECT belief_credence_is_fixed FROM nodes WHERE id = ?')
      .get(clearedNodeId) as { belief_credence_is_fixed: number } | undefined;
    if (nodeFixedFlagRow === undefined) {
      return NextResponse.json({
        success: false,
        error: `Cannot clear the fixed credence of node #${clearedNodeId}: no such node.`
      }, { status: 404 });
    }
    if (nodeFixedFlagRow.belief_credence_is_fixed !== 1) {
      return NextResponse.json({
        success: false,
        error: `Node #${clearedNodeId} is not fixed; there is no assertion to clear.`
      }, { status: 409 });
    }

    // The plain column write: the flag drops and only the flag — the three
    // display columns keep their standing figures for samai to regrade.
    sqlite
      .prepare('UPDATE nodes SET belief_credence_is_fixed = 0 WHERE id = ?')
      .run(clearedNodeId);

    // The reply is the STORED row as it now stands, read back so it reports
    // what actually landed rather than echoing the request.
    const storedRow = sqlite
      .prepare(
        `SELECT belief_credence, belief_uncertainty, belief_computed_at, belief_credence_is_fixed
           FROM nodes WHERE id = ?`
      )
      .get(clearedNodeId) as StoredFixedCredenceRow;
    return NextResponse.json({
      success: true,
      node_id: clearedNodeId,
      belief_credence: storedRow.belief_credence,
      belief_uncertainty: storedRow.belief_uncertainty,
      belief_computed_at: storedRow.belief_computed_at,
      belief_credence_is_fixed: storedRow.belief_credence_is_fixed,
      message: `Cleared the fixed credence of node #${clearedNodeId}.`
    });
  } catch (error) {
    console.error('Error clearing fixed credence:', error);

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to clear fixed credence'
    }, { status: 500 });
  }
}
