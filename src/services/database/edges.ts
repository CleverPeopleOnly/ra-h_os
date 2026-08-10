import { getSQLiteClient } from './sqlite-client';
import {
  BeliefEdgeReadFilter,
  Edge,
  EdgeContext,
  EdgeData,
  EdgeCreatedVia,
  NodeConnection,
  Node,
} from '@/types/database';
import { eventBroadcaster } from '../events';
import { nodeService } from './nodes';
import { z } from 'zod';
import { validateEdgeExplanation } from './quality';
import { generateUtilityText } from '@/services/llm/provider';
import { recomputeNodeBelief } from '@/services/belief/beliefService';

const inferredEdgeContextSchema = z.object({
  type: z.enum(['created_by', 'part_of', 'source_of', 'related_to']),
  confidence: z.number().min(0).max(1),
  swap_direction: z.boolean(),
});

async function inferEdgeContext(params: {
  explanation: string;
  fromNode: Node;
  toNode: Node;
}): Promise<{ type: EdgeContext['type']; confidence: number; swap_direction: boolean }> {
  const { explanation, fromNode, toNode } = params;

  // Heuristic fast-paths for common patterns.
  // This makes classification robust and reduces reliance on the model.
  const norm = explanation.trim().toLowerCase();
  const startsWithAny = (prefixes: string[]) => prefixes.some((p) => norm.startsWith(p));

  // "Created by X" → FROM was created by TO (no swap needed)
  if (startsWithAny(['created by', 'made by', 'authored by', 'written by', 'founded by'])) {
    return { type: 'created_by', confidence: 1.0, swap_direction: false };
  }
  // "Author of X" → FROM is the author, so we need TO→FROM for created_by (swap needed)
  if (startsWithAny(['author of', 'creator of', 'wrote', 'made', 'founded', 'created'])) {
    return { type: 'created_by', confidence: 1.0, swap_direction: true };
  }
  if (startsWithAny(['part of', 'episode of', 'belongs to', 'in the series', 'in this series'])) {
    return { type: 'part_of', confidence: 1.0, swap_direction: false };
  }
  if (startsWithAny(['contains', 'includes', 'features', 'mentions', 'hosted by', 'guest:', 'host:'])) {
    // FROM contains/features TO → TO is part of FROM (swap needed)
    return { type: 'part_of', confidence: 0.95, swap_direction: true };
  }
  if (startsWithAny(['came from', 'inspired by', 'derived from', 'based on', 'from', 'ideas from', 'insights from', 'ideas or insights from'])) {
    // "FROM came from TO" / "FROM has ideas from TO" → no swap needed
    return { type: 'source_of', confidence: 0.9, swap_direction: false };
  }
  if (startsWithAny(['inspired', 'source for', 'source of', 'led to'])) {
    // "FROM inspired TO" / "FROM is source of TO" → swap needed (TO came from FROM)
    return { type: 'source_of', confidence: 0.9, swap_direction: true };
  }
  if (startsWithAny(['related to', 'related'])) {
    return { type: 'related_to', confidence: 0.8, swap_direction: false };
  }

  const prompt = [
    `Given two nodes and an explanation, determine the relationship type and direction.`,
    ``,
    `FROM: "${fromNode.title}" — ${fromNode.description || 'No description'}`,
    `TO: "${toNode.title}" — ${toNode.description || 'No description'}`,
    `Explanation: "${explanation}"`,
    ``,
    `Edge types (the arrow shows required direction):`,
    `- created_by: Content → Creator (e.g., "Book" → "Author", "Article" → "Writer")`,
    `- part_of: Part → Whole (e.g., "Episode" → "Podcast", "Chapter" → "Book")`,
    `- source_of: Derivative → Source (e.g., "Insight" → "Article it came from")`,
    `- related_to: General relationship (bidirectional, no swap needed)`,
    ``,
    `IMPORTANT: Check if FROM and TO match the required direction for the type.`,
    `- If FROM is a Person/Creator and TO is Content, and type is created_by → swap_direction: true`,
    `- If FROM is a Whole and TO is a Part, and type is part_of → swap_direction: true`,
    `- If FROM is a Source and TO is Derivative, and type is source_of → swap_direction: true`,
    ``,
    `Return JSON: {"type": "...", "swap_direction": bool, "confidence": 0.X}`
  ].join('\n');

  try {
    const text = await generateUtilityText({
      prompt,
      temperature: 0.0,
      maxOutputTokens: 120,
      responseFormat: 'json',
      task: 'edge_inference',
    });

    const parsedJson = (() => {
      try {
        return JSON.parse(text);
      } catch {
        // Sometimes models wrap JSON in prose; try to recover.
        const match = text.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error('AI did not return valid JSON');
      }
    })();

    const parsed = inferredEdgeContextSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { type: 'related_to', confidence: 0.2, swap_direction: false };
    }

    return parsed.data;
  } catch (error) {
    console.warn('[edges] inferEdgeContext failed; falling back to related_to', error);
    return { type: 'related_to', confidence: 0.2, swap_direction: false };
  }
}

// Auto-generate explanation and infer type when user doesn't provide an explanation
async function autoInferEdge(params: {
  fromNode: Node;
  toNode: Node;
}): Promise<{ explanation: string; type: EdgeContext['type']; confidence: number; swap_direction: boolean }> {
  const { fromNode, toNode } = params;

  const prompt = [
    `Given two knowledge base nodes, determine how they are related.`,
    ``,
    `FROM: "${fromNode.title}"`,
    `Description: ${fromNode.description || 'No description'}`,
    ``,
    `TO: "${toNode.title}"`,
    `Description: ${toNode.description || 'No description'}`,
    ``,
    `Edge types (Content→Creator means the arrow goes FROM content TO creator):`,
    `- created_by: Content → Person/Creator. The content node points to its creator.`,
    `- part_of: Part → Whole (episode→podcast, chapter→book)`,
    `- source_of: Derivative → Source (summary→original, insight→article)`,
    `- related_to: DEFAULT. Similar topics, related concepts, or when unsure.`,
    ``,
    `CRITICAL RULES:`,
    `1. If BOTH are documents/articles/content → use "related_to" or "source_of", NEVER "created_by"`,
    `2. If FROM is a Person and TO is Content they created → use "created_by" with swap_direction: TRUE`,
    `3. If FROM is Content and TO is the Person who created it → use "created_by" with swap_direction: FALSE`,
    `4. When unsure → use "related_to"`,
    ``,
    `Return JSON: {"explanation": "...", "type": "...", "swap_direction": bool, "confidence": 0.X}`,
  ].join('\n');

  try {
    const text = await generateUtilityText({
      prompt,
      temperature: 0.0,
      maxOutputTokens: 150,
      responseFormat: 'json',
      task: 'edge_inference',
    });

    const parsedJson = (() => {
      try {
        return JSON.parse(text);
      } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error('AI did not return valid JSON');
      }
    })();

    const schema = z.object({
      explanation: z.string(),
      type: z.enum(['created_by', 'part_of', 'source_of', 'related_to']),
      confidence: z.number().min(0).max(1),
      swap_direction: z.boolean(),
    });

    const parsed = schema.safeParse(parsedJson);
    if (!parsed.success) {
        return {
        explanation: `Connection to ${toNode.title}; exact relationship uncertain.`,
        type: 'related_to',
        confidence: 0.2,
        swap_direction: false,
      };
    }

    return parsed.data;
  } catch (error) {
    console.warn('[edges] autoInferEdge failed; falling back', error);
    return {
      explanation: `Connection to ${toNode.title}; exact relationship uncertain.`,
      type: 'related_to',
      confidence: 0.2,
      swap_direction: false,
    };
  }
}

// One value bound to a placeholder of an edge-read WHERE clause: a node id or
// an edge source string.
type BoundEdgeReadValue = number | string;

// The SQL narrowing one BeliefEdgeReadFilter describes: the WHERE clause text
// and the values its placeholders take. Built once and used by both the page
// read and the matching count, which is what stops the two from drifting apart
// and reporting a total that does not describe the page beside it.
interface BeliefEdgeReadNarrowing {
  // The clause to splice straight after the table name, already prefixed with
  // ' WHERE ', or the empty string when the filter narrows nothing.
  whereSql: string;
  // The bound values, in the order their placeholders appear in whereSql.
  boundValues: BoundEdgeReadValue[];
}

// Turn an edge-read filter's narrowing half (node, side of node, edge source)
// into one WHERE clause. The paging half (limit, offset) is deliberately NOT
// here: a page is a property of one read, while this clause defines the set
// being read — the count needs the clause without the paging.
function buildBeliefEdgeReadNarrowing(
  edgeReadFilter: BeliefEdgeReadFilter
): BeliefEdgeReadNarrowing {
  const { nodeId, direction = 'both', edgeSource } = edgeReadFilter;
  const whereClauses: string[] = [];
  const boundValues: BoundEdgeReadValue[] = [];

  if (nodeId !== undefined) {
    if (direction === 'into') {
      // Edges pointing AT the node. Under canon (spec §8) these belong to
      // the nodes deriving FROM it, not to the node's own evidence basis.
      whereClauses.push('to_node_id = ?');
      boundValues.push(nodeId);
    } else if (direction === 'out_of') {
      // Edges leaving the node — under canon, its own evidence basis.
      whereClauses.push('from_node_id = ?');
      boundValues.push(nodeId);
    } else {
      whereClauses.push('(from_node_id = ? OR to_node_id = ?)');
      boundValues.push(nodeId, nodeId);
    }
  }

  if (edgeSource !== undefined) {
    whereClauses.push('source = ?');
    boundValues.push(edgeSource);
  }

  return {
    whereSql: whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '',
    boundValues,
  };
}

// One edges row exactly as SQLite hands it back. The only difference from the
// Edge callers receive is the context column, which is stored as JSON text.
type StoredEdgeRow = Omit<Edge, 'context'> & { context?: string | null };

// Turn a stored edges row into an Edge by parsing its context JSON. A context
// that will not parse is passed through as the raw string rather than dropped,
// so a caller can still see what is in the column.
function parseStoredEdgeRow(row: StoredEdgeRow): Edge {
  const storedContext = row.context;
  if (typeof storedContext !== 'string') {
    return { ...row, context: storedContext };
  }
  try {
    return { ...row, context: JSON.parse(storedContext) };
  } catch {
    return { ...row, context: storedContext };
  }
}

export class EdgeService {
  // Read edges, optionally narrowed to one node, one side of that node, one
  // edge source, and one page. Every part of the filter is applied IN SQL, so a
  // capped page is a page of the edges the caller asked for rather than a
  // capped page of the whole table trimmed afterwards. SELECT * keeps both
  // belief columns (belief_evidence_support, belief_evidence_contribution) on
  // every row. The order is created_at DESC, id DESC: created_at alone is not a
  // total order — rows written in the same millisecond tie, and tied rows can
  // be returned in any order, which would let two pages overlap or skip a row.
  // An omitted limit means no cap.
  async getEdges(edgeReadFilter: BeliefEdgeReadFilter = {}): Promise<Edge[]> {
    const sqlite = getSQLiteClient();
    const { limit, offset } = edgeReadFilter;

    // The same WHERE the matching count uses, so a page and its total can
    // never be narrowed differently.
    const narrowing = buildBeliefEdgeReadNarrowing(edgeReadFilter);
    const queryParams: BoundEdgeReadValue[] = [...narrowing.boundValues];

    let sql = `SELECT * FROM edges${narrowing.whereSql} ORDER BY created_at DESC, id DESC`;
    if (limit !== undefined) {
      sql += ' LIMIT ?';
      queryParams.push(limit);
    }
    if (offset !== undefined) {
      // SQLite only accepts OFFSET after a LIMIT; -1 is its "no cap" limit, so
      // a page position without a page size still reads to the end.
      if (limit === undefined) sql += ' LIMIT -1';
      sql += ' OFFSET ?';
      queryParams.push(offset);
    }

    const result = sqlite.query<StoredEdgeRow>(sql, queryParams);
    return result.rows.map(parseStoredEdgeRow);
  }

  async getEdgeById(id: number): Promise<Edge | null> {
    const sqlite = getSQLiteClient();
    const result = sqlite.query<StoredEdgeRow>('SELECT * FROM edges WHERE id = ?', [id]);
    const row = result.rows[0];
    if (!row) return null;
    return parseStoredEdgeRow(row);
  }

  async createEdge(edgeData: EdgeData): Promise<Edge> {
    return this.createEdgeSQLite(edgeData);
  }

  // PostgreSQL path removed in SQLite-only consolidation

  private async createEdgeSQLite(edgeData: EdgeData): Promise<Edge> {
    const now = new Date().toISOString();
    const sqlite = getSQLiteClient();

    // Belief-evidence door check: a non-NULL support must sit in [0, 1].
    // Support is UNSIGNED — how strongly the source node talks about the
    // target — and contradiction is expressed by the source NODE's negative
    // credence, never by the edge. NULL passes (the edge is simply not
    // evidence) and 0 passes (assessed, carries nothing). Checked before any
    // inference or insert so a rejected support writes no edge row.
    if (
      edgeData.belief_evidence_support != null &&
      (edgeData.belief_evidence_support < 0 || edgeData.belief_evidence_support > 1)
    ) {
      throw new Error(
        `belief_evidence_support must be between 0 and 1 (got ${edgeData.belief_evidence_support}). ` +
          'Support is unsigned; a contradicting source is expressed by that source node\'s negative belief_credence.'
      );
    }

    const createdVia: EdgeCreatedVia = edgeData.created_via;

    // Fetch nodes for inference context
    const [fromNode, toNode] = await Promise.all([
      nodeService.getNodeById(edgeData.from_node_id),
      nodeService.getNodeById(edgeData.to_node_id),
    ]);

    if (!fromNode) throw new Error(`Source node ${edgeData.from_node_id} not found`);
    if (!toNode) throw new Error(`Target node ${edgeData.to_node_id} not found`);

    let explanation = (edgeData.explanation || '').trim();
    let inferred: { type: EdgeContext['type']; confidence: number; swap_direction: boolean };

    if (!explanation && !edgeData.skip_inference) {
      // Auto-generate explanation and infer type
      const autoResult = await autoInferEdge({ fromNode, toNode });
      explanation = autoResult.explanation;
      inferred = {
        type: autoResult.type,
        confidence: autoResult.confidence,
        swap_direction: autoResult.swap_direction,
      };
    } else if (edgeData.skip_inference) {
      inferred = { type: 'related_to' as const, confidence: 0.0, swap_direction: false };
      if (!explanation) explanation = `Connection to ${toNode.title}; exact relationship uncertain.`;
    } else {
      const explanationError = validateEdgeExplanation(explanation);
      if (explanationError) {
        throw new Error(explanationError);
      }
      inferred = await inferEdgeContext({ explanation, fromNode, toNode });
    }

    // Apply swap_direction: flip from/to if inference determined direction should be reversed
    const finalFromId = inferred.swap_direction ? edgeData.to_node_id : edgeData.from_node_id;
    const finalToId = inferred.swap_direction ? edgeData.from_node_id : edgeData.to_node_id;

    const context: EdgeContext = {
      type: inferred.type,
      confidence: inferred.confidence,
      inferred_at: now,
      explanation,
      created_via: createdVia,
    };

    // Whether this edge is evidence the belief engine must grade, which decides
    // one thing only: whether writing it regrades its derived end — the
    // from-node under canon (spec §8: an evidence edge runs Derivative→Source).
    // A non-NULL unsigned support is what makes an edge evidence (0 counts —
    // assessed, carries nothing; NULL means never assessed, so nothing to
    // grade). Evidence lives in a dedicated column; the context JSON stays
    // app-owned.
    const edgeIsGradeableBeliefEvidence = edgeData.belief_evidence_support != null;

    const result = sqlite.prepare(`
      INSERT INTO edges (from_node_id, to_node_id, context, source, created_at, explanation,
                         belief_evidence_support)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      finalFromId,
      finalToId,
      JSON.stringify(context),
      edgeData.source,
      now,
      explanation,
      edgeData.belief_evidence_support ?? null
    );

    const edgeId = Number(result.lastInsertRowid);
    const newEdge = await this.getEdgeById(edgeId);

    if (!newEdge) {
      throw new Error('Failed to create edge');
    }

    // Evidence hook: a new evidence edge must regrade its derived end — the
    // from-node AS STORED (finalFromId survives any inference swap), since
    // under canon the from-end is the node the evidence grades. The movement
    // trigger names this entry point (spec §5): the write door is the edge
    // write, whichever verb carried it.
    if (edgeIsGradeableBeliefEvidence) {
      await recomputeNodeBelief(finalFromId, 'evidence-edge-write');
    }

    // Broadcast edge creation event (use final IDs from the saved edge)
    eventBroadcaster.broadcast({
      type: 'EDGE_CREATED',
      data: {
        fromNodeId: finalFromId,
        toNodeId: finalToId,
        edge: newEdge
      }
    });

    return newEdge;
  }

  async updateEdge(id: number, updates: Partial<Edge>): Promise<Edge> {
    return this.updateEdgeSQLite(id, updates);
  }

  // PostgreSQL path removed in SQLite-only consolidation

  private async updateEdgeSQLite(id: number, updates: Partial<Edge>): Promise<Edge> {
    const sqlite = getSQLiteClient();
    const updateFields: string[] = [];
    const params: any[] = [];

    // The support this update writes, if it writes one at all. Read once here
    // because it decides three things: whether the write is allowed, whether
    // the edge stops being evidence, and whether the write must regrade the
    // edge's derived end (its from-node, canon direction).
    const writtenBeliefEvidenceSupport = updates.belief_evidence_support;

    // Whether this update TOUCHES the support column at all. The dynamic UPDATE
    // loop below treats undefined as "not part of this update", so the trigger
    // is the presence of any other value — including null, and including 0.
    // Deliberately WIDER than the range check just below: writing NULL is a
    // legitimate support write, not an out-of-range one.
    const updateWritesBeliefEvidenceSupport = writtenBeliefEvidenceSupport !== undefined;

    // Whether this update UN-ASSESSES the edge: a support written as NULL is
    // the one thing that makes an edge not evidence at all, so an edge that WAS
    // evidence stops being evidence. On create there is no such case (a new
    // edge with NULL support never was evidence), which is why this distinction
    // does not exist in createEdge.
    const updateUnassessesBeliefEvidence =
      updateWritesBeliefEvidenceSupport && writtenBeliefEvidenceSupport === null;

    // Belief-evidence door check: the dynamic UPDATE below writes whatever it
    // is given straight to the REAL belief_evidence_support column, so the
    // value is checked before anything at all is written. Support is UNSIGNED,
    // 0..1 — contradiction is expressed by the source NODE's negative credence,
    // never by the edge. NULL passes (it un-assesses the edge, which is a
    // legitimate write) and 0 passes (assessed, carries nothing). The number
    // test is first and separate because a range test alone cannot refuse a
    // non-number: every NaN comparison is false, and bound to a REAL column
    // better-sqlite3 stores a string as TEXT and turns NaN into NULL — which
    // would silently un-assess an edge instead of refusing the write, and hide
    // it from the recovery sweep, since that sweep only looks for a NULL
    // contribution.
    if (
      writtenBeliefEvidenceSupport != null &&
      (typeof writtenBeliefEvidenceSupport !== 'number' ||
        !Number.isFinite(writtenBeliefEvidenceSupport) ||
        writtenBeliefEvidenceSupport < 0 ||
        writtenBeliefEvidenceSupport > 1)
    ) {
      throw new Error(
        `belief_evidence_support must be a number between 0 and 1 (got ${String(writtenBeliefEvidenceSupport)}). ` +
          'Support is unsigned; a contradicting source is expressed by that source node\'s negative belief_credence.'
      );
    }

    // If explanation changes, re-infer classification and write full EdgeContext
    if (Object.prototype.hasOwnProperty.call(updates, 'context') && updates.context && typeof updates.context === 'object') {
      const incomingContext = updates.context as Partial<EdgeContext> & { explanation?: unknown };
      if (typeof incomingContext.explanation === 'string') {
        const explanation = incomingContext.explanation.trim();
        if (!explanation) {
          throw new Error('Edge explanation is required');
        }
        const explanationError = validateEdgeExplanation(explanation);
        if (explanationError) {
          throw new Error(explanationError);
        }

        const existingEdge = await this.getEdgeById(id);
        if (!existingEdge) {
          throw new Error(`Edge with ID ${id} not found`);
        }

        const [fromNode, toNode] = await Promise.all([
          nodeService.getNodeById(existingEdge.from_node_id),
          nodeService.getNodeById(existingEdge.to_node_id),
        ]);

        if (!fromNode) throw new Error(`Source node ${existingEdge.from_node_id} not found`);
        if (!toNode) throw new Error(`Target node ${existingEdge.to_node_id} not found`);

        const inferred = await inferEdgeContext({ explanation, fromNode, toNode });
        const now = new Date().toISOString();

        const existingContext = (existingEdge.context && typeof existingEdge.context === 'object')
          ? (existingEdge.context as Partial<EdgeContext>)
          : undefined;

        const created_via: EdgeCreatedVia =
          (incomingContext.created_via as EdgeCreatedVia) ||
          (existingContext?.created_via as EdgeCreatedVia) ||
          'ui';

        const nextFromId = inferred.swap_direction ? existingEdge.to_node_id : existingEdge.from_node_id;
        const nextToId = inferred.swap_direction ? existingEdge.from_node_id : existingEdge.to_node_id;
        if (inferred.swap_direction) {
          updates.from_node_id = nextFromId;
          updates.to_node_id = nextToId;
        }

        updates.context = {
          ...existingContext,
          ...incomingContext,
          type: inferred.type,
          confidence: inferred.confidence,
          inferred_at: now,
          explanation,
          created_via,
        } satisfies EdgeContext;
      }
    }

    // Build dynamic update query
    Object.entries(updates).forEach(([key, value]) => {
      if (key !== 'id' && key !== 'created_at' && value !== undefined) {
        updateFields.push(`${key} = ?`);
        if (key === 'context') {
          params.push(typeof value === 'object' ? JSON.stringify(value) : value);
        } else {
          params.push(value);
        }
      }
    });

    if (Object.prototype.hasOwnProperty.call(updates, 'explanation')) {
      const rawExplanation = (updates as any).explanation;
      if (typeof rawExplanation === 'string') {
        const explanationError = validateEdgeExplanation(rawExplanation);
        if (explanationError) {
          throw new Error(explanationError);
        }
        updateFields.push('explanation = ?');
        params.push(rawExplanation.trim());
      }
    }

    if (updateFields.length === 0) {
      throw new Error('No valid fields to update');
    }

    params.push(id); // Add ID for WHERE clause

    const query = `UPDATE edges SET ${updateFields.join(', ')} WHERE id = ?`;
    const result = sqlite.query(query, params);
    
    if (result.changes === 0) {
      throw new Error(`Edge with ID ${id} not found`);
    }

    const updatedEdge = await this.getEdgeById(id);
    if (!updatedEdge) {
      throw new Error(`Failed to retrieve updated edge with ID ${id}`);
    }

    // Evidence hook: any write to the support must regrade this edge's
    // derived end — its from-node under canon — which is why the row is
    // re-read above before returning: an update receives only an id, so
    // from_node_id has to be loaded to be regraded. Without this the edge
    // keeps the belief_evidence_contribution stamped from the OLD support:
    // stale and still NON-NULL, so invisible to beliefRecoveryService (which
    // finds ungraded evidence by looking for a NULL contribution), leaving
    // the derived node's credence wrong permanently rather than until the
    // next sweep. A correction to exactly 0 regrades:
    // assessed-carries-nothing is a recorded judgement, not an absence of one.
    // Un-assessing to NULL regrades too, from the evidence that is LEFT — and
    // when nothing is left recomputeNodeBelief clears the credence to NULL,
    // because a node with no evidence is ungraded rather than balanced at 0.
    // Rewording an explanation is NOT new evidence and deliberately regrades
    // nothing. Exactly ONE derived node ever needs regrading, because a
    // support write cannot swap the edge's direction today — swaps happen
    // only on the context.explanation inference path above. If a support
    // write ever gains that power, both the old and the new derived end would
    // need it.
    if (updateWritesBeliefEvidenceSupport) {
      // An edge that is no longer evidence must not keep a contribution: it
      // would be a lying column, and a trap — were support later restored, the
      // recovery sweep would read the surviving stamp as already graded and
      // skip the edge. The stamp belongs to the edge, so the write that
      // invalidates it clears it: recomputeNodeBelief cannot, because its query
      // selects only edges whose support IS NOT NULL, putting an edge whose
      // support has just gone NULL outside its result set for good. Cleared on
      // THIS edge alone, so the other edges pointing at the same node keep
      // their own contributions, and cleared BEFORE the regrade so the
      // recompute cannot re-observe a stale stamp.
      if (updateUnassessesBeliefEvidence) {
        sqlite
          .prepare('UPDATE edges SET belief_evidence_contribution = NULL WHERE id = ?')
          .run(id);
      }
      // The movement trigger names this entry point (spec §5): a support
      // correction is still an evidence-edge write.
      await recomputeNodeBelief(updatedEdge.from_node_id, 'evidence-edge-write');

      // The edge as it stands once the regrade has finished with it. Everything
      // above — the clear on the un-assessment path, and the re-stamp the
      // recompute performs — wrote to THIS row after it was read, so the object
      // read above now disagrees with the database about
      // belief_evidence_contribution. Re-read rather than patching that one
      // field onto the object in hand: the guarantee being made is that the
      // returned edge agrees with the row, and only reading the row can give
      // that — a patched field would drift the moment anything else about
      // grading changes. The read is deliberately AFTER the whole hook,
      // including the clear, since a read between the clear and the recompute
      // would only swap one stale value for another.
      const regradedEdge = await this.getEdgeById(id);
      if (!regradedEdge) {
        throw new Error(`Failed to retrieve updated edge with ID ${id}`);
      }
      return regradedEdge;
    }

    // No regrade ran, so nothing has touched the row since it was read and
    // there is nothing fresher to fetch.
    return updatedEdge;
  }

  async deleteEdge(id: number): Promise<void> {
    const sqlite = getSQLiteClient();
    const result = sqlite.query('DELETE FROM edges WHERE id = ?', [id]);
    if ((result.changes || 0) === 0) {
      throw new Error(`Edge with ID ${id} not found`);
    }
    // Broadcast edge deletion event
    eventBroadcaster.broadcast({
      type: 'EDGE_DELETED',
      data: { edgeId: id }
    });
  }

  async deleteEdgesByNodeId(nodeId: number): Promise<void> {
    const sqlite = getSQLiteClient();
    sqlite.query(
      'DELETE FROM edges WHERE from_node_id = ? OR to_node_id = ?',
      [nodeId, nodeId]
    );
  }

  async getNodeConnections(nodeId: number): Promise<NodeConnection[]> {
    return this.getNodeConnectionsSQLite(nodeId);
  }

  // PostgreSQL path removed in SQLite-only consolidation

  private async getNodeConnectionsSQLite(nodeId: number): Promise<NodeConnection[]> {
    const sqlite = getSQLiteClient();
    const result = sqlite.query(`
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
        CASE WHEN e.from_node_id = ? THEN n_to.link
          ELSE n_from.link
        END as connected_node_link,
        CASE 
          WHEN e.from_node_id = ? THEN n_to.source
          ELSE n_from.source
        END as connected_node_source,
        CASE
          WHEN e.from_node_id = ? THEN n_to.metadata
          ELSE n_from.metadata
        END as connected_node_metadata,
        CASE 
          WHEN e.from_node_id = ? THEN n_to.created_at
          ELSE n_from.created_at
        END as connected_node_created_at,
        CASE 
          WHEN e.from_node_id = ? THEN n_to.updated_at
          ELSE n_from.updated_at
        END as connected_node_updated_at
      FROM edges e
      LEFT JOIN nodes n_from ON e.from_node_id = n_from.id
      LEFT JOIN nodes n_to ON e.to_node_id = n_to.id
      WHERE e.from_node_id = ? OR e.to_node_id = ?
      ORDER BY e.created_at DESC
    `, [
      nodeId,
      nodeId,
      nodeId,
      nodeId,
      nodeId,
      nodeId,
      nodeId,
      nodeId,
      nodeId
    ]);

    return this.mapNodeConnectionsSQLite(result.rows);
  }

  private mapNodeConnections(rows: any[]): NodeConnection[] {
    return rows.map(row => {
      const edge: Edge = {
        id: row.id,
        from_node_id: row.from_node_id,
        to_node_id: row.to_node_id,
        context: row.context,
        source: row.source,
        created_at: row.created_at
      };

      const connected_node: Node = {
        id: row.connected_node_id,
        title: row.connected_node_title,
        link: row.connected_node_link,
        embedding: undefined, // Not needed for display
        source: row.connected_node_source,
        metadata: row.connected_node_metadata,
        created_at: row.connected_node_created_at,
        updated_at: row.connected_node_updated_at
      };

      return {
        id: edge.id,
        connected_node,
        edge
      };
    });
  }

  private mapNodeConnectionsSQLite(rows: any[]): NodeConnection[] {
    return rows.map(row => {
      let context: any = row.context;
      if (typeof row.context === 'string') {
        const trimmed = row.context.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            context = JSON.parse(trimmed);
          } catch (error) {
            console.warn('[edges] Failed to parse JSON context for edge', row.id, error);
            context = row.context;
          }
        }
      }

      const edge: Edge = {
        id: row.id,
        from_node_id: row.from_node_id,
        to_node_id: row.to_node_id,
        context,
        source: row.source,
        created_at: row.created_at
      };

      const connected_node: Node = {
        id: row.connected_node_id,
        title: row.connected_node_title,
        link: row.connected_node_link,
        embedding: undefined, // Not needed for display
        source: row.connected_node_source,
        metadata: typeof row.connected_node_metadata === 'string' ? JSON.parse(row.connected_node_metadata) : row.connected_node_metadata,
        created_at: row.connected_node_created_at,
        updated_at: row.connected_node_updated_at
      };

      return {
        id: edge.id,
        connected_node,
        edge
      };
    });
  }

  async edgeExists(fromId: number, toId: number): Promise<boolean> {
    const sqlite = getSQLiteClient();
    const result = sqlite.query('SELECT 1 FROM edges WHERE from_node_id = ? AND to_node_id = ?', [fromId, toId]);
    return result.rows.length > 0;
  }

  // How many edges match an edge-read filter's narrowing, ignoring its limit
  // and offset — a total is not a page. It is a separate COUNT(*) query rather
  // than the length of a row read on purpose: reading the matching rows just to
  // measure them is the uncapped read this service exists to avoid, and it
  // fails hardest exactly where the number matters (a hub node in a graph of
  // 100,000s of edges). COUNT(*) with the SAME WHERE clause getEdges builds is
  // answered from idx_edges_from / idx_edges_to without materialising a row.
  // An empty filter counts the whole table, which is what the callers that
  // pass nothing have always asked for.
  async getEdgeCount(edgeReadFilter: BeliefEdgeReadFilter = {}): Promise<number> {
    const sqlite = getSQLiteClient();
    const narrowing = buildBeliefEdgeReadNarrowing(edgeReadFilter);
    const result = sqlite.query(
      `SELECT COUNT(*) as count FROM edges${narrowing.whereSql}`,
      narrowing.boundValues
    );
    return Number(result.rows[0].count);
  }


  async getMostConnectedNodes(limit = 10): Promise<Array<{ node_id: number; connection_count: number }>> {
    const sqlite = getSQLiteClient();
    const result = sqlite.query(`
      SELECT 
        node_id,
        COUNT(*) as connection_count
      FROM (
        SELECT from_node_id as node_id FROM edges
        UNION ALL
        SELECT to_node_id as node_id FROM edges
      ) combined
      GROUP BY node_id
      ORDER BY connection_count DESC
      LIMIT ?
    `, [limit]);

    return result.rows.map((row: any) => ({
      node_id: Number(row.node_id),
      connection_count: Number(row.connection_count)
    }));
  }

  async createBidirectionalEdge(fromId: number, toId: number, options?: {
    explanation?: string;
    created_via?: EdgeCreatedVia;
    source?: 'user' | 'ai_similarity' | 'helper_name';
    skip_inference?: boolean;
  }): Promise<Edge[]> {
    const edges: Edge[] = [];
    const explanation = (options?.explanation || 'Similarity-based connection').trim();
    const created_via: EdgeCreatedVia = options?.created_via || 'workflow';

    // Create edge from A to B
    const forwardEdge = await this.createEdge({
      from_node_id: fromId,
      to_node_id: toId,
      explanation,
      created_via,
      source: options?.source || 'ai_similarity',
      skip_inference: options?.skip_inference,
    });
    edges.push(forwardEdge);

    // Create edge from B to A
    const backwardEdge = await this.createEdge({
      from_node_id: toId,
      to_node_id: fromId,
      explanation,
      created_via,
      source: options?.source || 'ai_similarity',
      skip_inference: options?.skip_inference,
    });
    edges.push(backwardEdge);

    return edges;
  }
}

// Export singleton instance
export const edgeService = new EdgeService();
