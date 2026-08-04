/**
 * The five belief columns of one node-read SELECT, declared ONCE and shared
 * by every node-read query in src/services/database/nodes.ts (the plain list,
 * the by-id read, and all search variants).
 *
 * The belief columns (fork addition) ride the same SELECTs as the upstream
 * columns so every node read carries the node's belief: belief_credence NULL
 * means nobody has grounded the node (a real state, never coerced to 0), and
 * belief_credence_is_fixed is NOT NULL DEFAULT 0 so it always has a value.
 * The two evidence masses (belief model v2) ride along too, so consumers —
 * the MCP doors' node reads and the belief presentation module — can DERIVE
 * belief_uncertainty from them; the derivation lives in the shared contract's
 * node-read mapper (beliefMcpToolContract.js), never in a SELECT.
 *
 * Pasting these column names into each SELECT by hand is what would let the
 * read surfaces drift apart — one query carrying belief and another silently
 * dropping it — so every node-read SELECT appends THIS fragment instead.
 */

// SQL fragment naming the five belief columns under the `n` alias every
// node-read SELECT in nodes.ts uses, ready to append after the upstream
// column list.
export const BELIEF_NODE_READ_COLUMNS_SQL =
  'n.belief_credence, n.belief_computed_at, n.belief_credence_is_fixed, ' +
  'n.belief_evidence_for_mass, n.belief_evidence_against_mass';
