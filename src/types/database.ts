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

  // Belief-engine node columns (fork addition), read straight off the nodes
  // row. NULL is a meaningful state on the first two.
  // How much this node is believed — the ONLY signed quantity in the system.
  // NULL means nobody has grounded the node, which must never collapse into 0
  // (assessed and believed neither way).
  belief_credence?: number | null;
  // When the credence was stamped; NULL exactly when the node is ungraded.
  belief_computed_at?: string | null;
  // 0/1 flag: 1 says a human asserted the credence by hand instead of samai
  // grading it. NOT NULL DEFAULT 0, so it has no null state.
  belief_credence_is_fixed?: number;
  // How little evidence the credence rests on: UNSIGNED, in (0, 1], the
  // STORED display column samai writes beside the credence through the
  // remote door (samai owns the belief engine since the storage split).
  // NULL means never assessed — a real state, never coerced to a number.
  belief_uncertainty?: number | null;
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

// An edge is a plain knowledge-graph relationship: belief evidence left this
// fork (it lives in samai's own store now), so an edge row carries no belief
// field of any kind.
export interface Edge {
  id: number;
  from_node_id: number;
  to_node_id: number;
  context?: any;
  source: EdgeSource;
  created_at: string;
}

// Which side of a node an edge read is asking for. 'out_of' is the edges
// leaving the node (its from_node_id side); 'into' is the mirror side, the
// edges pointing at it. 'both' is either side and is the default.
export type BeliefEdgeReadDirection = 'into' | 'out_of' | 'both';

// The filter an edge read accepts. Applied IN SQL by every edge read. The
// parameter names are the ones the API route and both MCP doors use.
export interface BeliefEdgeReadFilter {
  // Only edges touching this node; omitted means the whole edges table.
  nodeId?: number;
  // Which side of nodeId to read; omitted means 'both'.
  direction?: BeliefEdgeReadDirection;
  // Only edges created this way (the edges.source column: who or what made the
  // edge, not the source NODE); omitted means every source.
  edgeSource?: EdgeSource;
  // Page size. Omitted means no cap at all — the SQL read then returns every
  // edge matching the rest of the filter. Callers that face a caller-sized
  // graph always set it: an uncapped read of a graph with 100,000s of edges is
  // a memory failure mode, so a page size is the norm and omitting it is the
  // exception (a maintenance sweep that genuinely must see every row).
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
