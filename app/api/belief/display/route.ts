import { NextRequest, NextResponse } from 'next/server';
import { writeDisplayBelief } from '@/services/belief/beliefDisplayWrite';

export const runtime = 'nodejs';

/**
 * POST /api/belief/display — samai writes one node's display belief.
 *
 * The endpoint the remote MCP door's rah_write_display_belief forwards to.
 * samai owns the belief engine since the belief-storage split, so this store
 * never grades: the write is a PLAIN COLUMN WRITE with exactly two legal
 * shapes —
 *
 *  - a GRADE: belief_credence (number in [-1, +1]), belief_uncertainty
 *    (number in (0, 1]) and belief_computed_at (ISO-8601 string) ALL
 *    non-null, landing verbatim,
 *  - an UNGRADE: all three null, clearing together.
 *
 * Any mixture is refused with 400 naming the two shapes. An unknown node is
 * 404 naming the node; a FIXED node is 409 naming belief_credence_is_fixed —
 * a hand-asserted credence is only changed through the assert/clear tools.
 * The door's schema already refuses out-of-interval numbers, but the app is
 * a public surface of its own, so every range is enforced here too — refused,
 * never reinterpreted. NEITHER legal write logs a belief_movements row:
 * movement history is samai's now.
 */
export async function POST(request: NextRequest) {
  try {
    // The request body; anything unparseable is treated as an empty body and
    // refused by the field checks below.
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const writtenNodeId = body?.node_id;
    const writtenBeliefCredence = body?.belief_credence;
    const writtenBeliefUncertainty = body?.belief_uncertainty;
    const writtenBeliefComputedAt = body?.belief_computed_at;

    // A body that cannot name its node writes about nothing.
    if (
      typeof writtenNodeId !== 'number' ||
      !Number.isInteger(writtenNodeId) ||
      writtenNodeId <= 0
    ) {
      return NextResponse.json({
        success: false,
        error: 'node_id must be a positive integer naming the node whose display belief is being written.'
      }, { status: 400 });
    }

    // Each field is null or a value in its own interval; anything else is
    // refused before the shape is even considered. Credence lives in the
    // CLOSED interval [-1, +1] — samai's engine may derive the endpoints.
    if (
      writtenBeliefCredence !== null &&
      (typeof writtenBeliefCredence !== 'number' ||
        !Number.isFinite(writtenBeliefCredence) ||
        writtenBeliefCredence < -1 ||
        writtenBeliefCredence > 1)
    ) {
      return NextResponse.json({
        success: false,
        error: 'belief_credence must be null or a number in [-1, 1].'
      }, { status: 400 });
    }

    // Uncertainty's interval is OPEN at 0: 0 is the dogmatic opinion,
    // reserved for a hand-asserted credence, so samai may never write it.
    if (
      writtenBeliefUncertainty !== null &&
      (typeof writtenBeliefUncertainty !== 'number' ||
        !Number.isFinite(writtenBeliefUncertainty) ||
        writtenBeliefUncertainty <= 0 ||
        writtenBeliefUncertainty > 1)
    ) {
      return NextResponse.json({
        success: false,
        error: 'belief_uncertainty must be null or a number in (0, 1] — 0 is the dogmatic opinion and is not writable here.'
      }, { status: 400 });
    }

    // The stamp must be a parseable ISO-8601 string or null; it is stored
    // verbatim, so an unparseable stamp is refused rather than normalised.
    if (
      writtenBeliefComputedAt !== null &&
      (typeof writtenBeliefComputedAt !== 'string' ||
        Number.isNaN(Date.parse(writtenBeliefComputedAt)))
    ) {
      return NextResponse.json({
        success: false,
        error: 'belief_computed_at must be null or an ISO-8601 timestamp string.'
      }, { status: 400 });
    }

    // The two legal shapes: a GRADE (all three non-null) or an UNGRADE (all
    // three null). A mixture is neither, and is refused rather than
    // reinterpreted.
    const nullFieldCount = [writtenBeliefCredence, writtenBeliefUncertainty, writtenBeliefComputedAt]
      .filter(writtenField => writtenField === null).length;
    if (nullFieldCount !== 0 && nullFieldCount !== 3) {
      return NextResponse.json({
        success: false,
        error:
          'A display-belief write has exactly two legal shapes: a GRADE with all three of ' +
          'belief_credence, belief_uncertainty and belief_computed_at non-null, or an UNGRADE ' +
          'with all three null. A mixture is refused.'
      }, { status: 400 });
    }

    // The write itself; the stored row decides the remaining refusals.
    const displayBeliefWriteOutcome = writeDisplayBelief(
      writtenNodeId,
      nullFieldCount === 3
        ? null
        : {
            beliefCredence: writtenBeliefCredence as number,
            beliefUncertainty: writtenBeliefUncertainty as number,
            beliefComputedAt: writtenBeliefComputedAt as string,
          }
    );

    if (displayBeliefWriteOutcome.outcome === 'unknown-node') {
      return NextResponse.json({
        success: false,
        error: `Cannot write a display belief for node #${writtenNodeId}: no such node.`
      }, { status: 404 });
    }
    if (displayBeliefWriteOutcome.outcome === 'fixed-node') {
      return NextResponse.json({
        success: false,
        error:
          `Node #${writtenNodeId} has its credence asserted by hand (belief_credence_is_fixed = 1); ` +
          'withdraw the assertion before writing a display belief.'
      }, { status: 409 });
    }

    // The reply is the stored row as it now stands, read back by the write.
    const storedRow = displayBeliefWriteOutcome.storedRow;
    return NextResponse.json({
      success: true,
      node_id: writtenNodeId,
      belief_credence: storedRow.belief_credence,
      belief_uncertainty: storedRow.belief_uncertainty,
      belief_computed_at: storedRow.belief_computed_at,
      belief_credence_is_fixed: storedRow.belief_credence_is_fixed,
      message: `Wrote the display belief of node #${writtenNodeId}.`
    });
  } catch (error) {
    console.error('Error writing display belief:', error);

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to write display belief'
    }, { status: 500 });
  }
}
