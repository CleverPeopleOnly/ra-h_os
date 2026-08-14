'use strict';

/**
 * The fork-owned belief pieces of the MCP tool contract, declared ONCE and
 * shared by both app-backed MCP doors.
 *
 * RA-H serves the same rah_* tools from two files: the local door
 * (apps/mcp-server/stdio-server.js) and the remote door (app/api/mcp/route.ts).
 * Declaring the belief surface twice is what let it drift — every belief change
 * this fork made landed on the local door only. Both doors now take the
 * node-side belief schemas and mappers from here, so agreement is structural
 * rather than something anyone has to maintain. The edge-side evidence pieces
 * are gone: belief evidence left the edges table (it lives in samai's own
 * store now), so an edge is a plain relationship on every door.
 *
 * WHY THIS FILE IS COMMONJS. The local door is a CommonJS script that is
 * spawned straight from source with no build step, so it can only `require` a
 * CommonJS file. A bare `.js` here is CommonJS ONLY because the repo root
 * package.json declares no `"type"` field. If that file ever gains
 * `"type": "module"`, Node will read this as ESM, the local door's `require`
 * will fail, and the breakage will be silent until an MCP client tries to use
 * it — at which point this module must be renamed to `.cjs`. The companion
 * beliefMcpToolContract.d.ts is what gives the TypeScript remote door its types.
 */

const { z } = require('zod');

/**
 * W of belief model v2 (docs/belief-model-subjective-logic.md §2): the
 * non-informative prior mass of the Beta/Subjective Logic correspondence.
 * Deliberately RESTATED here rather than imported from
 * src/services/belief/beliefGradingPolicy.ts: this module must stay plain
 * CommonJS the local door can `require` from source, and that policy module
 * is TypeScript. The value is pinned on both sides by the belief tests.
 */
const BELIEF_PRIOR_MASS = 2;

/**
 * How little evidence one node row's credence rests on, DERIVED from the
 * row's evidence masses (belief model v2, spec §2) — never read from the row:
 * a stored belief_uncertainty would be exactly the stale cache §2 refuses to
 * create, so the derivation always wins.
 *
 *  - a FIXED credence is the dogmatic opinion: uncertainty 0 by definition,
 *    even though its masses are NULL — there is no evidence ledger behind an
 *    assertion, but an assertion is the opposite of "never assessed",
 *  - masses present: W / (r + s + W),
 *  - masses NULL (or missing): never assessed — null, the same state the
 *    credence itself reports as null.
 *
 * @param {Record<string, unknown>} nodeRow One node row as the app reported it.
 * @returns {number | null} The derived uncertainty, or null.
 */
function deriveBeliefUncertaintyForNodeRead(nodeRow) {
  if (nodeRow.belief_credence_is_fixed === 1) {
    return 0;
  }
  // The two masses move together (both NULL or both non-NULL); a missing key
  // reads as "nothing known", i.e. null, like every other nullable column.
  const beliefEvidenceForMass = nodeRow.belief_evidence_for_mass ?? null;
  const beliefEvidenceAgainstMass = nodeRow.belief_evidence_against_mass ?? null;
  if (typeof beliefEvidenceForMass !== 'number' || typeof beliefEvidenceAgainstMass !== 'number') {
    return null;
  }
  return (
    BELIEF_PRIOR_MASS / (beliefEvidenceForMass + beliefEvidenceAgainstMass + BELIEF_PRIOR_MASS)
  );
}

/**
 * The four belief fields of one node, as a node-read tool must report them:
 * the three stored columns plus the DERIVED belief_uncertainty (v2, spec §2 —
 * derived on read from the row's evidence masses, never stored; the masses
 * themselves are state, not read surface).
 *
 * `?? null` normalises only a MISSING key on the two nullable columns: a
 * column the app did not report at all reads as "nothing known" and becomes
 * null, a stored NULL is already null, and a real 0 is kept as 0. NULL
 * credence means nobody has grounded the node, while 0 means it was assessed
 * and believed neither way — different states that must never collapse into
 * each other. belief_credence_is_fixed has NO null state (the column is
 * NOT NULL DEFAULT 0), so a missing key falls back to the column's own
 * default of 0 — an ordinary derived-credence node.
 *
 * @param {Record<string, unknown>} nodeRow One node row as the app reported it.
 */
function beliefFieldsForNodeRead(nodeRow) {
  return {
    belief_credence: nodeRow.belief_credence ?? null,
    belief_computed_at: nodeRow.belief_computed_at ?? null,
    belief_credence_is_fixed: nodeRow.belief_credence_is_fixed ?? 0,
    belief_uncertainty: deriveBeliefUncertaintyForNodeRead(nodeRow),
  };
}

/**
 * The output-schema fragment declaring those same three belief columns, for a
 * door to spread into the per-node object of its node-read output schema.
 * Credence is the ONLY signed quantity in the system, so its number is
 * unconstrained in sign; the fixed flag is a two-state 0/1 with no null state.
 */
const beliefNodeReadOutputSchemaFields = {
  // How much this node is believed: signed, and null when nobody has grounded
  // the node — a real state that must never be reported as 0.
  belief_credence: z
    .number()
    .nullable()
    .describe('How much this node is believed. Positive means believed, negative means disbelieved, 0 means assessed and believed neither way. null means nobody has grounded the node yet — never the same thing as 0.'),
  // When the credence was stamped; null exactly when the node is ungraded.
  belief_computed_at: z
    .string()
    .nullable()
    .describe('When the belief_credence was stamped. null when the node is ungraded.'),
  // Two-state flag: 1 says a human asserted the credence by hand, 0 says the
  // engine derived it (or nothing was ever asserted). Literals, not a plain
  // number, so a boolean or any other value is refused.
  belief_credence_is_fixed: z
    .union([z.literal(0), z.literal(1)])
    .describe('1 when a human asserted the belief_credence by hand; 0 otherwise — belief evidence lives outside this store, so a non-asserted node is ungraded (credence null).'),
  // How little evidence the credence rests on: unsigned, derived on read —
  // 0 is a human assertion (the dogmatic opinion), values near 1 mean the
  // credence rests on almost nothing, and null means never assessed.
  belief_uncertainty: z
    .number()
    .nullable()
    .describe('How little evidence the belief_credence rests on, from just above 0 (heavily evidenced) to 1 (assessed but resting on nothing). 0 means a human asserted the credence by hand. null means nobody has grounded the node — never the same thing as 0.'),
};

/**
 * Input schema fields of rah_set_belief_fixed_credence: assert one node's
 * credence by hand. Parameter names follow the column names exactly. Credence
 * lives in the OPEN interval (-1, +1): total certainty either way is not
 * expressible, so both endpoints are rejected while 0 — assessed and torn —
 * is accepted.
 */
const beliefSetFixedCredenceInputSchemaFields = {
  node_id: z
    .number()
    .int()
    .positive()
    .describe('ID of the node whose credence is being asserted'),
  belief_credence: z
    .number()
    .gt(-1)
    .lt(1)
    .describe('The credence to assert: how much this node is believed, one number strictly between -1 and +1, positive meaning believed and negative meaning disbelieved. Use 0 when the node was assessed and is believed neither way. -1 and +1 are rejected — total certainty is not expressible.'),
};

/**
 * Output schema fields of rah_set_belief_fixed_credence — the standalone
 * door's setBeliefFixedCredence reply shape, field for field. The fixed flag
 * is the LITERAL 1: a successful set always leaves the node fixed, so a 0
 * here would mean the tool wrote something it did not.
 */
const beliefSetFixedCredenceOutputSchemaFields = {
  success: z.boolean(),
  node_id: z.number().describe('ID of the node the credence was asserted on'),
  belief_credence: z.number().describe('The credence now stored on the node — the literal number that was asserted.'),
  belief_credence_is_fixed: z
    .literal(1)
    .describe('Always 1: a successful set leaves the node fixed.'),
  belief_computed_at: z.string().describe('When the asserted credence was stamped.'),
  message: z.string(),
};

/**
 * Input schema fields of rah_clear_belief_fixed_credence: withdraw one node's
 * asserted credence (the v2 un-fix door). The node is the ONLY argument — a
 * credence input here would contradict the door's whole meaning: the engine
 * decides the credence from the node's actual evidence now.
 */
const beliefClearFixedCredenceInputSchemaFields = {
  node_id: z
    .number()
    .int()
    .positive()
    .describe('ID of the node whose asserted credence is being withdrawn'),
};

/**
 * Output schema fields of rah_clear_belief_fixed_credence — the mirror of the
 * set tool's reply, with the two signs flipped by the door's meaning: the
 * fixed flag is the LITERAL 0 (a successful clear always leaves the node
 * un-fixed) and the credence is NULLABLE (the regrade from the node's actual
 * evidence may land ungraded — a real outcome, never an error).
 */
const beliefClearFixedCredenceOutputSchemaFields = {
  success: z.boolean(),
  node_id: z.number().describe('ID of the node whose assertion was withdrawn'),
  belief_credence: z
    .number()
    .nullable()
    .describe('The credence the engine regraded the node to from its actual evidence; null when the node has no counted evidence and is now ungraded — a real state, never reported as 0.'),
  belief_credence_is_fixed: z
    .literal(0)
    .describe('Always 0: a successful clear leaves the node un-fixed.'),
  message: z.string(),
};

/**
 * Input schema fields of rah_get_belief_movements: read the log of one node's
 * credence changing. The page cap exists because an unbounded movement read
 * is how a long-lived node would flood an agent's context.
 */
const beliefMovementsReadInputSchemaFields = {
  node_id: z
    .number()
    .int()
    .positive()
    .describe('ID of the node whose belief movement log is being read'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Max movements to return, newest first: an integer from 1 to 100. Omit it for a default page.'),
};

/**
 * Output schema fields of rah_get_belief_movements: a count plus the movement
 * entries under the exact belief_movements column names, newest first.
 * from_credence is null exactly when the node was previously ungraded;
 * to_credence always exists — a movement to nowhere is not a movement.
 */
const beliefMovementsReadOutputSchemaFields = {
  count: z.number().describe('How many movements this reply carries.'),
  movements: z.array(
    z.object({
      id: z.number(),
      node_id: z.number(),
      from_credence: z
        .number()
        .nullable()
        .describe('The credence before the change; null when the node was previously ungraded — never 0, which would claim it had been assessed.'),
      to_credence: z.number().describe('The credence after the change.'),
      trigger: z.string().describe('What caused the credence to change.'),
      occurred_at: z.string().describe('When the credence changed.'),
    })
  ),
};

/**
 * Input schema fields of rah_recompute_node_belief: ask for one node's
 * belief_credence to be restated. Belief evidence lives outside this
 * store, so a non-fixed node restates to ungraded.
 */
const beliefRecomputeInputSchemaFields = {
  node_id: z
    .number()
    .int()
    .positive()
    .describe('ID of the node whose belief_credence the engine should recompute'),
};

/**
 * Output schema fields of rah_recompute_node_belief. belief_credence is
 * nullable because ungraded is a REAL outcome, not an error: a node with no
 * counted evidence answers null, never 0.
 */
const beliefRecomputeOutputSchemaFields = {
  success: z.boolean(),
  node_id: z.number().describe('ID of the node that was regraded'),
  belief_credence: z
    .number()
    .nullable()
    .describe('The regraded credence actually persisted on the node; null when the node has no counted evidence and stays ungraded — a real state, never reported as 0.'),
  message: z.string(),
};

module.exports = {
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
};
