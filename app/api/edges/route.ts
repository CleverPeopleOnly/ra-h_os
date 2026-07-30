import { NextRequest, NextResponse } from 'next/server';
import { edgeService } from '@/services/database';
import { validateEdgeExplanation } from '@/services/database/quality';
import type { BeliefEdgeReadDirection, BeliefEdgeReadFilter } from '@/types/database';

export const runtime = 'nodejs';

// The three sides an edge read can ask for, exactly as the read path names
// them. Any other value is rejected rather than silently widened to 'both'.
const BELIEF_EDGE_READ_DIRECTIONS: BeliefEdgeReadDirection[] = ['into', 'out_of', 'both'];

// Outcome of reading the edge-read filter off a query string: either the
// filter to hand to edgeService.getEdges, or the message explaining why the
// query string could not become one. An unreadable parameter is an error, not
// something to ignore — a silently ignored filter reads the whole graph.
type BeliefEdgeReadFilterParseResult =
  | { filter: BeliefEdgeReadFilter; error?: undefined }
  | { filter?: undefined; error: string };

// Read one non-negative whole-number query parameter (limit, offset). Returns
// undefined when the parameter is absent or blank, and an error message when
// it is present but not a non-negative integer.
function parseNonNegativeIntegerParam(
  rawValue: string | null,
  paramName: string
): { value?: number; error?: string } {
  if (rawValue === null || rawValue.trim() === '') return {};
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    return { error: `Invalid ${paramName}: must be a whole number of 0 or more (got "${rawValue}")` };
  }
  return { value: parsedValue };
}

// Turn GET /api/edges query parameters into the filter the edge read runs on:
// nodeId, direction, limit and offset, with limit and offset as numbers rather
// than raw strings. An omitted direction becomes the literal 'both', so the
// default is visible in the filter the service receives.
function parseBeliefEdgeReadFilter(requestUrl: string): BeliefEdgeReadFilterParseResult {
  const searchParams = new URL(requestUrl).searchParams;
  const filter: BeliefEdgeReadFilter = {};

  const rawNodeId = searchParams.get('nodeId');
  if (rawNodeId !== null && rawNodeId.trim() !== '') {
    const parsedNodeId = Number(rawNodeId);
    if (!Number.isInteger(parsedNodeId) || parsedNodeId <= 0) {
      return { error: `Invalid nodeId: must be a positive whole number (got "${rawNodeId}")` };
    }
    filter.nodeId = parsedNodeId;
  }

  const rawDirection = searchParams.get('direction');
  if (rawDirection === null || rawDirection.trim() === '') {
    filter.direction = 'both';
  } else if (BELIEF_EDGE_READ_DIRECTIONS.includes(rawDirection as BeliefEdgeReadDirection)) {
    filter.direction = rawDirection as BeliefEdgeReadDirection;
  } else {
    return {
      error: `Invalid direction: must be one of ${BELIEF_EDGE_READ_DIRECTIONS.join(', ')} (got "${rawDirection}")`,
    };
  }

  const parsedLimit = parseNonNegativeIntegerParam(searchParams.get('limit'), 'limit');
  if (parsedLimit.error) return { error: parsedLimit.error };
  if (parsedLimit.value !== undefined) filter.limit = parsedLimit.value;

  const parsedOffset = parseNonNegativeIntegerParam(searchParams.get('offset'), 'offset');
  if (parsedOffset.error) return { error: parsedOffset.error };
  if (parsedOffset.value !== undefined) filter.offset = parsedOffset.value;

  return { filter };
}

export async function GET(request: NextRequest) {
  try {
    // Validate before reading: a rejected filter must never reach SQL.
    const parsedEdgeReadFilter = parseBeliefEdgeReadFilter(request.url);
    if (parsedEdgeReadFilter.error) {
      return NextResponse.json({
        success: false,
        error: parsedEdgeReadFilter.error
      }, { status: 400 });
    }

    // Both belief columns travel on the rows the service returns and are
    // serialised verbatim, so a NULL belief_evidence_contribution stays NULL.
    const edges = await edgeService.getEdges(parsedEdgeReadFilter.filter);

    return NextResponse.json({
      success: true,
      data: edges,
      count: edges.length
    });
  } catch (error) {
    console.error('Error fetching edges:', error);
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch edges'
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Validate required fields
    if (!body.from_node_id || !body.to_node_id) {
      return NextResponse.json({
        success: false,
        error: 'Missing required fields: from_node_id and to_node_id are required'
      }, { status: 400 });
    }

    // Validate node IDs are numbers
    if (isNaN(parseInt(body.from_node_id)) || isNaN(parseInt(body.to_node_id))) {
      return NextResponse.json({
        success: false,
        error: 'Invalid node IDs: must be valid numbers'
      }, { status: 400 });
    }

    // Set default source if not provided
    if (!body.source) {
      body.source = 'user';
    }

    // Validate source value
    if (!['user', 'ai_similarity', 'helper_name'].includes(body.source)) {
      return NextResponse.json({
        success: false,
        error: 'Invalid source: must be user, ai_similarity, or helper_name'
      }, { status: 400 });
    }

    const fromId = parseInt(body.from_node_id);
    const toId = parseInt(body.to_node_id);
    const explanation = String(body.explanation || '').trim();
    const createdVia = (() => {
      const raw = typeof body.created_via === 'string' ? body.created_via : '';
      if (['ui', 'agent', 'mcp', 'workflow', 'quicklink'].includes(raw)) return raw as any;
      return 'ui' as const;
    })();

    if (!explanation && createdVia !== 'ui' && createdVia !== 'quicklink') {
      return NextResponse.json({
        success: false,
        error: 'Agent-driven edge creation requires an explicit explanation. Propose likely edges first and only create them after the user confirms.'
      }, { status: 400 });
    }

    if ((createdVia === 'agent' || createdVia === 'mcp' || createdVia === 'workflow') && body.confirmed_by_user !== true) {
      return NextResponse.json({
        success: false,
        error: 'Agent-driven edge creation requires explicit user confirmation before writing to the graph.'
      }, { status: 400 });
    }

    if (explanation) {
      const explanationError = validateEdgeExplanation(explanation);
      if (explanationError) {
        return NextResponse.json({
          success: false,
          error: explanationError
        }, { status: 400 });
      }
    }
    const skipInference = Boolean(body.skip_inference);

    // Idempotency: prevent duplicate edges between same pair
    try {
      const exists = await edgeService.edgeExists(fromId, toId);
      if (exists) {
        return NextResponse.json({
          success: true,
          data: { from_node_id: fromId, to_node_id: toId },
          message: `Edge already exists between nodes ${fromId} and ${toId}`
        }, { status: 200 });
      }
    } catch (e) {
      // Non-fatal: continue with creation if existence check fails
      console.warn('edgeExists check failed; proceeding to create:', e);
    }

    const edge = await edgeService.createEdge({
      from_node_id: fromId,
      to_node_id: toId,
      explanation,
      created_via: createdVia,
      source: body.source,
      skip_inference: skipInference,
      // Belief evidence pass-through (MR-B): the one writable evidence field
      // — the signed support — must reach edgeService intact; plain edge
      // bodies carry none, so it stays undefined and no evidence value is
      // invented. The merged-away belief_evidence_direction /
      // belief_evidence_strength and the removed belief_evidence_origin_key
      // are simply not rebuilt onto this argument, so a stale client's values
      // are ignored rather than rejected.
      belief_evidence_support: body.belief_evidence_support
    });

    return NextResponse.json({
      success: true,
      data: edge,
      message: `Edge created successfully between nodes ${edge.from_node_id} and ${edge.to_node_id}`
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating edge:', error);
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create edge'
    }, { status: 500 });
  }
}
