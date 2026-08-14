/**
 * Belief service — the surface that remains after the display-belief slice.
 *
 * samai owns the belief engine since the belief-storage split, and the
 * fork's node belief is a pure DISPLAY surface samai writes through the
 * remote MCP door (POST /api/belief/display). The recompute that used to
 * live here is gone: a fork-side recompute wrote "never assessed", which
 * would erase samai's display writes. What survives of the belief surface
 * lives in its own modules — beliefFixedCredence (the assert/withdraw
 * writes), beliefDisplayWrite (samai's display write) and beliefMovements
 * (the movement-log read). This module keeps only the movement-trigger
 * vocabulary those writers share.
 */

// The cause a belief_movements row records. Only the fixed-credence
// assertion still writes movements — samai owns movement history for every
// engine-driven change — so this is the one trigger a new row may carry.
// Older logs still hold historical values ('embed-grade', 'mcp-recompute',
// 'evidence-edge-write', ...) from before the storage split; movement READS
// report the trigger as a plain string, so those rows stay readable.
export type BeliefMovementTrigger = 'belief-fixed-credence-set';
