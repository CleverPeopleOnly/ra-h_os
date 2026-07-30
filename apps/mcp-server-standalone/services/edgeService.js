'use strict';

const { query, getDb, runWithBusyRetry } = require('./sqlite-client');

// Connections already proven to have the belief evidence column on their edges
// table. Only the POSITIVE answer is cached, and that is what makes the cache
// safe: a column that exists is never dropped, while a MISSING column can
// appear at any time (a migration — cli.js ensureMinimumSchema, run by init-db
// / setup / doctor — adds it), so a cached "missing" could go stale and a
// cached "present" cannot. Keyed weakly by the connection object so a replaced
// connection takes nothing with it.
const dbConnectionsWithBeliefSupportColumn = new WeakSet();

/**
 * Whether the edges table of the OPEN database has the belief_evidence_support
 * column — i.e. whether this database carries the belief schema at all.
 * initDatabase() opens an existing file and sets pragmas only; it never
 * migrates, so a server can perfectly well be pointed at a database written
 * before the fork added belief.
 *
 * @param {import('better-sqlite3').Database} db The open connection to inspect.
 * @returns {boolean} True when the column exists and evidence can be stored.
 */
function edgesTableHasBeliefSupportColumn(db) {
  if (dbConnectionsWithBeliefSupportColumn.has(db)) return true;

  const edgesTableColumns = db.pragma('table_info(edges)');
  const columnExists = edgesTableColumns.some(
    (column) => column.name === 'belief_evidence_support'
  );
  if (columnExists) dbConnectionsWithBeliefSupportColumn.add(db);

  return columnExists;
}

/**
 * Read edges, optionally narrowed to one node, one side of that node, and one
 * page. Every part of the filter is applied IN SQL, so a capped page is a page
 * of the edges the caller asked for rather than a capped page of the whole
 * table trimmed afterwards. SELECT * keeps both belief columns
 * (belief_evidence_support, belief_evidence_contribution) on every row.
 *
 * @param {object} filters                Edge-read filter.
 * @param {number} [filters.nodeId]       Only edges touching this node.
 * @param {'into'|'out_of'|'both'} [filters.direction]
 *        Which side of nodeId to read: 'into' means the node is the
 *        to_node_id (the evidence feeding its credence), 'out_of' means the
 *        node is the from_node_id, 'both' is either side and is the default.
 * @param {number} [filters.limit]        Page size, default 50.
 * @param {number} [filters.offset]       Edges to skip before the page, default 0.
 *
 * The order is created_at DESC, id DESC: created_at alone is not a total order
 * — rows written in the same millisecond tie, and tied rows can be returned in
 * any order, which would let two pages overlap or skip a row.
 */
function getEdges(filters = {}) {
  const { nodeId, direction = 'both', limit = 50, offset = 0 } = filters;

  let sql = 'SELECT * FROM edges';
  const params = [];

  if (nodeId) {
    if (direction === 'into') {
      // The evidence side: edges pointing AT the node.
      sql += ' WHERE to_node_id = ?';
      params.push(nodeId);
    } else if (direction === 'out_of') {
      sql += ' WHERE from_node_id = ?';
      params.push(nodeId);
    } else {
      sql += ' WHERE (from_node_id = ? OR to_node_id = ?)';
      params.push(nodeId, nodeId);
    }
  }

  sql += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = query(sql, params);

  return rows.map(formatEdgeRow);
}

/**
 * Get edge by ID.
 */
function getEdgeById(id) {
  const rows = query('SELECT * FROM edges WHERE id = ?', [id]);
  if (rows.length === 0) return null;

  return formatEdgeRow(rows[0]);
}

/**
 * Create a new edge.
 * Note: This is a simplified version without AI inference.
 * The main app handles edge type inference.
 */
function createEdge(edgeData) {
  const {
    from_node_id,
    to_node_id,
    explanation,
    source = 'mcp',
    // Belief evidence field (fork addition): one unsigned support value in
    // [0, 1] — how strongly the source node talks about the target — stored
    // verbatim in the dedicated belief_ edge column. The standalone server
    // stores evidence but NEVER grades — belief_evidence_contribution is
    // never written here.
    belief_evidence_support
  } = edgeData;
  const now = new Date().toISOString();
  const db = getDb();

  if (!from_node_id || !to_node_id) {
    throw new Error('from_node_id and to_node_id are required');
  }

  if (!explanation || !explanation.trim()) {
    throw new Error('Edge explanation is required');
  }

  const cleanExplanation = explanation.trim();

  // Simple context without AI inference
  // The main app can re-infer types when it loads
  const context = {
    type: 'related_to',
    confidence: 0.5,
    inferred_at: now,
    explanation: cleanExplanation,
    created_via: 'mcp'
  };

  // Which INSERT is possible is a question about the DATABASE: only a database
  // carrying the belief schema has a column to name. Asked before the write so
  // a refusal leaves no row behind.
  const tableHasBeliefSupportColumn = edgesTableHasBeliefSupportColumn(db);

  // What the caller asked to store is a separate question, and it decides only
  // what gets bound.
  const callerSuppliedBeliefEvidenceSupport = belief_evidence_support !== undefined;

  if (callerSuppliedBeliefEvidenceSupport && !tableHasBeliefSupportColumn) {
    throw new Error(
      'This database predates the belief schema: its edges table is missing the ' +
      'belief_evidence_support column, so the support on this edge cannot be stored. ' +
      'Migrate the database first — run the init-db command (npx ra-h-mcp-server init-db) — ' +
      'then write the evidence edge again. No edge was created.'
    );
  }

  const stmt = tableHasBeliefSupportColumn
    ? db.prepare(`
        INSERT INTO edges (from_node_id, to_node_id, context, source, created_at, explanation,
                           belief_evidence_support)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
    : db.prepare(`
        INSERT INTO edges (from_node_id, to_node_id, context, source, created_at, explanation)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

  const result = runWithBusyRetry(() => tableHasBeliefSupportColumn
      ? stmt.run(
          from_node_id,
          to_node_id,
          JSON.stringify(context),
          source,
          now,
          cleanExplanation,
          belief_evidence_support ?? null
        )
      : stmt.run(
          from_node_id,
          to_node_id,
          JSON.stringify(context),
          source,
          now,
          cleanExplanation
        ),
    'createEdge'
  );

  const edgeId = Number(result.lastInsertRowid);
  return getEdgeById(edgeId);
}

/**
 * Update an edge.
 */
function updateEdge(id, updates) {
  const { explanation, context: contextUpdates } = updates;
  const db = getDb();

  const existing = getEdgeById(id);
  if (!existing) {
    throw new Error(`Edge with ID ${id} not found. Use rah_query_edges to find edges by node ID.`);
  }

  const cleanExplanation = typeof explanation === 'string' ? explanation.trim() : '';

  // If explanation changed, update both the normal field and the compatibility copy.
  if (cleanExplanation) {
    const now = new Date().toISOString();
    const newContext = {
      ...existing.context,
      explanation: cleanExplanation,
      inferred_at: now,
      created_via: 'mcp'
    };

    const stmt = db.prepare('UPDATE edges SET context = ?, explanation = ? WHERE id = ?');
    runWithBusyRetry(() => stmt.run(JSON.stringify(newContext), cleanExplanation, id), 'updateEdge');
  } else if (contextUpdates) {
    const contextExplanation = typeof contextUpdates.explanation === 'string'
      ? contextUpdates.explanation.trim()
      : '';
    const newContext = {
      ...existing.context,
      ...contextUpdates,
      ...(contextExplanation ? { explanation: contextExplanation } : {})
    };
    if (contextExplanation) {
      const stmt = db.prepare('UPDATE edges SET context = ?, explanation = ? WHERE id = ?');
      runWithBusyRetry(() => stmt.run(JSON.stringify(newContext), contextExplanation, id), 'updateEdge');
    } else {
      const stmt = db.prepare('UPDATE edges SET context = ? WHERE id = ?');
      runWithBusyRetry(() => stmt.run(JSON.stringify(newContext), id), 'updateEdge');
    }
  }

  return getEdgeById(id);
}

/**
 * Delete an edge.
 */
function deleteEdge(id) {
  const result = query('DELETE FROM edges WHERE id = ?', [id]);
  if (result.changes === 0) {
    throw new Error(`Edge with ID ${id} not found. Use rah_query_edges to find edges by node ID.`);
  }
  return true;
}

/**
 * Get connections for a node.
 */
function getNodeConnections(nodeId) {
  const sql = `
    SELECT
      e.*,
      CASE
        WHEN e.from_node_id = ? THEN n_to.id
        ELSE n_from.id
      END as connected_node_id,
      CASE
        WHEN e.from_node_id = ? THEN n_to.title
        ELSE n_from.title
      END as connected_node_title,
      CASE
        WHEN e.from_node_id = ? THEN n_to.description
        ELSE n_from.description
      END as connected_node_description,
      CASE
        WHEN e.from_node_id = ? THEN n_to.link
        ELSE n_from.link
      END as connected_node_link,
      CASE
        WHEN e.from_node_id = ? THEN n_to.source
        ELSE n_from.source
      END as connected_node_source,
      CASE
        WHEN e.from_node_id = ? THEN n_to.updated_at
        ELSE n_from.updated_at
      END as connected_node_updated_at,
      CASE
        WHEN e.from_node_id = ? THEN n_to.metadata
        ELSE n_from.metadata
      END as connected_node_metadata
    FROM edges e
    LEFT JOIN nodes n_from ON e.from_node_id = n_from.id
    LEFT JOIN nodes n_to ON e.to_node_id = n_to.id
    WHERE e.from_node_id = ? OR e.to_node_id = ?
    ORDER BY e.created_at DESC
  `;

  const rows = query(sql, [nodeId, nodeId, nodeId, nodeId, nodeId, nodeId, nodeId, nodeId, nodeId]);

  return rows.map(row => ({
    edgeId: row.id,
    from_node_id: row.from_node_id,
    to_node_id: row.to_node_id,
    context: parseContext(row.context),
    connected_node: {
      id: row.connected_node_id,
      title: row.connected_node_title,
      description: row.connected_node_description,
      link: row.connected_node_link,
      source: row.connected_node_source,
      updated_at: row.connected_node_updated_at,
      metadata: parseContext(row.connected_node_metadata)
    }
  }));
}

/**
 * Get edge count.
 */
function getEdgeCount() {
  const rows = query('SELECT COUNT(*) as count FROM edges');
  return Number(rows[0].count);
}

function formatEdgeRow(row) {
  const context = parseContext(row.context);
  return {
    ...row,
    context,
    explanation: row.explanation || context?.explanation || null
  };
}

/**
 * Parse context JSON safely.
 */
function parseContext(context) {
  if (!context) return null;
  if (typeof context === 'object') return context;
  try {
    return JSON.parse(context);
  } catch {
    return context;
  }
}

module.exports = {
  getEdges,
  getEdgeById,
  createEdge,
  updateEdge,
  deleteEdge,
  getNodeConnections,
  getEdgeCount
};
