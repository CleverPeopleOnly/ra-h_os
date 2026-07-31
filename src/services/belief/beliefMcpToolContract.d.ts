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
