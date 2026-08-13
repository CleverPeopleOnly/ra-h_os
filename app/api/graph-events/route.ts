import { NextRequest, NextResponse } from 'next/server';
import { readUnacknowledgedGraphEvents } from '@/services/database/graphEvents';

export const runtime = 'nodejs';

// The page cap on a journal read, and the default page when the caller names
// none: a long-unread journal must not flood a caller with its whole backlog.
const GRAPH_EVENTS_PAGE_LIMIT_MAX = 500;
const GRAPH_EVENTS_PAGE_LIMIT_DEFAULT = 100;

/**
 * GET /api/graph-events[?limit=N] — read the unacknowledged graph-event
 * journal: every trigger-written graph_events row with id greater than the
 * ack cursor, oldest first (id ascending), at most N of them. The endpoint
 * the remote MCP door's rah_read_graph_events forwards to.
 *
 * An empty journal answers 200 with an empty list: a graph nothing has been
 * deleted from or re-pointed in is a success state, not an error. A read
 * asking for an impossible page is refused with 400 rather than silently
 * reinterpreted.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get('limit');

    // The page size: a reasonable default when omitted, an integer 1..500
    // otherwise. Anything else — zero, negative, fractional, over the cap —
    // is a refusal, not a reinterpretation.
    let graphEventPageLimit = GRAPH_EVENTS_PAGE_LIMIT_DEFAULT;
    if (limitParam !== null) {
      if (
        !/^\d+$/.test(limitParam) ||
        Number(limitParam) < 1 ||
        Number(limitParam) > GRAPH_EVENTS_PAGE_LIMIT_MAX
      ) {
        return NextResponse.json({
          success: false,
          error: `limit must be an integer from 1 to ${GRAPH_EVENTS_PAGE_LIMIT_MAX}.`
        }, { status: 400 });
      }
      graphEventPageLimit = Number(limitParam);
    }

    // The unacknowledged events, id ascending, capped at the page limit.
    const graphEventRows = readUnacknowledgedGraphEvents(graphEventPageLimit);

    return NextResponse.json({
      success: true,
      data: graphEventRows
    });
  } catch (error) {
    console.error('Error reading graph events:', error);

    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read graph events'
    }, { status: 500 });
  }
}
