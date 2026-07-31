#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const packageJson = require('../../package.json');
// The fork-owned belief pieces of the MCP tool contract, shared verbatim with
// the remote door (app/api/mcp/route.ts) so the two cannot drift apart again.
const {
  beliefEvidenceSupportInputSchemaForEdgeCreate,
  beliefEvidenceSupportInputSchemaForEdgeUpdate,
  beliefEvidenceFieldsForEdgeRead,
  beliefEvidenceEdgeReadOutputSchemaFields
} = require('../../src/services/belief/beliefMcpToolContract.js');

const instructions = [
  'RA-H is a personal knowledge graph — local-first, vendor-neutral.',
  'The graph is the default working memory for substantive turns.',
  'Core concepts: nodes (knowledge units), edges (connections with explanations), and shared editable skills.',
  'If the user is trying to find a specific existing node, use rah_search_nodes first.',
  'If graph context would help with a broader task, use rah_retrieve_query_context before answering.',
  'Use rah_get_context only when high-level graph orientation would actually help.',
  'Do not keep re-running retrieval if you already have enough relevant graph context in play.',
  'Search before creating, and prefer rah_update_node when the artifact is clearly the same thing.',
  'Use rah_list_skills and rah_read_skill for non-trivial workflows that need operating doctrine. Use rah_write_skill and rah_delete_skill when the user explicitly wants to change that shared skill set.',
  'Only suggest saving durable knowledge when it is unusually valuable. Keep the ask brief, for example: Add "X" as a node?',
  'Do not create edges autonomously. Surface likely edge candidates briefly, then call edge-write tools only after the user explicitly confirms.',
  'Every edge needs an explanation: why does this connection exist?',
  'All data stays local on this device; nothing leaves 127.0.0.1.',
].join(' ');

const serverInfo = {
  name: 'ra-h-local-stdio',
  version: packageJson.version || '0.0.0'
};

const STATUS_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'RA-H',
  'config',
  'mcp-status.json'
);

const addNodeInputSchema = {
  title: z.string().min(1).max(160),
  content: z.string().max(20000).optional(),
  source: z.string().max(50000).optional(),
  link: z.string().url().optional(),
  description: z.string().max(500).optional().describe('Description of the node. Write it as natural prose, not labels or a checklist. It must still make clear what the artifact is, why it is in the graph (infer from conversation context; ask the user if needed), and its current workflow status. Max 500 characters. If the reason is unclear, say that naturally instead of inventing it. Never use filler phrases like "insightful for understanding" or "relevant to the user\'s work".'),
  metadata: z.record(z.any()).optional().describe('Optional metadata. Prefer canonical keys: type, state, captured_method, captured_by, source_metadata.'),
  chunk: z.string().max(50000).optional()
};

const addNodeOutputSchema = {
  nodeId: z.number(),
  title: z.string(),
  message: z.string()
};

const searchNodesInputSchema = {
  query: z.string().min(1).max(400),
  limit: z.number().min(1).max(50).optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  eventAfter: z.string().optional(),
  eventBefore: z.string().optional()
};

const searchNodesOutputSchema = {
  count: z.number(),
  nodes: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      source: z.string().nullable(),
      description: z.string().nullable(),
      link: z.string().nullable(),
      updated_at: z.string()
    })
  )
};

const retrieveQueryContextInputSchema = {
  query: z.string().min(1).max(800),
  focused_node_id: z.number().int().positive().nullable().optional(),
  limit: z.number().min(1).max(12).optional()
};

const retrieveQueryContextOutputSchema = {
  query: z.string(),
  shouldRetrieve: z.boolean(),
  mode: z.enum(['skip', 'focused', 'query']),
  reason: z.string(),
  focused_node_id: z.number().nullable(),
  nodes: z.array(z.object({
    id: z.number(),
    title: z.string(),
    description: z.string().nullable(),
    link: z.string().nullable(),
    updated_at: z.string(),
    kind: z.enum(['focused', 'query_match', 'neighbor']),
    reason: z.string(),
    seed_node_id: z.number().optional()
  })),
  chunks: z.array(z.object({
    id: z.number(),
    node_id: z.number(),
    node_title: z.string(),
    preview: z.string(),
    similarity: z.number()
  }))
};

// rah_update_node schemas
const updateNodeInputSchema = {
  id: z.number().int().positive().describe('The ID of the node to update'),
  updates: z.object({
    title: z.string().optional().describe('New title'),
    description: z.string().max(500).optional().describe('Description of the node. Write it as natural prose, not labels or a checklist. It must still make clear what the artifact is, why it is in the graph (infer from conversation context; ask the user if needed), and its current workflow status. Max 500 characters. If the reason is unclear, say that naturally instead of inventing it. Never use filler phrases like "insightful for understanding" or "relevant to the user\'s work".'),
    content: z.string().optional().describe('Legacy alias for source. Mapped to source for backward compatibility.'),
    source: z.string().optional().describe('Canonical source text for embedding.'),
    link: z.string().optional().describe('New link'),
    metadata: z.record(z.any()).optional().describe('Metadata patch. This now merges with existing metadata. Prefer canonical keys: type, state, captured_method, captured_by, source_metadata.')
  }).describe('Fields to update'),
  source_update_basis: z.string().optional().describe('When rewriting source on a node that already has source text, include a short exact excerpt from the current source you inspected first.')
};

const updateNodeOutputSchema = {
  success: z.boolean(),
  nodeId: z.number(),
  message: z.string()
};

// rah_get_nodes schemas
const getNodesInputSchema = {
  nodeIds: z.array(z.number().int().positive()).min(1).max(10).describe('List of node IDs to load')
};

const getNodesOutputSchema = {
  count: z.number(),
  nodes: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      source: z.string().nullable(),
      description: z.string().nullable(),
      link: z.string().nullable(),
      // The node's own metadata bag, reported whole. NULL means nothing was
      // ever recorded about the node, which is a different state from a bag
      // written with no keys — so an absent bag stays null and is never
      // reported as {}.
      metadata: z.record(z.any()).nullable(),
      // When the node was first written, alongside the last-write timestamp.
      created_at: z.string(),
      updated_at: z.string()
    })
  )
};

const readSkillInputSchema = {
  name: z.string().min(1).describe('Skill name')
};

const writeSkillInputSchema = {
  name: z.string().min(1).describe('Skill name to create or update'),
  content: z.string().min(1).describe('Full markdown content, including frontmatter when needed')
};

const deleteSkillInputSchema = {
  name: z.string().min(1).describe('Skill name to delete')
};

// rah_create_edge schemas
const createEdgeInputSchema = {
  sourceId: z.number().int().positive().describe('Source node ID'),
  targetId: z.number().int().positive().describe('Target node ID'),
  explanation: z.string().min(1).describe('REQUIRED: Why does this connection exist? Be specific.'),
  confirmed_by_user: z.boolean().describe('Must be true. Only create the edge after the user explicitly confirmed this proposed relationship.'),
  // Belief evidence field (fork addition): optional, forwarded verbatim to
  // the app's /api/edges — the app-owned belief engine does the grading.
  // Support is UNSIGNED, 0..1: how strongly the source node talks about the
  // target. Which way the evidence cuts comes from the source NODE's signed
  // credence, never from this field. Omitting the field says "not evidence at
  // all"; a support of 0 says the edge WAS assessed and carries nothing — a
  // recorded judgement, never rejected, because a classifier that finds no
  // bearing must not have to invent one. Taken from the shared contract so the
  // remote door advertises exactly the same argument.
  belief_evidence_support: beliefEvidenceSupportInputSchemaForEdgeCreate
};

const createEdgeOutputSchema = {
  success: z.boolean(),
  edgeId: z.number(),
  message: z.string()
};

// rah_query_edges schemas
const queryEdgesInputSchema = {
  nodeId: z.number().int().positive().optional().describe('Find edges connected to this node'),
  // Which side of nodeId to read. Declared as an enum so an unknown value is
  // rejected by the schema before the handler runs — no request reaches the
  // app — and so the three accepted values are discoverable.
  direction: z
    .enum(['into', 'out_of', 'both'])
    .optional()
    .describe('Which side of nodeId to read: "into" returns edges whose to_node_id is the node — the evidence feeding its belief_credence; "out_of" returns edges whose from_node_id is the node; "both" returns either side. Defaults to "both".'),
  limit: z.number().min(1).max(50).optional().describe('Max edges to return'),
  // Page position. min(0) makes a negative offset a schema rejection, since
  // there is no page before the first one.
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('How many edges to skip before the page begins, over the order created_at DESC then id DESC. 0 is the first page.')
};

const queryEdgesOutputSchema = {
  count: z.number(),
  edges: z.array(
    z.object({
      id: z.number(),
      from_node_id: z.number(),
      to_node_id: z.number(),
      type: z.string().nullable(),
      // Why the connection exists — the explanation every edge in this graph is
      // required to be created with. Nullable because the mapping normalises a
      // MISSING key to null and a stored NULL stays null; an edge with no
      // explanation must never report an empty string, which would read as an
      // explanation that was written and said nothing.
      explanation: z.string().nullable(),
      // When the edge was written. Nullable for the same reason: a row that
      // arrives without the key normalises to null rather than to undefined.
      created_at: z.string().nullable(),
      // Belief-engine evidence columns (fork addition), reported verbatim and
      // declared from the shared contract so both doors advertise them
      // identically.
      ...beliefEvidenceEdgeReadOutputSchemaFields
    })
  )
};

// rah_update_edge schemas
const updateEdgeInputSchema = {
  id: z.number().int().positive().describe('Edge ID to update'),
  // The explanation is OPTIONAL: it is the recorded human reasoning for why the
  // connection exists, and correcting how strongly the source talks about its
  // neighbour is not an occasion to rewrite it. There is no read-one-edge-by-id
  // tool to fetch the stored words and hand them back, so a required
  // explanation would force a support correction to invent prose over them.
  // Omitting it leaves the stored explanation untouched; a blank one is refused
  // by the handler rather than treated as an omission.
  explanation: z.string().min(1).optional().describe('New explanation text (will re-infer relationship type). Omit the field entirely to correct only the belief evidence support and leave the stored explanation exactly as it is.'),
  confirmed_by_user: z.boolean().describe('Must be true. Only update the edge after the user explicitly confirmed the corrected relationship.'),
  // Belief evidence field (fork addition): the same unsigned 0..1 support
  // rah_create_edge accepts, so a support written once can be corrected later.
  // The range is enforced here, before any request reaches the app. Omitting
  // the field leaves the stored support exactly as it is; null un-assesses the
  // edge so it stops being evidence at all; a support of 0 says the edge WAS
  // assessed and carries nothing — a recorded judgement, never rejected. Taken
  // from the shared contract so the remote door advertises exactly the same
  // argument.
  belief_evidence_support: beliefEvidenceSupportInputSchemaForEdgeUpdate
};

const updateEdgeOutputSchema = {
  success: z.boolean(),
  message: z.string()
};

// rah_search_embeddings schemas
const searchEmbeddingsInputSchema = {
  query: z.string().min(1).describe('Semantic search query'),
  limit: z.number().min(1).max(20).optional().describe('Max results')
};

const searchEmbeddingsOutputSchema = {
  count: z.number(),
  results: z.array(
    z.object({
      nodeId: z.number(),
      title: z.string(),
      chunkPreview: z.string(),
      similarity: z.number()
    })
  )
};

// rah_extract_url schemas
const extractUrlInputSchema = {
  url: z.string().url().describe('URL of the webpage to extract content from')
};

const extractUrlOutputSchema = {
  success: z.boolean(),
  title: z.string(),
  source: z.string(),
  metadata: z.record(z.any())
};

// rah_extract_youtube schemas
const extractYoutubeInputSchema = {
  url: z.string().describe('YouTube video URL to extract transcript from')
};

const extractYoutubeOutputSchema = {
  success: z.boolean(),
  title: z.string(),
  channel: z.string(),
  source: z.string(),
  metadata: z.record(z.any())
};

// rah_extract_pdf schemas
const extractPdfInputSchema = {
  url: z.string().url().describe('URL of the PDF file to extract content from')
};

const extractPdfOutputSchema = {
  success: z.boolean(),
  title: z.string(),
  source: z.string(),
  metadata: z.record(z.any())
};

const server = new McpServer(serverInfo, { instructions });

function logError(...args) {
  console.error('[ra-h-stdio]', ...args);
}

function readStatusFile() {
  try {
    if (!fs.existsSync(STATUS_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(STATUS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function resolveBaseUrl() {
  const envTarget = process.env.RAH_MCP_TARGET_URL || process.env.NEXT_PUBLIC_BASE_URL;
  if (envTarget && envTarget.trim().length > 0) {
    return envTarget.replace(/\/+$/, '');
  }

  const isReachableBaseUrl = async (candidate) => {
    if (!candidate) return false;
    const normalized = String(candidate).replace(/\/+$/, '');
    try {
      const response = await fetch(`${normalized}/api/nodes?limit=1`, {
        method: 'GET',
        signal: AbortSignal.timeout(1500)
      });
      return response.ok;
    } catch {
      return false;
    }
  };

  const status = readStatusFile();
  const candidates = [
    status?.target_base_url ? String(status.target_base_url) : null,
    process.env.NEXT_PUBLIC_BASE_URL || null,
    'http://127.0.0.1:3000'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await isReachableBaseUrl(candidate)) {
      return String(candidate).replace(/\/+$/, '');
    }
  }

  return 'http://127.0.0.1:3000';
}

async function callRaHApi(pathname, options = {}) {
  const baseUrl = (await resolveBaseUrl()).replace(/\/+$/, '');
  const targetUrl = `${baseUrl}${pathname}`;

  const response = await fetch(targetUrl, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success === false) {
    const errorMessage = body?.error || `RA-H API request failed at ${pathname}`;
    throw new Error(errorMessage);
  }
  return body;
}

function withVisibleJson(summary, payload) {
  return `${summary}\n\n${JSON.stringify(payload, null, 2)}`;
}

server.registerTool(
  'rah_add_node',
  {
    title: 'Add RA-H node',
    description: 'Create a new node after you have already decided a net-new write is correct. Search first with rah_search_nodes, and prefer rah_update_node if the artifact is clearly the same thing. If the user explicitly asked to save or import something and the target artifact is clear, write after duplicate/update checks. If you are only suggesting a save, propose the node first and wait for confirmation.',
    inputSchema: addNodeInputSchema,
    outputSchema: addNodeOutputSchema
  },
  async ({ title, content, source, link, description, metadata, chunk }) => {
    const payload = {
      title: title.trim(),
      source: source?.trim() || content?.trim() || chunk?.trim() || undefined,
      link: link?.trim() || undefined,
      description: description?.trim() || undefined,
      metadata: metadata || {}
    };

    const result = await callRaHApi('/api/nodes', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const node = result.data;
    const summary = `Created node #${node.id}: ${node.title}`;

    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: {
        nodeId: node.id,
        title: node.title,
        message: result.message || summary
      }
    };
  }
);

server.registerTool(
  'rah_search_nodes',
  {
    title: 'Search RA-H nodes',
    description: 'Find existing RA-H entries that mention a topic before adding new ones. Use this first for direct lookup, duplicate checks, or when the user seems to be referring to an existing node. For broader current-turn grounding, prefer rah_retrieve_query_context.',
    inputSchema: searchNodesInputSchema,
    outputSchema: searchNodesOutputSchema
  },
  async ({ query, limit = 10, createdAfter, createdBefore, eventAfter, eventBefore }) => {
    const result = await callRaHApi('/api/nodes/direct-search', {
      method: 'POST',
      body: JSON.stringify({
        query: query.trim(),
        limit: Math.min(Math.max(limit, 1), 50),
        createdAfter,
        createdBefore,
        eventAfter,
        eventBefore,
      })
    });

    const nodes = Array.isArray(result.data?.nodes) ? result.data.nodes : [];
    const summary =
      nodes.length === 0
        ? 'No existing RA-H nodes mention that topic yet.'
        : `Found ${nodes.length} node(s) mentioning that topic.`;
    const mappedNodes = nodes.map((node) => ({
      id: node.id,
      title: node.title,
      source: node.source ?? null,
      description: node.description ?? null,
      link: node.link ?? null,
      updated_at: node.updated_at
    }));
    const payload = {
      count: nodes.length,
      nodes: mappedNodes
    };

    return {
      content: [{ type: 'text', text: nodes.length === 0 ? summary : withVisibleJson(summary, payload) }],
      structuredContent: payload
    };
  }
);

server.registerTool(
  'rah_retrieve_query_context',
  {
    title: 'Retrieve RA-H query context',
    description: 'Given the raw user query plus optional focused node state, retrieve the most relevant graph context for the current turn. Use this when graph context could help answer, plan, or complete a broader task. For explicit node lookup or duplicate checks, use rah_search_nodes first.',
    inputSchema: retrieveQueryContextInputSchema,
    outputSchema: retrieveQueryContextOutputSchema
  },
  async ({ query, focused_node_id, limit = 6 }) => {
    const result = await callRaHApi('/api/retrieval/query-context', {
      method: 'POST',
      body: JSON.stringify({
        query,
        focused_node_id: focused_node_id ?? null,
        limit
      })
    });

    const data = result.data;
    const summary = data.shouldRetrieve
      ? `Retrieved ${data.nodes.length} node(s) and ${data.chunks.length} chunk(s) for this turn.`
      : data.reason;

    return {
      content: [{ type: 'text', text: data.shouldRetrieve ? withVisibleJson(summary, data) : summary }],
      structuredContent: data
    };
  }
);

server.registerTool(
  'rah_update_node',
  {
    title: 'Update RA-H node',
    description: 'Update an existing node when it is clearly the same artifact and a net-new node would be redundant. Inspect current state with rah_get_nodes first when accuracy matters. When rewriting source on a node that already has source text, inspect that source first and include source_update_basis as a short exact excerpt you actually read.',
    inputSchema: updateNodeInputSchema,
    outputSchema: updateNodeOutputSchema
  },
  async ({ id, updates, source_update_basis }) => {
    if (!updates || Object.keys(updates).length === 0) {
      throw new Error('At least one field must be provided in updates.');
    }

    // Backward compatibility: map legacy content/chunk → source
    const mappedUpdates = { ...updates };
    if (mappedUpdates.chunk !== undefined && mappedUpdates.source === undefined) {
      mappedUpdates.source = mappedUpdates.chunk;
    }
    if (mappedUpdates.content !== undefined) {
      mappedUpdates.source = mappedUpdates.content;
      delete mappedUpdates.content;
    }
    delete mappedUpdates.chunk;

    const result = await callRaHApi(`/api/nodes/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...mappedUpdates, source_update_basis })
    });

    const node = result.node || result.data;
    return {
      content: [{ type: 'text', text: `Updated node #${id}` }],
      structuredContent: {
        success: true,
        nodeId: node?.id || id,
        message: result.message || `Updated node #${id}`
      }
    };
  }
);

server.registerTool(
  'rah_get_nodes',
  {
    title: 'Get RA-H nodes by ID',
    description: 'Load node records by ID, including current source text and description. Use this before rewriting source or when a focused-node excerpt is not enough.',
    inputSchema: getNodesInputSchema,
    outputSchema: getNodesOutputSchema
  },
  async ({ nodeIds }) => {
    const uniqueIds = Array.from(new Set(nodeIds.filter(id => Number.isFinite(id) && id > 0)));
    if (uniqueIds.length === 0) {
      throw new Error('No valid node IDs provided.');
    }

    const nodes = [];
    for (const id of uniqueIds) {
      try {
        const result = await callRaHApi(`/api/nodes/${id}`, { method: 'GET' });
        if (result.node) {
          nodes.push({
            id: result.node.id,
            title: result.node.title,
            source: result.node.source ?? null,
            description: result.node.description ?? null,
            link: result.node.link ?? null,
            // The app already parses the metadata column into an object (or
            // null). `?? null` normalises only a MISSING key, so "nothing ever
            // recorded" stays null rather than becoming an empty bag.
            metadata: result.node.metadata ?? null,
            created_at: result.node.created_at,
            updated_at: result.node.updated_at
          });
        }
      } catch (e) {
        // Skip missing nodes
      }
    }

    return {
      content: [{ type: 'text', text: `Loaded ${nodes.length} of ${uniqueIds.length} nodes.` }],
      structuredContent: {
        count: nodes.length,
        nodes
      }
    };
  }
);

server.registerTool(
  'rah_create_edge',
  {
    title: 'Create RA-H edge',
    description: 'Create a connection between two nodes only after the user has explicitly confirmed the proposed relationship. Check existing edges first when you are not already sure the relationship is new.',
    inputSchema: createEdgeInputSchema,
    outputSchema: createEdgeOutputSchema
  },
  async ({ sourceId, targetId, explanation, confirmed_by_user, belief_evidence_support }) => {
    if (!confirmed_by_user) {
      throw new Error('rah_create_edge requires explicit user confirmation before writing the relationship.');
    }

    const payload = {
      from_node_id: sourceId,
      to_node_id: targetId,
      explanation: explanation.trim(),
      source: 'helper_name',
      created_via: 'mcp',
      confirmed_by_user: true
    };

    // Belief evidence pass-through (fork addition): include the signed
    // support only when the caller supplied it, so plain relationship edges
    // keep an evidence-free payload.
    if (belief_evidence_support !== undefined) payload.belief_evidence_support = belief_evidence_support;

    const result = await callRaHApi('/api/edges', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const edge = result.edge || result.data;
    return {
      content: [{ type: 'text', text: `Created edge from #${sourceId} to #${targetId}` }],
      structuredContent: {
        success: true,
        edgeId: edge?.id || 0,
        message: result.message || `Created edge from #${sourceId} to #${targetId}`
      }
    };
  }
);

server.registerTool(
  'rah_query_edges',
  {
    title: 'Query RA-H edges',
    description: 'Find connections between nodes.',
    inputSchema: queryEdgesInputSchema,
    outputSchema: queryEdgesOutputSchema
  },
  // direction defaults to 'both' — either side of the node — and is always
  // sent, so the side being read is explicit in the request the app receives.
  async ({ nodeId, direction = 'both', limit = 25, offset = 0 }) => {
    const params = new URLSearchParams();
    if (nodeId) params.set('nodeId', String(nodeId));
    params.set('direction', direction);
    params.set('limit', String(Math.min(Math.max(limit, 1), 50)));
    params.set('offset', String(offset));

    const result = await callRaHApi(`/api/edges?${params.toString()}`, {
      method: 'GET'
    });

    const edges = Array.isArray(result.data) ? result.data : [];
    return {
      content: [{ type: 'text', text: `Found ${edges.length} edge(s).` }],
      structuredContent: {
        count: edges.length,
        // The explanation, the creation timestamp and both belief columns pass
        // through verbatim. `?? null` normalises only a MISSING key to null; a
        // stored NULL is already null and a real 0 is kept as 0, so an ungraded
        // evidence edge never looks graded and an unexplained edge never looks
        // like one explained with an empty string. The belief columns get that
        // same normalisation from the shared contract's mapper.
        edges: edges.map(e => ({
          id: e.id,
          from_node_id: e.from_node_id,
          to_node_id: e.to_node_id,
          type: e.type ?? e.source ?? null,
          explanation: e.explanation ?? null,
          created_at: e.created_at ?? null,
          ...beliefEvidenceFieldsForEdgeRead(e)
        }))
      }
    };
  }
);

server.registerTool(
  'rah_update_edge',
  {
    title: 'Update RA-H edge',
    description: 'Update an existing edge connection only after the user explicitly confirmed the corrected relationship. Use this when the connection already exists and only the explanation needs correction.',
    inputSchema: updateEdgeInputSchema,
    outputSchema: updateEdgeOutputSchema
  },
  async ({ id, explanation, confirmed_by_user, belief_evidence_support }) => {
    if (!confirmed_by_user) {
      throw new Error('rah_update_edge requires explicit user confirmation before writing the corrected relationship.');
    }

    // The corrected explanation, absent when this is a support-only correction.
    // A SUPPLIED explanation that is blank is refused rather than treated as an
    // omission: writing whitespace over recorded human reasoning destroys it
    // just as surely as inventing replacement prose would.
    const correctedEdgeExplanation = typeof explanation === 'string' ? explanation.trim() : '';
    if (explanation !== undefined && !correctedEdgeExplanation) {
      throw new Error('rah_update_edge refuses a blank explanation. Omit the field entirely to leave the edge\'s stored explanation unchanged.');
    }

    const payload = { confirmed_by_user: true };

    // Where `created_via: 'mcp'` rides depends on whether this correction writes
    // a context at all. The app assigns `context` WHOLESALE, so a context
    // carrying created_via and no explanation would overwrite the stored one and
    // delete the very reasoning the optional explanation exists to protect —
    // with no explanation to send, created_via must travel TOP-LEVEL instead. It
    // must always travel somewhere: the route defaults a missing created_via to
    // 'ui', and the 'ui' path skips the app-side confirmation gate entirely.
    if (correctedEdgeExplanation) {
      payload.context = { explanation: correctedEdgeExplanation, created_via: 'mcp' };
    } else {
      payload.created_via = 'mcp';
    }

    // Belief evidence pass-through (fork addition): include the corrected
    // support only when the caller supplied one, so an explanation-only
    // correction still sends an evidence-free payload rather than turning a
    // plain relationship edge into assessed evidence. The test is against
    // undefined and not against null, because an explicit null is the caller
    // un-assessing the edge and must reach the app present and null — a dropped
    // key reads as "no support supplied" and leaves the edge graded. Sent
    // TOP-LEVEL, not inside context, because it belongs to the edges column and
    // not to the app-owned context JSON.
    if (belief_evidence_support !== undefined) payload.belief_evidence_support = belief_evidence_support;

    const result = await callRaHApi(`/api/edges/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    return {
      content: [{ type: 'text', text: `Updated edge #${id}` }],
      structuredContent: {
        success: true,
        message: result.message || `Updated edge #${id}`
      }
    };
  }
);

server.registerTool(
  'rah_list_skills',
  {
    title: 'List RA-H skills',
    description: 'List the shared skills available to internal and external RA-H agents. Use this to see the current operating doctrine before reading or editing a specific skill.',
    inputSchema: {}
  },
  async () => {
    const result = await callRaHApi('/api/skills', { method: 'GET' });
    const skills = Array.isArray(result.data) ? result.data : [];

    return {
      content: [{ type: 'text', text: `Found ${skills.length} skill(s).` }],
      structuredContent: {
        count: skills.length,
        skills
      }
    };
  }
);

server.registerTool(
  'rah_read_skill',
  {
    title: 'Read RA-H skill',
    description: 'Read one shared RA-H skill by name. Use this before executing a non-trivial workflow that matches the skill trigger.',
    inputSchema: readSkillInputSchema
  },
  async ({ name }) => {
    const result = await callRaHApi(`/api/skills/${encodeURIComponent(name)}`, { method: 'GET' });
    return {
      content: [{ type: 'text', text: result.data.content }],
      structuredContent: result.data
    };
  }
);

server.registerTool(
  'rah_write_skill',
  {
    title: 'Write RA-H skill',
    description: 'Create or update a shared RA-H skill when the user explicitly wants to change the doctrine surface. Content should be the full markdown body for that skill.',
    inputSchema: writeSkillInputSchema
  },
  async ({ name, content }) => {
    const result = await callRaHApi('/api/skills', {
      method: 'POST',
      body: JSON.stringify({ name, content })
    });

    return {
      content: [{ type: 'text', text: `Skill "${name}" saved.` }],
      structuredContent: {
        success: true,
        name,
        message: result.message || `Skill "${name}" saved.`
      }
    };
  }
);

server.registerTool(
  'rah_delete_skill',
  {
    title: 'Delete RA-H skill',
    description: 'Delete a shared RA-H skill when the user explicitly wants it removed from the shared skill set.',
    inputSchema: deleteSkillInputSchema
  },
  async ({ name }) => {
    const result = await callRaHApi(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'DELETE'
    });

    return {
      content: [{ type: 'text', text: `Skill "${name}" deleted.` }],
      structuredContent: {
        success: true,
        name,
        message: result.message || `Skill "${name}" deleted.`
      }
    };
  }
);

server.registerTool(
  'rah_search_embeddings',
  {
    title: 'Semantic search RA-H',
    description: 'Search node content using semantic similarity (vector search).',
    inputSchema: searchEmbeddingsInputSchema,
    outputSchema: searchEmbeddingsOutputSchema
  },
  async ({ query, limit = 10 }) => {
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('limit', String(Math.min(Math.max(limit, 1), 20)));

    const result = await callRaHApi(`/api/nodes/search?${params.toString()}`, {
      method: 'GET'
    });

    const results = Array.isArray(result.data) ? result.data : [];
    return {
      content: [{ type: 'text', text: `Found ${results.length} semantically similar result(s).` }],
      structuredContent: {
        count: results.length,
        results: results.map(r => ({
          nodeId: r.node_id || r.nodeId || r.id,
          title: r.title || 'Untitled',
          chunkPreview: (r.source || '').slice(0, 200),
          similarity: r.similarity || r.score || 0
        }))
      }
    };
  }
);

server.registerTool(
  'rah_extract_url',
  {
    title: 'Extract URL content',
    description: 'Extract content from a webpage URL. Returns title, content, and metadata for creating nodes.',
    inputSchema: extractUrlInputSchema,
    outputSchema: extractUrlOutputSchema
  },
  async ({ url }) => {
    const result = await callRaHApi('/api/extract/url', {
      method: 'POST',
      body: JSON.stringify({ url })
    });

    const summary = `Extracted content from: ${result.title || 'webpage'}`;
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: {
        success: true,
        title: result.title || 'Untitled',
        source: result.source || '',
        metadata: result.metadata || {}
      }
    };
  }
);

server.registerTool(
  'rah_extract_youtube',
  {
    title: 'Extract YouTube transcript',
    description: 'Extract transcript from a YouTube video. Returns title, channel, transcript, and metadata.',
    inputSchema: extractYoutubeInputSchema,
    outputSchema: extractYoutubeOutputSchema
  },
  async ({ url }) => {
    const result = await callRaHApi('/api/extract/youtube', {
      method: 'POST',
      body: JSON.stringify({ url })
    });

    const summary = `Extracted transcript from: ${result.title || 'YouTube video'}`;
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: {
        success: true,
        title: result.title || 'Untitled',
        channel: result.channel || 'Unknown',
        source: result.source || '',
        metadata: result.metadata || {}
      }
    };
  }
);

server.registerTool(
  'rah_extract_pdf',
  {
    title: 'Extract PDF content',
    description: 'Extract content from a PDF file URL. Returns title, content, and metadata for creating nodes.',
    inputSchema: extractPdfInputSchema,
    outputSchema: extractPdfOutputSchema
  },
  async ({ url }) => {
    const result = await callRaHApi('/api/extract/pdf', {
      method: 'POST',
      body: JSON.stringify({ url })
    });

    const summary = `Extracted content from: ${result.title || 'PDF document'}`;
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: {
        success: true,
        title: result.title || 'Untitled PDF',
        source: result.source || '',
        metadata: result.metadata || {}
      }
    };
  }
);

// rah_get_context — orientation tool for external agents
const getContextOutputSchema = {
  stats: z.object({
    nodeCount: z.number(),
    edgeCount: z.number()
  }),
  hubNodes: z.array(z.object({
    id: z.number(),
    title: z.string(),
    description: z.string().nullable(),
    edgeCount: z.number()
  })),
  skills: z.array(z.object({
    name: z.string(),
    description: z.string(),
    immutable: z.boolean().optional(),
  }))
};

server.registerTool(
  'rah_get_context',
  {
    title: 'Get RA-H context',
    description: 'Get orientation context: high-level graph state, hub nodes, stats, and available skills. Use this for orientation only, not as the default retrieval path for substantive requests.',
    inputSchema: {},
    outputSchema: getContextOutputSchema
  },
  async () => {
    const hubResult = await callRaHApi('/api/nodes?sortBy=edges&limit=10', { method: 'GET' });
    const hubNodes = Array.isArray(hubResult.data) ? hubResult.data.map(n => ({
      id: n.id,
      title: n.title,
      description: n.description ?? null,
      edgeCount: n.edge_count ?? 0
    })) : [];

    const skillResult = await callRaHApi('/api/skills', { method: 'GET' });
    const skills = Array.isArray(skillResult.data) ? skillResult.data : [];

    const stats = {
      nodeCount: 0,
      edgeCount: 0
    };

    try {
      const countResult = await callRaHApi('/api/nodes?limit=1', { method: 'GET' });
      if (countResult.total !== undefined) {
        stats.nodeCount = countResult.total;
      }
    } catch { /* use defaults */ }

    try {
      const edgeResult = await callRaHApi('/api/edges', { method: 'GET' });
      if (typeof edgeResult.count === 'number') {
        stats.edgeCount = edgeResult.count;
      }
    } catch { /* use defaults */ }

    const summary = `Knowledge graph: ${stats.nodeCount} nodes, ${stats.edgeCount} edges, ${hubNodes.length} hub nodes, ${skills.length} skills available.`;

    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: {
        stats,
        hubNodes,
        skills
      }
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logError('STDIO MCP server ready');
}

main().catch((error) => {
  logError('Fatal error:', error);
  process.exit(1);
});
