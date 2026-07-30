export type NodeMetadataState = 'processed' | 'not_processed';
export type NodeCapturedBy = 'human' | 'agent';

export interface CanonicalNodeMetadata {
  type?: string;
  state?: NodeMetadataState;
  captured_method?: string;
  captured_by?: NodeCapturedBy;
  source_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

// New Node-based type system replacing rigid Item categorization
export interface Node {
  id: number;
  title: string;
  description?: string;
  source?: string;            // Canonical embeddable content
  notes?: string;             // Deprecated legacy field - do not write
  link?: string;
  event_date?: string | null; // When the thing actually happened (ISO 8601)
  embedding?: Buffer;         // Node-level embedding (BLOB data)
  chunk?: string;             // Deprecated legacy field - do not write
  metadata?: CanonicalNodeMetadata | null; // Flexible metadata storage with canonical contract
  created_at: string;
  updated_at: string;
  edge_count?: number;       // Derived count of edges, included in some queries

  // Optional embedding fields
  embedding_updated_at?: string;
  embedding_text?: string;
  chunk_status?: 'not_chunked' | 'chunking' | 'chunked' | 'error' | null;
}

export interface Chunk {
  id: number;
  node_id: number;           // Updated from item_id to node_id
  chunk_idx?: number;
  text: string;
  embedding?: number[];
  embedding_type: string;
  metadata?: any;            // Updated from extras to metadata
  created_at: string;
}

export interface Edge {
  id: number;
  from_node_id: number;
  to_node_id: number;
  context?: any;
  source: EdgeSource;
  created_at: string;
  // Belief-engine evidence columns (fork addition). Both are read straight off
  // the edges row, and NULL is a meaningful state on each of them.
  // How strongly the from-node talks about the to-node: one UNSIGNED number in
  // [0, 1]. NULL means the edge is not evidence at all (a plain relationship
  // edge, never assessed); 0 means it was assessed and carries nothing.
  belief_evidence_support?: number | null;
  // What this edge adds to its target: the from-node's signed belief_credence
  // × this edge's support, stamped by the belief engine. NULL means the edge
  // has never been graded — the state the recovery sweep looks for — so it
  // must never be reported as 0.
  belief_evidence_contribution?: number | null;
}

// Which side of a node an edge read is asking for. 'into' is the evidence
// side: those edges point AT the node and feed its belief_credence. 'out_of'
// is the mirror side, the edges the node itself supplies. 'both' is either
// side and is the default.
export type BeliefEdgeReadDirection = 'into' | 'out_of' | 'both';

// The filter an edge read accepts. Applied IN SQL by every edge read, so both
// belief columns of the selected page reach the caller untouched. The
// parameter names are the ones the API route and both MCP doors use.
export interface BeliefEdgeReadFilter {
  // Only edges touching this node; omitted means the whole edges table.
  nodeId?: number;
  // Which side of nodeId to read; omitted means 'both'.
  direction?: BeliefEdgeReadDirection;
  // Page size. Omitted means no cap at all — an unfiltered read still returns
  // every edge, which the in-memory queryEdge tool depends on.
  limit?: number;
  // How many edges to skip before the page begins; omitted means 0.
  offset?: number;
}

export type EdgeSource = 'user' | 'ai_similarity' | 'helper_name';

export type EdgeContextType =
  | 'created_by'   // Content → Creator (book by author, podcast by host)
  | 'part_of'      // Part → Whole (episode of podcast, person discussed in book)
  | 'source_of'    // Derivative → Source (insight from article)
  | 'related_to';  // Default — anything else or when unsure

export type EdgeCreatedVia = 'ui' | 'agent' | 'mcp' | 'workflow' | 'quicklink' | 'quick_capture_auto';

export interface EdgeContext {
  // SYSTEM-INFERRED (AI classifies from explanation + nodes)
  type: EdgeContextType;
  confidence: number;   // 0-1
  inferred_at: string;  // ISO timestamp

  // PROVIDED AT CREATION / EDIT
  explanation: string;

  // SYSTEM-MANAGED
  created_via: EdgeCreatedVia;
}

// New NodeFilters interface replacing rigid ItemFilters
export interface NodeFilters {
  search?: string;           // Text search in title/content
  searchMode?: 'standard' | 'hybrid'; // standard = FTS/LIKE, hybrid = add node-vector retrieval
  chunkStatus?: 'not_chunked' | 'chunking' | 'chunked' | 'error';
  limit?: number;
  offset?: number;
  sortBy?: 'updated' | 'edges' | 'created' | 'event_date';  // Sort by updated_at, edge count, created_at, or event_date
  createdAfter?: string;     // ISO date (YYYY-MM-DD) — nodes created on or after
  createdBefore?: string;    // ISO date (YYYY-MM-DD) — nodes created before
  eventAfter?: string;       // ISO date (YYYY-MM-DD) — nodes with event_date on or after
  eventBefore?: string;      // ISO date (YYYY-MM-DD) — nodes with event_date before
}

export interface ChunkData {
  node_id: number;           // Updated from item_id
  chunk_idx?: number;
  text: string;
  embedding?: number[];
  embedding_type: string;
  metadata?: any;            // Updated from extras
}

export interface EdgeData {
  from_node_id: number;
  to_node_id: number;
  explanation: string;
  created_via: EdgeCreatedVia;
  source: EdgeSource;
  skip_inference?: boolean; // reserved for bulk imports / migrations
  // Belief-engine evidence field (MR-A). When belief_evidence_support is set
  // the edge is evidence bearing on the to-node and edge creation triggers a
  // belief recompute of that node. Stored in a dedicated edge column, never
  // in the app-owned context JSON.
  // How strongly the from-node talks about the to-node, as one unsigned
  // number in [0, 1]: 0 means assessed and carries nothing, absent means the
  // edge is not evidence at all. Which way the evidence cuts comes from the
  // from-node's signed belief_credence, never from this field.
  belief_evidence_support?: number;
}

export interface ChatData {
  user_message?: string;
  assistant_message?: string;
  thread_id: string;
  focused_node_id?: number;  // Updated from focused_item_id
  metadata?: any;
  embedding?: number[];      // Renamed from content_embedding
}

// New NodeConnection interface
export interface NodeConnection {
  id: number;
  connected_node: Node;      // Updated from connected_item
  edge: Edge;
}

export interface DatabaseError {
  message: string;
  code?: string;
  details?: any;
}

export interface Dimension {
  name: string;
  description?: string | null;
  icon?: string | null;
  is_priority: boolean;
  updated_at: string;
}
