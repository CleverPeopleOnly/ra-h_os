import { NextRequest, NextResponse } from 'next/server';
import { acknowledgeGraphEventsUpTo } from '@/services/database/graphEvents';

export const runtime = 'nodejs';

/**
 * POST /api/graph-events/acknowledge — move the graph-event ack cursor
 * forward. Body { upToEventId }; answers { success: true, acked_event_id }
 * where acked_event_id is the cursor AFTER the call. FORWARD ONLY: an
 * upToEventId at or below the cursor leaves it where it is — the cursor
 * never moves backward, so acknowledged events are never re-delivered. The
 * endpoint the remote MCP door's rah_acknowledge_graph_events forwards to.
 */
export async function POST(request: NextRequest) {
  try {
    // The request body; anything unparseable is treated as an empty body and
    // refused by the field check below.
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const upToEventId = body?.upToEventId;

    // The acknowledged prefix must be named by a plain non-negative integer
    // event id — anything else is a refusal, not a reinterpretation.
    if (
      typeof upToEventId !== 'number' ||
      !Number.isInteger(upToEventId) ||
      upToEventId < 0
    ) {
      return NextResponse.json({
        success: false,
        error: 'upToEventId must be a non-negative integer naming the highest acknowledged event id.'
      }, { status: 400 });
    }

    // The forward-only cursor move, answered as the cursor AFTER the call —
    // which the forward-only rule may have left unchanged.
    const ackedEventIdAfterCall = acknowledgeGraphEventsUpTo(upToEventId);

    return NextResponse.json({
      success: true,
      acked_event_id: ackedEventIdAfterCall
    });
  } catch (error) {
    console.error('Error acknowledging graph events:', error);

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to acknowledge graph events'
    }, { status: 500 });
  }
}
