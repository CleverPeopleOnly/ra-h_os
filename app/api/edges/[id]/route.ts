import { NextRequest, NextResponse } from 'next/server';
import { edgeService } from '@/services/database';
import { validateEdgeExplanation } from '@/services/database/quality';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const edgeId = parseInt(id, 10);
    
    if (isNaN(edgeId)) {
      return NextResponse.json({
        success: false,
        error: 'Invalid edge ID'
      }, { status: 400 });
    }
    
    const edge = await edgeService.getEdgeById(edgeId);
    
    if (!edge) {
      return NextResponse.json({
        success: false,
        error: 'Edge not found'
      }, { status: 404 });
    }
    
    return NextResponse.json({
      success: true,
      data: edge
    });
  } catch (error) {
    console.error('Error fetching edge:', error);
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch edge'
    }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const edgeId = parseInt(id, 10);
    
    if (isNaN(edgeId)) {
      return NextResponse.json({
        success: false,
        error: 'Invalid edge ID'
      }, { status: 400 });
    }

    const body = await request.json();
    
    // Validate source value if provided
    if (body.source && !['user', 'ai_similarity', 'helper_name'].includes(body.source)) {
      return NextResponse.json({
        success: false,
        error: 'Invalid source: must be user, ai_similarity, or helper_name'
      }, { status: 400 });
    }

    const explanation =
      typeof body.explanation === 'string'
        ? body.explanation.trim()
        : typeof body.context?.explanation === 'string'
          ? body.context.explanation.trim()
          : '';

    const createdVia = (() => {
      const raw =
        typeof body.created_via === 'string'
          ? body.created_via
          : typeof body.context?.created_via === 'string'
            ? body.context.created_via
            : '';
      if (['ui', 'agent', 'mcp', 'workflow', 'quicklink'].includes(raw)) return raw as any;
      return 'ui' as const;
    })();

    // Confirmation gate: agent-driven writes need explicit user confirmation
    // before anything lands in the graph.
    if (
      (createdVia === 'agent' || createdVia === 'mcp' || createdVia === 'workflow') &&
      body.confirmed_by_user !== true
    ) {
      return NextResponse.json({
        success: false,
        error: 'Agent-driven edge updates require explicit user confirmation before writing to the graph.'
      }, { status: 400 });
    }

    if (!explanation && createdVia !== 'ui' && createdVia !== 'quicklink') {
      return NextResponse.json({
        success: false,
        error: 'Agent-driven edge updates require an explicit explanation.'
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

    const updatePayload = { ...body };
    delete updatePayload.confirmed_by_user;

    // Belief evidence left the edges table: a stale client still sending
    // either evidence key gets it silently dropped here — the key is simply
    // not part of the contract any more, never an error. Without this drop the
    // service's dynamic UPDATE would name a column that no longer exists.
    delete updatePayload.belief_evidence_support;
    delete updatePayload.belief_evidence_contribution;

    // Stamp the provenance into the context ONLY when this update already
    // writes one. edgeService.updateEdge assigns `context` WHOLESALE, so
    // manufacturing a context here for a support-only correction would replace
    // the stored context and destroy the explanation recorded inside it.
    if (
      typeof updatePayload.created_via === 'string' &&
      updatePayload.context &&
      typeof updatePayload.context === 'object'
    ) {
      updatePayload.context = {
        ...updatePayload.context,
        created_via: updatePayload.created_via,
      };
    }

    // created_via is request provenance, never an edges column. The service
    // builds `SET <key> = ?` from every key in the payload, so it has to leave
    // on EVERY path — or the UPDATE names a column that does not exist.
    delete updatePayload.created_via;

    const edge = await edgeService.updateEdge(edgeId, updatePayload);

    return NextResponse.json({
      success: true,
      data: edge,
      message: `Edge updated successfully`
    });
  } catch (error) {
    console.error('Error updating edge:', error);
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update edge'
    }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const edgeId = parseInt(id, 10);
    
    if (isNaN(edgeId)) {
      return NextResponse.json({
        success: false,
        error: 'Invalid edge ID'
      }, { status: 400 });
    }

    await edgeService.deleteEdge(edgeId);

    return NextResponse.json({
      success: true,
      message: `Edge ${edgeId} deleted successfully`
    });
  } catch (error) {
    console.error('Error deleting edge:', error);
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete edge'
    }, { status: 500 });
  }
}
