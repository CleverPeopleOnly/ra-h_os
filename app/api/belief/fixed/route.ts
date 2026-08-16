import { NextRequest, NextResponse } from 'next/server';
import { getSQLiteClient } from '@/services/database/sqlite-client';

export const runtime = 'nodejs';

// The four belief columns of one node as stored after the assertion — read
// back from the row, never echoed from the request.
interface StoredFixedCredenceRow {
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
}

/**
 * POST /api/belief/fixed — a human asserts one node's credence by hand.
 *
 * The endpoint the remote MCP door's rah_assert_fixed_credence forwards to.
 * samai owns the belief engine since the belief-storage split, and this store
 * never grades: the assertion is a PLAIN COLUMN WRITE landing all four
 * belief columns in ONE act — belief_credence verbatim (OPEN interval
 * −1 < c < 1: the endpoints belong to derivation, not decree),
 * belief_uncertainty 0 (the dogmatic opinion — supplied by the ROUTE, never
 * the caller), belief_computed_at verbatim (samai stamps the instant, the
 * store lands it), and belief_credence_is_fixed 1.
 *
 * The route owns belief_uncertainty and belief_credence_is_fixed: a body
 * supplying either is refused rather than silently overridden — refused,
 * never reinterpreted, the same rule the display route applies to its
 * ranges. An unknown node is 404 naming the node; an already-fixed node is
 * 409 naming belief_credence_is_fixed — re-asserting requires an explicit
 * clear first, and the standing figures survive untouched. No write logs any
 * history row: movement history is samai's now.
 */
export async function POST(request: NextRequest) {
  try {
    // The request body; anything unparseable is treated as an empty body and
    // refused by the field checks below.
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const assertedNodeId = body?.node_id;
    const assertedBeliefCredence = body?.belief_credence;
    const assertedBeliefComputedAt = body?.belief_computed_at;

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

    // The route owns belief_uncertainty (always 0 on an assertion) and
    // belief_credence_is_fixed (always 1): a body carrying either key is
    // refused outright, so an illegal combination cannot be requested.
    if (body !== null && ('belief_uncertainty' in body || 'belief_credence_is_fixed' in body)) {
      return NextResponse.json({
        success: false,
        error:
          'A fixed-credence assertion carries only node_id, belief_credence and belief_computed_at: ' +
          'belief_uncertainty (always 0) and belief_credence_is_fixed (always 1) are the route\'s own figures.'
      }, { status: 400 });
    }

    // Credence's interval is OPEN here, unlike the display write's closed
    // one: −1 and 1 belong to derivation, not decree, so the endpoints are
    // refused along with everything beyond them.
    if (
      typeof assertedBeliefCredence !== 'number' ||
      !Number.isFinite(assertedBeliefCredence) ||
      assertedBeliefCredence <= -1 ||
      assertedBeliefCredence >= 1
    ) {
      return NextResponse.json({
        success: false,
        error: 'belief_credence must be a number strictly between -1 and 1 — a hand assertion never decrees the endpoints.'
      }, { status: 400 });
    }

    // The stamp is required — samai stamps the instant, so a stampless
    // assertion is incomplete — and it is stored verbatim, so an unparseable
    // stamp is refused rather than normalised.
    if (
      typeof assertedBeliefComputedAt !== 'string' ||
      Number.isNaN(Date.parse(assertedBeliefComputedAt))
    ) {
      return NextResponse.json({
        success: false,
        error: 'belief_computed_at must be an ISO-8601 timestamp string naming the instant samai stamped the assertion.'
      }, { status: 400 });
    }

    const sqlite = getSQLiteClient();

    // The row's absence is what makes an unknown node a refusal, and its
    // fixed flag is what makes a second decree one.
    const nodeFixedFlagRow = sqlite
      .prepare('SELECT belief_credence_is_fixed FROM nodes WHERE id = ?')
      .get(assertedNodeId) as { belief_credence_is_fixed: number } | undefined;
    if (nodeFixedFlagRow === undefined) {
      return NextResponse.json({
        success: false,
        error: `Cannot assert a fixed credence for node #${assertedNodeId}: no such node.`
      }, { status: 404 });
    }
    if (nodeFixedFlagRow.belief_credence_is_fixed === 1) {
      return NextResponse.json({
        success: false,
        error:
          `Node #${assertedNodeId} already has its credence asserted by hand (belief_credence_is_fixed = 1); ` +
          'clear the assertion before asserting again.'
      }, { status: 409 });
    }

    // The whole assertion in ONE UPDATE: all four columns land together, so
    // no sequence of writes can be caught halfway.
    sqlite
      .prepare(
        `UPDATE nodes
            SET belief_credence = ?, belief_uncertainty = 0, belief_computed_at = ?, belief_credence_is_fixed = 1
          WHERE id = ?`
      )
      .run(assertedBeliefCredence, assertedBeliefComputedAt, assertedNodeId);

    // The reply is the STORED row as it now stands, read back so it reports
    // what actually landed rather than echoing the request.
    const storedRow = sqlite
      .prepare(
        `SELECT belief_credence, belief_uncertainty, belief_computed_at, belief_credence_is_fixed
           FROM nodes WHERE id = ?`
      )
      .get(assertedNodeId) as StoredFixedCredenceRow;
    return NextResponse.json({
      success: true,
      node_id: assertedNodeId,
      belief_credence: storedRow.belief_credence,
      belief_uncertainty: storedRow.belief_uncertainty,
      belief_computed_at: storedRow.belief_computed_at,
      belief_credence_is_fixed: storedRow.belief_credence_is_fixed,
      message: `Asserted the fixed credence of node #${assertedNodeId}.`
    });
  } catch (error) {
    console.error('Error asserting fixed credence:', error);

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to assert fixed credence'
    }, { status: 500 });
  }
}
