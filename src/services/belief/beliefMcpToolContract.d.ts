/**
 * Types for the CommonJS shared belief MCP tool contract
 * (beliefMcpToolContract.js). The module itself must stay CommonJS so the local
 * MCP door can `require` it from source; this declaration file is what lets the
 * TypeScript remote door import the same symbols.
 */

import { z } from 'zod';

/** The unsigned [0, 1] belief_evidence_support argument of rah_create_edge. */
export declare const beliefEvidenceSupportInputSchemaForEdgeCreate: z.ZodOptional<z.ZodNumber>;

/**
 * The unsigned [0, 1] belief_evidence_support argument of rah_update_edge,
 * nullable as well as optional: null is how an update un-assesses the edge, so
 * the declared type has to admit it or the TypeScript remote door cannot pass
 * the very value the runtime schema exists to accept.
 */
export declare const beliefEvidenceSupportInputSchemaForEdgeUpdate: z.ZodOptional<
  z.ZodNullable<z.ZodNumber>
>;

/** The two belief columns of one edge as an edge-read tool reports them. */
export type BeliefEvidenceEdgeReadFields = {
  belief_evidence_support: number | null;
  belief_evidence_contribution: number | null;
};

/**
 * Normalise one edge row's belief columns for an edge read: a missing key
 * becomes null, a stored NULL stays null, and a real 0 stays 0.
 */
export declare function beliefEvidenceFieldsForEdgeRead(
  edgeRow: Record<string, unknown>
): BeliefEvidenceEdgeReadFields;

/** The output-schema fragment declaring those same two belief columns. */
export declare const beliefEvidenceEdgeReadOutputSchemaFields: {
  belief_evidence_support: z.ZodNullable<z.ZodNumber>;
  belief_evidence_contribution: z.ZodNullable<z.ZodNumber>;
};

/**
 * The three belief columns of one node as a node-read tool reports them.
 * Credence and its stamp are nullable because NULL (ungraded) is a state of
 * its own; the fixed flag is not — the column is NOT NULL DEFAULT 0.
 */
export type BeliefNodeReadFields = {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
};

/**
 * Normalise one node row's belief columns for a node read: a missing credence
 * or stamp becomes null, a stored NULL stays null, a real 0 stays 0, and a
 * missing fixed flag falls back to the column's own default of 0.
 */
export declare function beliefFieldsForNodeRead(
  nodeRow: Record<string, unknown>
): BeliefNodeReadFields;

/** The output-schema fragment declaring those same three belief columns. */
export declare const beliefNodeReadOutputSchemaFields: {
  belief_credence: z.ZodNullable<z.ZodNumber>;
  belief_computed_at: z.ZodNullable<z.ZodString>;
  belief_credence_is_fixed: z.ZodUnion<[z.ZodLiteral<0>, z.ZodLiteral<1>]>;
};

/**
 * rah_set_belief_fixed_credence input: the node, and the credence to assert —
 * a number strictly inside the open interval (-1, +1).
 */
export declare const beliefSetFixedCredenceInputSchemaFields: {
  node_id: z.ZodNumber;
  belief_credence: z.ZodNumber;
};

/**
 * rah_set_belief_fixed_credence output — the standalone door's reply shape.
 * The fixed flag is the literal 1: a successful set always leaves the node
 * fixed.
 */
export declare const beliefSetFixedCredenceOutputSchemaFields: {
  success: z.ZodBoolean;
  node_id: z.ZodNumber;
  belief_credence: z.ZodNumber;
  belief_credence_is_fixed: z.ZodLiteral<1>;
  belief_computed_at: z.ZodString;
  message: z.ZodString;
};

/** rah_get_belief_movements input: the node, and an optional 1..100 page cap. */
export declare const beliefMovementsReadInputSchemaFields: {
  node_id: z.ZodNumber;
  limit: z.ZodOptional<z.ZodNumber>;
};

/**
 * rah_get_belief_movements output: a count plus the movement entries under
 * the exact belief_movements column names, newest first.
 */
export declare const beliefMovementsReadOutputSchemaFields: {
  count: z.ZodNumber;
  movements: z.ZodArray<
    z.ZodObject<{
      id: z.ZodNumber;
      node_id: z.ZodNumber;
      from_credence: z.ZodNullable<z.ZodNumber>;
      to_credence: z.ZodNumber;
      trigger: z.ZodString;
      occurred_at: z.ZodString;
    }>
  >;
};

/** rah_recompute_node_belief input: the node to regrade. */
export declare const beliefRecomputeInputSchemaFields: {
  node_id: z.ZodNumber;
};

/**
 * rah_recompute_node_belief output. belief_credence is nullable because a
 * node with no counted evidence stays ungraded — a real answer, not an error.
 */
export declare const beliefRecomputeOutputSchemaFields: {
  success: z.ZodBoolean;
  node_id: z.ZodNumber;
  belief_credence: z.ZodNullable<z.ZodNumber>;
  message: z.ZodString;
};
