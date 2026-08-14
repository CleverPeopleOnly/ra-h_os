import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

// The fork-owned belief pieces of the MCP tool contract, shared verbatim with
// the local door (apps/mcp-server/stdio-server.js) so the two cannot drift
// apart again. The module is CommonJS because that door requires it from
// source; the companion .d.ts is what types it here.
import {
  beliefFieldsForNodeRead,
  beliefNodeReadOutputSchemaFields,
  beliefSetFixedCredenceInputSchemaFields,
  beliefSetFixedCredenceOutputSchemaFields,
  beliefClearFixedCredenceInputSchemaFields,
  beliefClearFixedCredenceOutputSchemaFields,
  beliefMovementsReadInputSchemaFields,
  beliefMovementsReadOutputSchemaFields,
  beliefRecomputeInputSchemaFields,
  beliefRecomputeOutputSchemaFields,
} from '@/services/belief/beliefMcpToolContract';

export const runtime = 'nodejs';
export const maxDuration = 30;

const SERVER_INFO = {
  name: 'ra-h-mcp',
  version: '2.1.1',
};

const instructions = [
  'RA-H is a personal knowledge graph — local-first, vendor-neutral.',
  'The graph is the default working memory for substantive turns.',
  'Core concepts: nodes (knowledge units), edges (connections with explanations), and shared editable skills.',
  'If the user is trying to find a specific existing node, use rah_search_nodes first.',
  'If graph context would help with a broader task, use rah_retrieve_query_context before answering.',
  'Use rah_get_context only for orientation when high-level graph state would actually help.',
  'Do not keep re-running retrieval if you already have enough relevant graph context in play.',
  'Search before creating, and prefer rah_update_node when the artifact is clearly the same thing.',
  'Use rah_list_skills and rah_read_skill for non-trivial workflows that need operating doctrine. Use rah_write_skill and rah_delete_skill when the user explicitly wants to change that shared skill set.',
  'Only suggest saving durable knowledge when it is unusually valuable. Keep the ask brief, for example: Add "X" as a node?',
  'Every edge needs an explanation: why does this connection exist?',
  'Never create or update an edge unless the user has explicitly confirmed the relationship.',
].join(' ');

// The one refusal message every credential failure carries — missing, wrong
// token, or wrong scheme alike. A single constant, so the door never gives an
// attacker an oracle separating "unknown token" from "bad scheme".
const BEARER_REFUSAL_MESSAGE = 'Unauthorized: this MCP door requires a valid bearer token.';

// The one refusal message an UNCONFIGURED door serves — identical whether the
// token is unset or empty, and whether or not the request carried a
// credential. A single constant, so the responses teach a caller nothing
// about server state beyond "unconfigured", and it names RAH_MCP_DOOR_TOKEN
// so the operator can tell configuration failure from credential failure at a
// glance.
const UNCONFIGURED_DOOR_REFUSAL_MESSAGE =
  'Service unavailable: this MCP door has no RAH_MCP_DOOR_TOKEN configured, so it refuses to serve.';

// Compare the presented token against the door's token in constant time:
// both are hashed to equal-length digests first, so timingSafeEqual never
// throws on a length mismatch and the comparison leaks nothing about how far
// the strings matched.
function bearerTokensMatch(presentedToken: string, doorToken: string): boolean {
  const presentedDigest = createHash('sha256').update(presentedToken).digest();
  const doorDigest = createHash('sha256').update(doorToken).digest();
  return timingSafeEqual(presentedDigest, doorDigest);
}

// The lock on the door, run BEFORE any MCP server is built or any request
// forwarded, in this order: an UNCONFIGURED door refuses everything with a
// 503; a configured door refuses a bad credential with a 401. Returns null
// only when the door has a token configured AND the request carries
// `Authorization: Bearer <door token>` exactly. Every refusal is a
// transport-level JSON-RPC error body — never the 200-plus-isError shape,
// which is reserved for in-protocol tool refusals.
function refuseUnlessDoorConfiguredAndBearerValid(request: NextRequest): NextResponse | null {
  const doorToken = process.env.RAH_MCP_DOOR_TOKEN;
  // An unset or EMPTY token (an empty secret is no secret) means the door
  // FAILS CLOSED: this is a server misconfiguration, not a credential
  // failure, so the refusal is HTTP 503 with no WWW-Authenticate challenge —
  // a challenge would invite a retry with a credential, and no credential can
  // open an unconfigured door.
  if (!doorToken) {
    // Logged server-side so the misconfiguration is visible in the deploy's
    // logs, not only to whoever happens to call the door.
    console.error(
      'MCP door refused a request: RAH_MCP_DOOR_TOKEN is not configured, so the door fails closed.'
    );
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        error: {
          // -32003, from JSON-RPC's implementation-defined server-error
          // range: distinct from -32000 (the bearer refusal below) and
          // -32603 (the internal-error path), and skipping -32001 and -32002
          // because the MCP SDK already means "request timed out" and
          // "resource not found" by those.
          code: -32003,
          message: UNCONFIGURED_DOOR_REFUSAL_MESSAGE,
        },
      },
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }

  // The credential must use the Bearer scheme; the door's own token sent bare
  // or under another scheme is malformed and refused like any wrong token.
  const authorizationHeader = request.headers.get('authorization');
  if (authorizationHeader !== null && authorizationHeader.startsWith('Bearer ')) {
    const presentedToken = authorizationHeader.slice('Bearer '.length);
    if (bearerTokensMatch(presentedToken, doorToken)) {
      return null;
    }
  }

  return NextResponse.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: BEARER_REFUSAL_MESSAGE,
      },
    },
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="ra-h-mcp"',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}

function getBaseUrl(request: NextRequest): string {
  const envBase = process.env.RAH_MCP_TARGET_URL || process.env.NEXT_PUBLIC_BASE_URL;
  return (envBase || request.nextUrl.origin).replace(/\/+$/, '');
}

async function callRaHApi(request: NextRequest, pathname: string, options: RequestInit = {}) {
  const response = await fetch(`${getBaseUrl(request)}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.success === false) {
    throw new Error(payload?.error || `RA-H API request failed at ${pathname}`);
  }

  return payload;
}

// The stored-row object both edge-write tools declare under `edge` on their
// output schemas: the four minimum fields every consumer can rely on. Fields
// beyond the id are optional because some forwarded REST replies (a
// support-only correction, for one) answer a row carrying only the id.
const edgeWriteStoredRowOutputSchema = z
  .object({
    id: z.number(),
    from_node_id: z.number().optional(),
    to_node_id: z.number().optional(),
    explanation: z.string().nullable().optional(),
  })
  .optional();

// The stored-row fields an edge-write answer relays under `edge`, taken from
// the row the app's REST layer returned — the FINAL stored orientation (the
// classifier may have swapped the caller's ends), never an echo of the
// request. A missing explanation normalises to null, the same rule
// rah_query_edges applies to a missing key.
function edgeWriteStoredRowAnswerFields(storedEdgeRow: {
  id?: number;
  from_node_id?: number;
  to_node_id?: number;
  explanation?: string | null;
}) {
  return {
    id: storedEdgeRow.id,
    from_node_id: storedEdgeRow.from_node_id,
    to_node_id: storedEdgeRow.to_node_id,
    explanation: storedEdgeRow.explanation ?? null,
  };
}

function createServer(request: NextRequest): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions,
    capabilities: { tools: {} },
  });

  server.registerTool(
    'rah_add_node',
    {
      title: 'Add RA-H node',
      description: 'Create a new node in the local RA-H knowledge base after you have already decided a net-new write is correct. If the user explicitly asked to save or import something and the target artifact is clear, write after duplicate/update checks. If you are only suggesting a save, propose the node first and wait for confirmation.',
      inputSchema: {
        title: z.string().min(1).max(160),
        content: z.string().max(20000).optional(),
        source: z.string().max(50000).optional(),
        link: z.string().url().optional(),
        description: z.string().max(500).optional(),
        metadata: z.record(z.any()).optional(),
        chunk: z.string().max(50000).optional(),
      },
    },
    async ({ title, content, source, link, description, metadata, chunk }) => {
      const payload = await callRaHApi(request, '/api/nodes', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          source: source?.trim() || content?.trim() || chunk?.trim() || undefined,
          link: link?.trim() || undefined,
          description: description?.trim() || undefined,
          metadata: metadata || {},
        }),
      });

      const node = payload.data;
      return {
        content: [{ type: 'text', text: `Created node #${node.id}: ${node.title}` }],
        structuredContent: {
          nodeId: node.id,
          title: node.title,
          message: payload.message || `Created node #${node.id}: ${node.title}`,
        },
      };
    }
  );

  server.registerTool(
    'rah_search_nodes',
    {
      title: 'Search RA-H nodes',
      description: 'Find existing RA-H entries that mention a topic before adding new ones. For full current-turn grounding of a substantive request, prefer `rah_retrieve_query_context`.',
      inputSchema: {
        query: z.string().min(1).max(400),
        limit: z.number().min(1).max(25).optional(),
        createdAfter: z.string().optional(),
        createdBefore: z.string().optional(),
        eventAfter: z.string().optional(),
        eventBefore: z.string().optional(),
      },
    },
    async ({ query, limit = 10, createdAfter, createdBefore, eventAfter, eventBefore }) => {
      const payload = await callRaHApi(request, '/api/nodes/direct-search', {
        method: 'POST',
        body: JSON.stringify({
          query: query.trim(),
          limit: Math.min(Math.max(limit, 1), 25),
          createdAfter: typeof createdAfter === 'string' ? createdAfter.trim() : undefined,
          createdBefore: typeof createdBefore === 'string' ? createdBefore.trim() : undefined,
          eventAfter: typeof eventAfter === 'string' ? eventAfter.trim() : undefined,
          eventBefore: typeof eventBefore === 'string' ? eventBefore.trim() : undefined,
        }),
      });
      const nodes = Array.isArray(payload.data?.nodes) ? payload.data.nodes : [];

      return {
        content: [{ type: 'text', text: nodes.length === 0 ? 'No existing RA-H nodes mention that topic yet.' : `Found ${nodes.length} node(s) mentioning that topic.` }],
        structuredContent: {
          count: nodes.length,
          nodes: nodes.map((node: any) => ({
            id: node.id,
            title: node.title,
            source: node.source ?? null,
            description: node.description ?? null,
            link: node.link ?? null,
            updated_at: node.updated_at,
          })),
        },
      };
    }
  );

  server.registerTool(
    'rah_retrieve_query_context',
    {
      title: 'Retrieve RA-H query context',
      description: 'Given the raw user query plus optional focused node state, retrieve the most relevant graph context for the current turn. It starts with direct graph search and broadens only if useful. Use this when graph context could help answer or complete a broader task. For explicit node lookup, use rah_search_nodes.',
      inputSchema: {
        query: z.string().min(1).max(1000),
        focused_node_id: z.number().int().positive().nullable().optional(),
        limit: z.number().min(1).max(20).optional(),
      },
    },
    async ({ query, focused_node_id, limit = 6 }) => {
      const payload = await callRaHApi(request, '/api/retrieval/query-context', {
        method: 'POST',
        body: JSON.stringify({
          query,
          focused_node_id: focused_node_id ?? null,
          limit,
        }),
      });

      return {
        content: [{
          type: 'text',
          text: payload.data.shouldRetrieve
            ? `Retrieved ${payload.data.nodes.length} node(s) and ${payload.data.chunks.length} chunk(s) for this turn.`
            : payload.data.reason,
        }],
        structuredContent: payload.data,
      };
    }
  );

  server.registerTool(
    'rah_update_node',
    {
      title: 'Update RA-H node',
      description: 'Update an existing node when it is clearly the same artifact and a net-new node would be redundant. Explicit user-directed updates can proceed once the target node is clear.',
      inputSchema: {
        id: z.number().int().positive(),
        updates: z.object({
          title: z.string().optional(),
          description: z.string().max(500).optional(),
          content: z.string().optional(),
          source: z.string().optional(),
          link: z.string().optional(),
          metadata: z.record(z.any()).optional(),
        }),
        source_update_basis: z.string().optional(),
      },
    },
    async ({ id, updates, source_update_basis }) => {
      if (!updates || Object.keys(updates).length === 0) {
        throw new Error('At least one field must be provided in updates.');
      }

      const mappedUpdates = { ...updates } as Record<string, unknown>;
      if (mappedUpdates.chunk !== undefined && mappedUpdates.source === undefined) {
        mappedUpdates.source = mappedUpdates.chunk;
      }
      if (mappedUpdates.content !== undefined && mappedUpdates.source === undefined) {
        mappedUpdates.source = mappedUpdates.content;
      }
      delete mappedUpdates.content;
      delete mappedUpdates.chunk;

      const payload = await callRaHApi(request, `/api/nodes/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...mappedUpdates, source_update_basis }),
      });

      return {
        content: [{ type: 'text', text: `Updated node #${id}` }],
        structuredContent: {
          success: true,
          nodeId: payload.node?.id || id,
          message: payload.message || `Updated node #${id}`,
        },
      };
    }
  );

  server.registerTool(
    'rah_get_nodes',
    {
      title: 'Get RA-H nodes by ID',
      description: 'Load full node records by their IDs.',
      inputSchema: {
        nodeIds: z.array(z.number().int().positive()).min(1).max(10),
      },
      outputSchema: {
        count: z.number(),
        nodes: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            source: z.string().nullable(),
            description: z.string().nullable(),
            link: z.string().nullable(),
            // The node's own metadata bag, reported whole. NULL means nothing
            // was ever recorded about the node, which is a different state
            // from a bag written with no keys — so an absent bag stays null
            // and is never reported as {}.
            metadata: z.record(z.any()).nullable(),
            // When the node was first written, alongside the last-write
            // timestamp.
            created_at: z.string(),
            updated_at: z.string(),
            // Belief-engine node columns (fork addition), declared from the
            // shared contract so both doors advertise them identically.
            ...beliefNodeReadOutputSchemaFields,
          })
        ),
      },
    },
    async ({ nodeIds }) => {
      const uniqueIds = Array.from(new Set(nodeIds.filter((id) => Number.isFinite(id) && id > 0)));
      const nodes: any[] = [];

      for (const id of uniqueIds) {
        try {
          const payload = await callRaHApi(request, `/api/nodes/${id}`);
          if (payload.node) {
            nodes.push({
              id: payload.node.id,
              title: payload.node.title,
              source: payload.node.source ?? null,
              description: payload.node.description ?? null,
              link: payload.node.link ?? null,
              // The app already parses the metadata column into an object (or
              // null). `?? null` normalises only a MISSING key, so "nothing
              // ever recorded" stays null rather than becoming an empty bag.
              metadata: payload.node.metadata ?? null,
              created_at: payload.node.created_at,
              updated_at: payload.node.updated_at,
              // The node's belief columns (fork addition), normalised by the
              // shared contract's mapper: a stored NULL credence stays null
              // (nobody has grounded the node) and a real 0 stays 0.
              ...beliefFieldsForNodeRead(payload.node),
            });
          }
        } catch {
          // Skip missing nodes.
        }
      }

      return {
        content: [{ type: 'text', text: `Loaded ${nodes.length} of ${uniqueIds.length} nodes.` }],
        structuredContent: {
          count: nodes.length,
          nodes,
        },
      };
    }
  );

  server.registerTool(
    'rah_create_edge',
    {
      title: 'Create RA-H edge',
      description: 'Create a connection between two nodes only after the user has explicitly confirmed the proposed relationship. An edge is a plain knowledge-graph relationship: it carries an explanation, never belief data.',
      inputSchema: {
        sourceId: z.number().int().positive(),
        targetId: z.number().int().positive(),
        explanation: z.string().min(1),
        confirmed_by_user: z.boolean(),
      },
      outputSchema: {
        success: z.boolean(),
        edgeId: z.number(),
        message: z.string(),
        // Whether the answer describes an edge that was ALREADY there: the
        // REST duplicate short-circuit's indication relayed structurally, so a
        // caller never has to parse the message to learn nothing new was
        // written.
        already_existed: z.boolean().optional(),
        // The stored row as the app's REST layer returned it.
        edge: edgeWriteStoredRowOutputSchema,
      },
    },
    async ({ sourceId, targetId, explanation, confirmed_by_user }) => {
      if (!confirmed_by_user) {
        throw new Error('rah_create_edge requires explicit user confirmation before writing the relationship.');
      }

      // The forwarded body is rebuilt field by field, so a stray key a stale
      // caller still sends (belief_evidence_support was one) never reaches
      // the app — the input schema already stripped it.
      const edgeCreateBody: Record<string, unknown> = {
        from_node_id: sourceId,
        to_node_id: targetId,
        explanation: explanation.trim(),
        source: 'helper_name',
        created_via: 'mcp',
        confirmed_by_user: true,
      };

      const payload = await callRaHApi(request, '/api/edges', {
        method: 'POST',
        body: JSON.stringify(edgeCreateBody),
      });

      // The stored row the REST layer answered: on a create it is the row
      // that was written (in its FINAL stored orientation), on the duplicate
      // path it is the EXISTING edge's row. The real id and the row itself
      // both come from here, never from the caller's input.
      const storedEdgeRow = payload.edge || payload.data;
      return {
        content: [{ type: 'text', text: `Created edge from #${sourceId} to #${targetId}` }],
        structuredContent: {
          success: true,
          edgeId: storedEdgeRow?.id,
          message: payload.message || `Created edge from #${sourceId} to #${targetId}`,
          // The already-existed indication rides only when REST answered it,
          // so a fresh create never carries a false flag it must explain.
          ...(payload.already_existed === true ? { already_existed: true } : {}),
          ...(storedEdgeRow ? { edge: edgeWriteStoredRowAnswerFields(storedEdgeRow) } : {}),
        },
      };
    }
  );

  server.registerTool(
    'rah_query_edges',
    {
      title: 'Query RA-H edges',
      description: 'Find connections between nodes.',
      inputSchema: {
        nodeId: z.number().int().positive().optional().describe('Find edges connected to this node'),
        // Which side of nodeId to read. Declared as an enum so an unknown value
        // is rejected by the schema before the handler runs — no request
        // reaches the app — and so the three accepted values are discoverable.
        direction: z
          .enum(['into', 'out_of', 'both'])
          .optional()
          .describe('Which side of nodeId to read: "out_of" returns edges whose from_node_id is the node; "into" returns edges whose to_node_id is the node; "both" returns either side. Defaults to "both".'),
        limit: z.number().min(1).max(50).optional().describe('Max edges to return'),
        // Page position. min(0) makes a negative offset a schema rejection,
        // since there is no page before the first one.
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('How many edges to skip before the page begins, over the order created_at DESC then id DESC. 0 is the first page.'),
      },
      outputSchema: {
        count: z.number(),
        edges: z.array(
          z.object({
            id: z.number(),
            from_node_id: z.number(),
            to_node_id: z.number(),
            type: z.string().nullable(),
            // Why the connection exists — the explanation every edge in this
            // graph is required to be created with. Nullable because the
            // mapping normalises a MISSING key to null and a stored NULL stays
            // null; an edge with no explanation must never report an empty
            // string, which would read as an explanation that was written and
            // said nothing.
            explanation: z.string().nullable(),
            // When the edge was written. Nullable for the same reason: a row
            // that arrives without the key normalises to null.
            created_at: z.string().nullable(),
          })
        ),
      },
    },
    // direction defaults to 'both' — either side of the node — and is always
    // sent, so the side being read is explicit in the request the app receives.
    async ({ nodeId, direction = 'both', limit = 25, offset = 0 }) => {
      const params = new URLSearchParams();
      if (nodeId) params.set('nodeId', String(nodeId));
      params.set('direction', direction);
      params.set('limit', String(Math.min(Math.max(limit, 1), 50)));
      params.set('offset', String(offset));

      const payload = await callRaHApi(request, `/api/edges?${params.toString()}`);
      const edges = Array.isArray(payload.data) ? payload.data : [];

      return {
        content: [{ type: 'text', text: `Found ${edges.length} edge(s).` }],
        structuredContent: {
          count: edges.length,
          // The columns are reported under their own names, and the
          // relationship-LABEL confidence is deliberately not reported at all:
          // it says how sure the app is that it typed the relationship, which
          // is not a belief quantity and must never be read as one. The
          // mapping is field by field, so an evidence value a not-yet-migrated
          // app might still report is never relayed.
          edges: edges.map((edge: any) => ({
            id: edge.id,
            from_node_id: edge.from_node_id,
            to_node_id: edge.to_node_id,
            type: edge.context?.type ?? null,
            explanation: edge.explanation ?? null,
            created_at: edge.created_at ?? null,
          })),
        },
      };
    }
  );

  server.registerTool(
    'rah_update_edge',
    {
      title: 'Update RA-H edge',
      description: 'Update an existing edge connection only after the user explicitly confirmed the corrected relationship.',
      inputSchema: {
        id: z.number().int().positive(),
        // The explanation is OPTIONAL: it is the recorded human reasoning for
        // why the connection exists. Omitting it leaves the stored words
        // exactly as they are; a blank one is refused by the handler rather
        // than treated as an omission.
        explanation: z.string().min(1).optional(),
        confirmed_by_user: z.boolean(),
      },
      outputSchema: {
        success: z.boolean(),
        // The corrected edge's id, answered in the same shape as
        // rah_create_edge so a caller reads one answer contract for both
        // edge writes.
        edgeId: z.number(),
        message: z.string(),
        // The UPDATED stored row as the app's REST layer returned it.
        edge: edgeWriteStoredRowOutputSchema,
      },
    },
    async ({ id, explanation, confirmed_by_user }) => {
      if (!confirmed_by_user) {
        throw new Error('rah_update_edge requires explicit user confirmation before writing the corrected relationship.');
      }

      // The corrected explanation, absent when the caller sent none. A
      // SUPPLIED explanation that is blank is refused rather than
      // treated as an omission: writing whitespace over recorded human reasoning
      // destroys it just as surely as inventing replacement prose would.
      const correctedEdgeExplanation = typeof explanation === 'string' ? explanation.trim() : '';
      if (explanation !== undefined && !correctedEdgeExplanation) {
        throw new Error(
          "rah_update_edge refuses a blank explanation. Omit the field entirely to leave the edge's stored explanation unchanged."
        );
      }

      const edgeUpdateBody: Record<string, unknown> = {
        confirmed_by_user: true,
      };

      // Where `created_via: 'mcp'` rides depends on whether this correction
      // writes a context at all. The app assigns `context` WHOLESALE, so a
      // context carrying created_via and no explanation would overwrite the
      // stored one and delete the very reasoning the optional explanation exists
      // to protect — with no explanation to send, created_via must travel
      // TOP-LEVEL instead. It must always travel somewhere: the route defaults a
      // missing created_via to 'ui', and the 'ui' path skips the app-side
      // confirmation gate entirely.
      if (correctedEdgeExplanation) {
        edgeUpdateBody.context = { explanation: correctedEdgeExplanation, created_via: 'mcp' };
      } else {
        edgeUpdateBody.created_via = 'mcp';
      }

      const payload = await callRaHApi(request, `/api/edges/${id}`, {
        method: 'PUT',
        body: JSON.stringify(edgeUpdateBody),
      });

      // The UPDATED stored row the REST PUT answered. The corrected edge's id
      // comes from the row when it carries one, otherwise from the request
      // that named it — the same edge either way.
      const updatedEdgeRow = payload.edge || payload.data;
      return {
        content: [{ type: 'text', text: `Updated edge #${id}` }],
        structuredContent: {
          success: true,
          edgeId: updatedEdgeRow?.id ?? id,
          message: payload.message || `Updated edge #${id}`,
          ...(updatedEdgeRow ? { edge: edgeWriteStoredRowAnswerFields(updatedEdgeRow) } : {}),
        },
      };
    }
  );

  // ========== BELIEF TOOLS (fork addition) ==========
  // All three are validate-and-forward proxies onto the app's belief
  // endpoints; the app is never reimplemented door-side, and every schema
  // comes from the shared contract so the local door advertises exactly the
  // same surface.

  server.registerTool(
    'rah_set_belief_fixed_credence',
    {
      title: 'Set RA-H fixed belief credence',
      description: 'Assert one node\'s belief_credence by hand and mark it as fixed. Belief evidence lives outside this store, so a node\'s credence is either hand-asserted through this tool or null (ungraded). Calling it again replaces the asserted credence in place.',
      inputSchema: beliefSetFixedCredenceInputSchemaFields,
      outputSchema: beliefSetFixedCredenceOutputSchemaFields,
    },
    async ({ node_id, belief_credence }) => {
      // Forward the assertion under the exact column names; the app enforces
      // node existence and the open interval again on its own surface.
      const payload = await callRaHApi(request, '/api/belief/fixed-credence', {
        method: 'POST',
        body: JSON.stringify({ node_id, belief_credence }),
      });

      const summary = payload.message || `Asserted belief_credence ${belief_credence} on node #${node_id}.`;
      return {
        content: [{ type: 'text', text: summary }],
        // The app's standalone-shaped reply, passed through field for field.
        structuredContent: {
          success: true,
          node_id: payload.node_id,
          belief_credence: payload.belief_credence,
          belief_credence_is_fixed: payload.belief_credence_is_fixed,
          belief_computed_at: payload.belief_computed_at,
          message: summary,
        },
      };
    }
  );

  server.registerTool(
    'rah_clear_belief_fixed_credence',
    {
      title: 'Clear RA-H fixed belief credence',
      description: 'Withdraw one node\'s hand-asserted belief_credence: clear its fixed flag and let the node become ungraded. Belief evidence lives outside this store, so a null credence in the reply is a real answer, not an error — never reported as 0.',
      inputSchema: beliefClearFixedCredenceInputSchemaFields,
      outputSchema: beliefClearFixedCredenceOutputSchemaFields,
    },
    async ({ node_id }) => {
      // Forward the withdrawal under the exact column name; the app enforces
      // node existence again on its own surface.
      const payload = await callRaHApi(request, '/api/belief/fixed-credence/clear', {
        method: 'POST',
        body: JSON.stringify({ node_id }),
      });

      const summary = payload.message || `Withdrew the asserted credence of node #${node_id}.`;
      return {
        content: [{ type: 'text', text: summary }],
        // The app's reply, passed through field for field — the regraded
        // credence stays null when the node is now ungraded, never 0.
        structuredContent: {
          success: true,
          node_id: payload.node_id,
          belief_credence: payload.belief_credence ?? null,
          belief_credence_is_fixed: 0,
          message: summary,
        },
      };
    }
  );

  server.registerTool(
    'rah_get_belief_movements',
    {
      title: 'Get RA-H belief movements',
      description: 'Read the log of one node\'s belief_credence changing, newest movement first. Each movement records the credence before the change (null when the node was previously ungraded), the credence after, what caused it, and when it happened. An empty log is a success: the node\'s credence has simply never changed.',
      inputSchema: beliefMovementsReadInputSchemaFields,
      outputSchema: beliefMovementsReadOutputSchemaFields,
    },
    async ({ node_id, limit }) => {
      // node_id rides the query string; the limit forwards so the APP caps
      // the page — the door must not page a log it never loaded.
      const params = new URLSearchParams();
      params.set('node_id', String(node_id));
      if (limit !== undefined) params.set('limit', String(limit));

      const payload = await callRaHApi(request, `/api/belief/movements?${params.toString()}`);

      const movements = Array.isArray(payload.movements) ? payload.movements : [];
      const movementCount = typeof payload.count === 'number' ? payload.count : movements.length;
      return {
        content: [{ type: 'text', text: `Found ${movementCount} movement(s) for node #${node_id}.` }],
        // The app's newest-first order and exact column names pass through
        // untouched.
        structuredContent: {
          count: movementCount,
          movements,
        },
      };
    }
  );

  server.registerTool(
    'rah_recompute_node_belief',
    {
      title: 'Recompute RA-H node belief',
      description: 'Restate one node\'s belief_credence. Belief evidence lives outside this store, so a non-fixed node restates to ungraded — credence null, a real answer, never reported as 0 — and a fixed node reports its hand-asserted credence.',
      inputSchema: beliefRecomputeInputSchemaFields,
      outputSchema: beliefRecomputeOutputSchemaFields,
    },
    async ({ node_id }) => {
      const payload = await callRaHApi(request, '/api/belief/recompute', {
        method: 'POST',
        body: JSON.stringify({ node_id }),
      });

      const summary = payload.message || `Recomputed belief for node #${node_id}.`;
      return {
        content: [{ type: 'text', text: summary }],
        // The regraded credence passes through verbatim — including null,
        // which must stay null and never be coerced to 0.
        structuredContent: {
          success: true,
          node_id: payload.node_id,
          belief_credence: payload.belief_credence ?? null,
          message: summary,
        },
      };
    }
  );

  // ========== GRAPH-EVENT JOURNAL TOOLS (fork addition) ==========
  // The database journals graph deaths and re-orientations into graph_events
  // (trigger-written, with a single-row ack cursor in graph_events_ack).
  // These two tools are the one door a remote consumer reads that journal
  // through — validate-and-forward proxies onto the app's /api/graph-events
  // endpoints, like every other tool on this route.

  server.registerTool(
    'rah_read_graph_events',
    {
      title: 'Read RA-H graph events',
      description: 'Read the unacknowledged graph-event journal: every edge deletion, node deletion, and edge re-orientation with an id greater than the ack cursor, oldest first. Each event carries its full column payload — which edge or node died, or which ends a re-pointed edge had and has now — so a consumer mirroring the graph never needs a second call. Acknowledge handled events with rah_acknowledge_graph_events.',
      inputSchema: {
        // The page size, forwarded so the APP caps the read — the door must
        // not page a journal it never loaded.
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: {
        count: z.number(),
        events: z.array(
          z.object({
            id: z.number(),
            // Which kind of graph event the row journals.
            event_type: z.enum(['edge_deleted', 'node_deleted', 'edge_reoriented']),
            // The dead or re-pointed edge's id; null on a node_deleted row.
            edge_id: z.number().nullable(),
            // The dead node's id; null on the edge event types.
            node_id: z.number().nullable(),
            // A dead edge's ends, or a re-pointed edge's ends NOW; null on a
            // node_deleted row.
            from_node_id: z.number().nullable(),
            to_node_id: z.number().nullable(),
            // The ends a re-pointed edge HAD; null on the other event types.
            old_from_node_id: z.number().nullable(),
            old_to_node_id: z.number().nullable(),
            // When the event happened.
            occurred_at: z.string(),
          })
        ),
      },
    },
    async ({ limit }) => {
      // The limit rides the query string only when the caller named one, so
      // the app's own default governs an unbounded read.
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      const graphEventsQueryString = params.toString();

      const payload = await callRaHApi(
        request,
        `/api/graph-events${graphEventsQueryString ? `?${graphEventsQueryString}` : ''}`
      );

      // The app's id-ascending order and exact column names pass through
      // untouched.
      const graphEvents = Array.isArray(payload.data) ? payload.data : [];
      return {
        content: [{ type: 'text', text: `Found ${graphEvents.length} unacknowledged graph event(s).` }],
        structuredContent: {
          count: graphEvents.length,
          events: graphEvents,
        },
      };
    }
  );

  server.registerTool(
    'rah_acknowledge_graph_events',
    {
      title: 'Acknowledge RA-H graph events',
      description: 'Move the graph-event ack cursor forward: every journal event with an id at or below upToEventId stops being answered by rah_read_graph_events. FORWARD ONLY — the app refuses to move the cursor backward, so an upToEventId at or below the cursor leaves it unchanged. The answered acked_event_id is the cursor AFTER the call.',
      inputSchema: {
        // The highest event id the consumer has handled, forwarded untouched
        // — the forward-only rule is the app's decision, never the door's
        // silent edit.
        upToEventId: z.number().int().min(0),
      },
      outputSchema: {
        success: z.boolean(),
        // The cursor AFTER the call, as the app answered it — which the
        // forward-only rule may have left unchanged.
        acked_event_id: z.number(),
      },
    },
    async ({ upToEventId }) => {
      const payload = await callRaHApi(request, '/api/graph-events/acknowledge', {
        method: 'POST',
        body: JSON.stringify({ upToEventId }),
      });

      return {
        content: [{ type: 'text', text: `Graph-event ack cursor now stands at ${payload.acked_event_id}.` }],
        // The app's cursor relayed honestly — no client-side clamping.
        structuredContent: {
          success: true,
          acked_event_id: payload.acked_event_id,
        },
      };
    }
  );

  server.registerTool(
    'rah_list_skills',
    {
      title: 'List RA-H skills',
      description: 'List the shared skills available to internal and external RA-H agents. Use this to see the current operating doctrine before reading or editing a specific skill.',
      inputSchema: {},
    },
    async () => {
      const result = await callRaHApi(request, '/api/skills', { method: 'GET' });
      const skills = Array.isArray(result.data) ? result.data : [];

      return {
        content: [{ type: 'text', text: `Found ${skills.length} skill(s).` }],
        structuredContent: {
          count: skills.length,
          skills,
        },
      };
    }
  );

  server.registerTool(
    'rah_read_skill',
    {
      title: 'Read RA-H skill',
      description: 'Read one shared RA-H skill by name. Use this before executing a non-trivial workflow that matches the skill trigger.',
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => {
      const result = await callRaHApi(request, `/api/skills/${encodeURIComponent(name)}`, { method: 'GET' });
      return {
        content: [{ type: 'text', text: result.data.content }],
        structuredContent: result.data,
      };
    }
  );

  server.registerTool(
    'rah_write_skill',
    {
      title: 'Write RA-H skill',
      description: 'Create or update a shared RA-H skill when the user explicitly wants to change the doctrine surface. Content should be the full markdown body for that skill.',
      inputSchema: {
        name: z.string().min(1),
        content: z.string().min(1),
      },
    },
    async ({ name, content }) => {
      const result = await callRaHApi(request, '/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name, content }),
      });

      return {
        content: [{ type: 'text', text: `Skill "${name}" saved.` }],
        structuredContent: {
          success: true,
          name,
          message: result.message || `Skill "${name}" saved.`,
        },
      };
    }
  );

  server.registerTool(
    'rah_delete_skill',
    {
      title: 'Delete RA-H skill',
      description: 'Delete a shared RA-H skill when the user explicitly wants it removed from the shared skill set.',
      inputSchema: {
        name: z.string().min(1),
      },
    },
    async ({ name }) => {
      const result = await callRaHApi(request, `/api/skills/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });

      return {
        content: [{ type: 'text', text: `Skill "${name}" deleted.` }],
        structuredContent: {
          success: true,
          name,
          message: result.message || `Skill "${name}" deleted.`,
        },
      };
    }
  );

  server.registerTool(
    'rah_search_embeddings',
    {
      title: 'Semantic search RA-H',
      description: 'Search node content using semantic similarity.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().min(1).max(20).optional(),
      },
    },
    async ({ query, limit = 10 }) => {
      const params = new URLSearchParams();
      params.set('q', query);
      params.set('limit', String(Math.min(Math.max(limit, 1), 20)));

      const payload = await callRaHApi(request, `/api/nodes/search?${params.toString()}`);
      const results = Array.isArray(payload.data) ? payload.data : [];

      return {
        content: [{ type: 'text', text: `Found ${results.length} semantically similar result(s).` }],
        structuredContent: {
          count: results.length,
          results: results.map((result: any) => ({
            nodeId: result.node_id || result.nodeId || result.id,
            title: result.title || 'Untitled',
            chunkPreview: (result.source || '').slice(0, 200),
            similarity: result.similarity || result.score || 0,
          })),
        },
      };
    }
  );

  server.registerTool(
    'rah_extract_url',
    {
      title: 'Extract URL content',
      description: 'Extract content from a webpage URL.',
      inputSchema: {
        url: z.string().url(),
      },
    },
    async ({ url }) => {
      const payload = await callRaHApi(request, '/api/extract/url', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });

      return {
        content: [{ type: 'text', text: `Extracted content from: ${payload.title || 'webpage'}` }],
        structuredContent: {
          success: true,
          title: payload.title || 'Untitled',
          source: payload.source || '',
          metadata: payload.metadata || {},
        },
      };
    }
  );

  server.registerTool(
    'rah_extract_youtube',
    {
      title: 'Extract YouTube transcript',
      description: 'Extract transcript from a YouTube video.',
      inputSchema: {
        url: z.string(),
      },
    },
    async ({ url }) => {
      const payload = await callRaHApi(request, '/api/extract/youtube', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });

      return {
        content: [{ type: 'text', text: `Extracted transcript from: ${payload.title || 'YouTube video'}` }],
        structuredContent: {
          success: true,
          title: payload.title || 'Untitled',
          channel: payload.channel || 'Unknown',
          source: payload.source || '',
          metadata: payload.metadata || {},
        },
      };
    }
  );

  server.registerTool(
    'rah_extract_pdf',
    {
      title: 'Extract PDF content',
      description: 'Extract content from a PDF file URL.',
      inputSchema: {
        url: z.string().url(),
      },
    },
    async ({ url }) => {
      const payload = await callRaHApi(request, '/api/extract/pdf', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });

      return {
        content: [{ type: 'text', text: `Extracted content from: ${payload.title || 'PDF document'}` }],
        structuredContent: {
          success: true,
          title: payload.title || 'Untitled PDF',
          source: payload.source || '',
          metadata: payload.metadata || {},
        },
      };
    }
  );

  server.registerTool(
    'rah_get_context',
    {
      title: 'Get RA-H context',
      description: 'Get orientation context: high-level graph state, hub nodes, stats, and available skills. Use this for orientation only, not as the default retrieval path for substantive requests.',
      inputSchema: {},
    },
    async () => {
      const [hubPayload, skillsPayload, countPayload, edgesPayload] = await Promise.all([
        callRaHApi(request, '/api/nodes?sortBy=edges&limit=10'),
        callRaHApi(request, '/api/skills').catch(() => ({ data: [] })),
        callRaHApi(request, '/api/nodes?limit=1').catch(() => ({ total: 0, count: 0 })),
        callRaHApi(request, '/api/edges?limit=1').catch(() => ({ count: 0, total: 0 })),
      ]);

      const hubNodes = Array.isArray(hubPayload.data) ? hubPayload.data.map((node: any) => ({
        id: node.id,
        title: node.title,
        description: node.description ?? null,
        edgeCount: node.edge_count ?? 0,
      })) : [];

      const skills = Array.isArray(skillsPayload.data) ? skillsPayload.data : [];
      const nodeCount = countPayload.total ?? countPayload.count ?? 0;
      const edgeCount = edgesPayload.total ?? edgesPayload.count ?? 0;

      return {
        content: [{ type: 'text', text: `Knowledge graph: ${nodeCount} nodes, ${edgeCount} edges, ${skills.length} skills available.` }],
        structuredContent: {
          stats: {
            nodeCount,
            edgeCount,
          },
          hubNodes,
          skills,
        },
      };
    }
  );

  return server;
}

export async function POST(request: NextRequest) {
  // The door lock runs first: a refused request builds no MCP server and
  // does no other work.
  const doorRefusal = refuseUnlessDoorConfiguredAndBearerValid(request);
  if (doorRefusal) {
    return doorRefusal;
  }

  try {
    const server = createServer(request);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Answer in a single complete JSON body rather than the default SSE
      // stream. In streaming mode handleRequest returns a Response wrapping a
      // ReadableStream that is filled after this handler has already returned,
      // so the transport.close() below shut the stream controller before a
      // single JSON-RPC message was enqueued and every request came back as
      // HTTP 200 with an empty body. Streaming only earns its keep when a
      // server pushes progress notifications over a long-lived connection;
      // every tool on this door returns one result, and a stateless
      // per-request server that is closed immediately cannot send anything
      // asynchronously anyway. With a complete JSON body, tearing down
      // straight afterwards is safe.
      enableJsonResponse: true,
    });

    await server.connect(transport);
    const response = await transport.handleRequest(request);
    await transport.close();
    await server.close();

    return response;
  } catch (error) {
    console.error('MCP request error:', error);
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal MCP error',
        },
      },
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      // Authorization is listed so browser clients can preflight the bearer;
      // the preflight itself stays open, since it carries no credentials.
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id',
    },
  });
}

export async function GET(request: NextRequest) {
  // The door lock runs first: the discovery listing is metadata about a
  // private store, refused unconfigured or uncredentialed just like a tool
  // call.
  const doorRefusal = refuseUnlessDoorConfiguredAndBearerValid(request);
  if (doorRefusal) {
    return doorRefusal;
  }

  const tools = [
    'rah_add_node',
    'rah_search_nodes',
    'rah_retrieve_query_context',
    'rah_update_node',
    'rah_get_nodes',
    'rah_create_edge',
    'rah_query_edges',
    'rah_update_edge',
    'rah_search_embeddings',
    'rah_extract_url',
    'rah_extract_youtube',
    'rah_extract_pdf',
    'rah_get_context',
    'rah_set_belief_fixed_credence',
    'rah_get_belief_movements',
    'rah_recompute_node_belief',
  ];

  return NextResponse.json(
    {
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      description: 'RA-H Knowledge Graph - Remote MCP Server',
      target: getBaseUrl(request),
      tools,
    },
    {
      headers: { 'Access-Control-Allow-Origin': '*' },
    }
  );
}
