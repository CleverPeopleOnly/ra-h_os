/**
 * Types for the CommonJS shared belief MCP tool contract
 * (beliefMcpToolContract.js). The module itself must stay CommonJS so the local
 * MCP door can `require` it from source; this declaration file is what lets the
 * TypeScript remote door import the same symbols.
 */

import { z } from 'zod';

/**
 * The four belief fields of one node as a node-read tool reports them: the
 * four STORED display columns (the belief-storage split reversed the old
 * derive-on-read rule — samai writes belief_uncertainty beside the credence
 * now). Credence, its stamp and the uncertainty are nullable because NULL
 * (never assessed) is a state of its own; the fixed flag is not — the column
 * is NOT NULL DEFAULT 0.
 */
export type BeliefNodeReadFields = {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  belief_uncertainty: number | null;
};

/**
 * Normalise one node row's belief columns for a node read: a missing credence
 * or stamp becomes null, a stored NULL stays null, a real 0 stays 0, and a
 * missing fixed flag falls back to the column's own default of 0.
 * belief_uncertainty is the STORED column passed through verbatim (null when
 * never assessed) — except for a fixed-credence node, which answers 0
 * regardless of the stored value: a hand-asserted credence is the dogmatic
 * opinion.
 */
export declare function beliefFieldsForNodeRead(
  nodeRow: Record<string, unknown>
): BeliefNodeReadFields;

/** The output-schema fragment declaring those same four belief fields. */
export declare const beliefNodeReadOutputSchemaFields: {
  belief_credence: z.ZodNullable<z.ZodNumber>;
  belief_computed_at: z.ZodNullable<z.ZodString>;
  belief_credence_is_fixed: z.ZodUnion<[z.ZodLiteral<0>, z.ZodLiteral<1>]>;
  belief_uncertainty: z.ZodNullable<z.ZodNumber>;
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

/**
 * rah_clear_belief_fixed_credence input (the un-fix door): the node whose
 * asserted credence is withdrawn — the only argument, because a withdrawal
 * leaves the node never-assessed until samai next writes its display belief.
 */
export declare const beliefClearFixedCredenceInputSchemaFields: {
  node_id: z.ZodNumber;
};

/**
 * rah_clear_belief_fixed_credence output — the mirror of the set tool's
 * reply: the fixed flag is the literal 0 (a successful clear always leaves
 * the node un-fixed) and the credence is nullable (a withdrawal leaves the
 * node never-assessed — a real outcome, not an error).
 */
export declare const beliefClearFixedCredenceOutputSchemaFields: {
  success: z.ZodBoolean;
  node_id: z.ZodNumber;
  belief_credence: z.ZodNullable<z.ZodNumber>;
  belief_credence_is_fixed: z.ZodLiteral<0>;
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

