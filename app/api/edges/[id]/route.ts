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

    // Belief-evidence door check (fork addition): a support in the body is
    // spread into the update payload below and written to the REAL
    // edges.belief_evidence_support column, so it is range-checked here before
    // the service ever sees it. Support is UNSIGNED, 0..1 — contradiction is
    // expressed by the source NODE's negative belief_credence, never by the
    // edge. An absent field passes (the update writes no support at all), NULL
    // passes (it un-assesses the edge, a legitimate write) and 0 passes
    // (assessed, carries nothing). The number test comes first and
    // separately: a value that is not a number cannot be in range, and no range
    // comparison catches NaN.
    const writtenBeliefEvidenceSupport = body.belief_evidence_support;
    if (
      writtenBeliefEvidenceSupport != null &&
      (typeof writtenBeliefEvidenceSupport !== 'number' ||
        !Number.isFinite(writtenBeliefEvidenceSupport) ||
        writtenBeliefEvidenceSupport < 0 ||
        writtenBeliefEvidenceSupport > 1)
    ) {
      return NextResponse.json({
        success: false,
        error:
          `belief_evidence_support must be a number between 0 and 1 (got ${String(writtenBeliefEvidenceSupport)}). ` +
          'Support is unsigned; a contradicting source is expressed by that source node\'s negative belief_credence.'
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

    // Belief-evidence door check (fork addition): whether this write carries a
    // support at all. KEY PRESENCE, not truthiness — a support of 0 is an
    // assessed "carries nothing" and an explicit null un-assesses the edge, and
    // both are deliberate writes despite both being falsy.
    const edgeUpdateCarriesBeliefEvidenceSupport = Object.prototype.hasOwnProperty.call(
      body,
      'belief_evidence_support'
    );

    // Confirmation gate. Agent-driven writes have always needed explicit user
    // confirmation, and so does ANY write carrying a support, however it names
    // itself: createdVia falls back to 'ui' when the body names none, so a
    // support write that simply omitted created_via would otherwise regrade the
    // graph with nobody having confirmed it.
    if (
      (createdVia === 'agent' ||
        createdVia === 'mcp' ||
        createdVia === 'workflow' ||
        edgeUpdateCarriesBeliefEvidenceSupport) &&
      body.confirmed_by_user !== true
    ) {
      return NextResponse.json({
        success: false,
        error: 'Agent-driven edge updates require explicit user confirmation before writing to the graph.'
      }, { status: 400 });
    }

    // A support-only correction (fork addition): the caller is correcting how
    // strongly the source node talks about its neighbour and touching neither
    // the explanation nor the context JSON that holds one. It is exempt from
    // the explanation requirement below because there is no read-one-edge-by-id
    // tool for an agent to fetch the stored reasoning and hand it back, so
    // demanding one would force it to invent prose over recorded human words.
    // An update that DOES write either field is changing the relationship's
    // prose and still owes an explanation for the change.
    const edgeUpdateCorrectsBeliefSupportOnly =
      edgeUpdateCarriesBeliefEvidenceSupport &&
      body.explanation === undefined &&
      body.context === undefined;

    if (
      !explanation &&
      createdVia !== 'ui' &&
      createdVia !== 'quicklink' &&
      !edgeUpdateCorrectsBeliefSupportOnly
    ) {
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
    // on EVERY path — including the support-only one that just skipped the
    // stamp — or the UPDATE names a column that does not exist.
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
