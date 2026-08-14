import { tool } from 'ai';
import { z } from 'zod';
import { edgeService } from '@/services/database/edges';
import type { BeliefEdgeReadFilter } from '@/types/database';
import { formatNodeForChat } from '../infrastructure/nodeFormatter';

// Page size used when the caller names none. It matches the input schema's
// default so a direct execute() call is capped exactly as a schema-parsed agent
// call is: no edge read here is ever uncapped.
const DEFAULT_EDGE_PAGE_SIZE = 20;

function truncateText(value: unknown, maxLength = 180): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLength) return trimmed;
  if (maxLength <= 3) return trimmed.slice(0, maxLength);
  return `${trimmed.slice(0, maxLength - 3)}...`;
}

export const queryEdgeTool = tool({
  description: 'Find edges by node/direction/source/ID',
  inputSchema: z.object({
    filters: z.object({
      node_id: z.number().optional().describe('Get all edges connected to this specific node (both incoming and outgoing)'),
      from_node_id: z.number().optional().describe('Get edges originating from this specific node'),
      to_node_id: z.number().optional().describe('Get edges pointing to this specific node'),
      source: z.enum(['user', 'ai_similarity', 'helper_name']).optional().describe('Filter edges by their source type'),
      edge_id: z.number().optional().describe('Get a specific edge by its ID'),
      limit: z.number().min(1).max(100).default(DEFAULT_EDGE_PAGE_SIZE).describe('Maximum number of results to return'),
      offset: z.number().min(0).optional().describe('How many matching edges to skip before this page begins, for reading the next page of a set larger than limit')
    }).optional().describe('Filters to apply when querying edges')
  }),
  execute: async ({ filters = {} }) => {
    console.log('🔍 QueryEdge tool called with filters:', JSON.stringify(filters, null, 2));
    
    try {
      // Handle specific edge ID lookup
      if (filters.edge_id) {
        const edge = await edgeService.getEdgeById(filters.edge_id);
        return {
          success: true,
          data: {
            edges: edge ? [edge] : [],
            count: edge ? 1 : 0,
            filters_applied: filters
          },
          message: edge ? `Found edge ${filters.edge_id}` : `Edge ${filters.edge_id} not found`
        };
      }

      // Handle node connections (most common use case)
      if (filters.node_id) {
        const effectiveLimit = Math.min(filters.limit || 20, 12);
        const connections = await edgeService.getNodeConnections(filters.node_id);
        const edges = connections.map(conn => conn.edge);
        
        // Apply additional filters if specified
        let filteredEdges = edges;
        if (filters.source) {
          filteredEdges = edges.filter(edge => edge.source === filters.source);
        }
        
        // Apply limit and format connected nodes
        const limitedConnections = connections.slice(0, effectiveLimit);
        const formattedConnections = limitedConnections.map(connection => {
          const formattedNode = formatNodeForChat({
            id: connection.connected_node.id,
            title: connection.connected_node.title
          });

          const context = connection.edge.context as Record<string, unknown> | undefined;
          
          return {
            edge: {
              id: connection.edge.id,
              from_node_id: connection.edge.from_node_id,
              to_node_id: connection.edge.to_node_id,
              source: connection.edge.source,
              created_at: connection.edge.created_at,
              context: {
                type: typeof context?.type === 'string' ? context.type : null,
                explanation: truncateText(context?.explanation),
                confidence: typeof context?.confidence === 'number' ? context.confidence : null,
              }
            },
            connected_node: {
              id: connection.connected_node.id,
              title: connection.connected_node.title,
              description: truncateText(connection.connected_node.description, 140),
              formatted_display: formattedNode
            }
          };
        });

        const summarizedEdges = formattedConnections.map(connection => ({
          id: connection.edge.id,
          from_node_id: connection.edge.from_node_id,
          to_node_id: connection.edge.to_node_id,
          source: connection.edge.source,
          created_at: connection.edge.created_at,
          context: connection.edge.context,
          connected_node: connection.connected_node.formatted_display,
        }));
        
        // Create message with formatted connected nodes
        const connectedNodeLabels = formattedConnections.map(conn => conn.connected_node.formatted_display).join(', ');
        const message = `Found ${filteredEdges.length} edges for node ${filters.node_id}. Showing ${formattedConnections.length}${connectedNodeLabels ? `. Connected nodes: ${connectedNodeLabels}` : ''}`;

        return {
          success: true,
          data: {
            edges: summarizedEdges,
            connections: formattedConnections,
            count: filteredEdges.length,
            returned_count: formattedConnections.length,
            filters_applied: filters
          },
          message: message
        };
      }

      // Handle directional queries, or a paged read of the whole table.
      //
      // The node side, the edge source, the page size and the page position all
      // go to SQL: a page of one side of one node is an indexed read, whereas
      // reading the table and narrowing it here is a memory failure mode on a
      // graph with 100,000s of edges. A query naming no node is paged on the
      // same terms — the largest read there is, so certainly capped — but is
      // never narrowed to a node the caller did not ask for.
      const requestedPageSize = filters.limit ?? DEFAULT_EDGE_PAGE_SIZE;
      const requestedPagePosition = filters.offset ?? 0;

      // The one node side SQL can narrow by. from_node_id asks for the edges
      // LEAVING a node ('out_of') — under canon the relationships the node
      // derives from; to_node_id asks for the edges pointing AT it ('into'),
      // the edges through which OTHER nodes derive from this one.
      const nodeSideOfEdgeRead: Pick<BeliefEdgeReadFilter, 'nodeId' | 'direction'> =
        filters.from_node_id != null
          ? { nodeId: filters.from_node_id, direction: 'out_of' }
          : filters.to_node_id != null
            ? { nodeId: filters.to_node_id, direction: 'into' }
            : {};

      const edgeReadFilter: BeliefEdgeReadFilter = {
        ...nodeSideOfEdgeRead,
        ...(filters.source ? { edgeSource: filters.source } : {}),
        limit: requestedPageSize,
        ...(filters.offset != null ? { offset: filters.offset } : {}),
      };

      const edgePageFromSql = await edgeService.getEdges(edgeReadFilter);

      // The one narrowing SQL cannot express: a query naming BOTH endpoints
      // gives the SQL filter one node side, so the other endpoint is checked
      // here. Edge source is re-checked in the same pass — SQL has already
      // applied it, so this is idempotent, and keeping both residual checks in
      // one place means the page is narrowed once rather than in two styles.
      const narrowedEdgePage = edgePageFromSql.filter(edge => {
        if (filters.from_node_id != null && edge.from_node_id !== filters.from_node_id) return false;
        if (filters.to_node_id != null && edge.to_node_id !== filters.to_node_id) return false;
        if (filters.source && edge.source !== filters.source) return false;
        return true;
      });

      // How many edges match the query in total, which is a different fact from
      // the page size: an agent deciding whether to ask for another page needs
      // the total, and a page past the end must still report it or the agent
      // will read "no rows here" as "this node has no evidence".
      //
      // A page SHORTER than the size asked for has already reached the end of
      // the matching set, so its own size settles the total and no second query
      // is needed. That inference only holds while every predicate reached SQL,
      // so it is skipped when the residual narrowing above removed anything;
      // and an EMPTY page proves nothing unless it started at the beginning.
      const sqlPageStoppedShortOfItsCap = edgePageFromSql.length < requestedPageSize;
      const residualNarrowingRemovedNothing = narrowedEdgePage.length === edgePageFromSql.length;
      const matchingSetEndedInsideThisPage =
        sqlPageStoppedShortOfItsCap &&
        residualNarrowingRemovedNothing &&
        (edgePageFromSql.length > 0 || requestedPagePosition === 0);

      const matchingEdgeCount = matchingSetEndedInsideThisPage
        ? requestedPagePosition + edgePageFromSql.length
        : residualNarrowingRemovedNothing
          ? await edgeService.getEdgeCount(edgeReadFilter)
          // A second endpoint was narrowed here, so SQL cannot count the
          // matching set: the tool can only speak for the page it read.
          : narrowedEdgePage.length;

      // What the query was about, for the message: which side of which node,
      // and which edge source, in the caller's own terms.
      const edgeReadDescription = [
        filters.from_node_id != null ? `out of node ${filters.from_node_id}` : '',
        filters.to_node_id != null ? `into node ${filters.to_node_id}` : '',
        filters.source ? `with source ${filters.source}` : '',
      ]
        .filter(Boolean)
        .join(' ');

      return {
        success: true,
        data: {
          edges: narrowedEdgePage,
          // How many edges are in THIS page.
          returned_edge_count: narrowedEdgePage.length,
          // How many edges match the query at all, across every page.
          matching_edge_count: matchingEdgeCount,
          filters_applied: filters
        },
        message: `Found ${matchingEdgeCount} edge(s)${edgeReadDescription ? ` ${edgeReadDescription}` : ''}, showing ${narrowedEdgePage.length}.`
      };
    } catch (error) {
      console.error('QueryEdge tool error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to query edges',
        data: {
          edges: [],
          // No page was returned, which is the one count a failed read can
          // state truthfully. There is deliberately NO matching_edge_count
          // here: the read that would have measured the matching set is the
          // read that just failed, so any number would be invented — and 0
          // would tell the agent the query matches nothing, which is the exact
          // misreading the two separate counts exist to prevent. An absent key
          // says "unknown"; a 0 would say "none".
          returned_edge_count: 0,
          filters_applied: filters
        }
      };
    }
  }
});
