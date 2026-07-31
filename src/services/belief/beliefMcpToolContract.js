'use strict';

/**
 * The fork-owned belief pieces of the MCP tool contract, declared ONCE and
 * shared by both app-backed MCP doors.
 *
 * RA-H serves the same rah_* tools from two files: the local door
 * (apps/mcp-server/stdio-server.js) and the remote door (app/api/mcp/route.ts).
 * Declaring the belief surface twice is what let it drift — every belief change
 * this fork made landed on the local door only. Both doors now take the support
 * input schemas, the edge-read mapper and the edge-read output fields from here,
 * so agreement is structural rather than something anyone has to maintain.
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
 * The belief_evidence_support argument of rah_create_edge: how strongly the
 * source node talks about the target, as one unsigned number in [0, 1].
 * Optional, because omitting it on a CREATE says the edge is a plain
 * non-evidence relationship — which is why this description cannot be shared
 * with the update tool's, where omission means something else entirely.
 */
const beliefEvidenceSupportInputSchemaForEdgeCreate = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe('How strongly the source node talks about the target node: one unsigned number in [0, 1]. The direction of the evidence comes from the source node\'s belief_credence, not from this field. Use 0 when the evidence was assessed and carries nothing. Omit the field entirely for a plain non-evidence edge.');

/**
 * The belief_evidence_support argument of rah_update_edge: the same unsigned
 * [0, 1] range as the create tool, so a support written once can be corrected
 * later — but NULLABLE where the create schema is not.
 *
 * WHY NULLABLE HERE, AND ONLY HERE. An update has a stored support behind it,
 * so a caller has three distinct things to say and needs three spellings:
 * a number corrects the support, OMISSION leaves the stored support exactly as
 * it is, and NULL un-assesses the edge — it stops being evidence at all, its
 * contribution is cleared and the target node is regraded from whatever
 * evidence remains. Without null an agent can raise and lower a support forever
 * but can never take one back, and 0 is no substitute: 0 is an assessed
 * "carries nothing", a recorded judgement rather than the absence of one.
 * On a CREATE there is no stored support to withdraw, so null would say nothing
 * that omission does not already say — which is why the create schema
 * deliberately keeps refusing it, and why the two descriptions stay apart.
 */
const beliefEvidenceSupportInputSchemaForEdgeUpdate = z
  .number()
  .min(0)
  .max(1)
  .nullable()
  .optional()
  .describe('Corrected support: how strongly the source node talks about the target node, as one unsigned number in [0, 1]. The direction of the evidence comes from the source node\'s belief_credence, not from this field. Use 0 when the evidence was assessed and carries nothing. Send null to un-assess the edge: it stops being evidence at all. Omit the field entirely to leave the edge\'s stored support unchanged.');

/**
 * The two belief columns of one edge, as an edge-read tool must report them.
 *
 * `?? null` normalises only a MISSING key: a column the app did not report at
 * all reads as "nothing known" and becomes null, a stored NULL is already null,
 * and a real 0 is kept as 0. Those three states are distinct — NULL support
 * means the edge is not evidence at all, while 0 means it was assessed and
 * carries nothing — so an assessed zero must never collapse into the null that
 * means unassessed. Both keys are always present, so a caller can tell null
 * from absent.
 *
 * @param {Record<string, unknown>} edgeRow One edge row as the app reported it.
 */
function beliefEvidenceFieldsForEdgeRead(edgeRow) {
  return {
    belief_evidence_support: edgeRow.belief_evidence_support ?? null,
    belief_evidence_contribution: edgeRow.belief_evidence_contribution ?? null,
  };
}

/**
 * The output-schema fragment declaring those same two belief columns, for a
 * door to spread into the per-edge object of its edge-read output schema.
 * Both are nullable because both carry a "nothing here" state the mapper can
 * produce, and both are plain numbers otherwise — contribution is signed
 * because the source node's credence is.
 */
const beliefEvidenceEdgeReadOutputSchemaFields = {
  // How strongly the from-node talks about the to-node: unsigned, 0..1.
  // NULL means the edge is not evidence at all.
  belief_evidence_support: z.number().nullable(),
  // The from-node's credence × this edge's support, stamped by the app's
  // belief engine. NULL means never graded, and stays NULL — never 0.
  belief_evidence_contribution: z.number().nullable(),
};

module.exports = {
  beliefEvidenceSupportInputSchemaForEdgeCreate,
  beliefEvidenceSupportInputSchemaForEdgeUpdate,
  beliefEvidenceFieldsForEdgeRead,
  beliefEvidenceEdgeReadOutputSchemaFields,
};
