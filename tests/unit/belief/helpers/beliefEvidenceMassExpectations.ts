/**
 * Shared expectation math and raw reads for the belief-model-v2 tests
 * (docs/belief-model-subjective-logic.md).
 *
 * V2 stores two UNSIGNED evidence masses per node
 * (nodes.belief_evidence_for_mass = r, nodes.belief_evidence_against_mass = s)
 * and keeps nodes.belief_credence as the cached signed projection:
 *
 *   credence    = (r − s) / (r + s + W)     signed, open (−1, +1)   [spec §2]
 *   uncertainty = W / (r + s + W)           unsigned, (0, 1]        [spec §2]
 *
 * with the prior mass W = 2 (the Beta/Subjective Logic non-informative prior;
 * the implementation must export it as BELIEF_PRIOR_MASS). The literal 2 here
 * is deliberate: these helpers are the INDEPENDENT hand calculation the spec's
 * §3 table says must reproduce every number, so they must not import the
 * constant they are checking.
 */

import type { TempBeliefDatabase } from './tempBeliefDatabase';

// The prior mass W of spec §2, restated by hand (see module comment for why
// this is a literal and not an import of BELIEF_PRIOR_MASS).
export const HAND_CALCULATED_BELIEF_PRIOR_MASS = 2;

// Expected cached credence for evidence masses r (for) and s (against) under
// the v2 projection formula of spec §2.
export function expectedBeliefCredenceProjection(forMass: number, againstMass: number): number {
  return (forMass - againstMass) / (forMass + againstMass + HAND_CALCULATED_BELIEF_PRIOR_MASS);
}

// Expected derived uncertainty for evidence masses r and s under spec §2.
export function expectedBeliefUncertainty(forMass: number, againstMass: number): number {
  return (
    HAND_CALCULATED_BELIEF_PRIOR_MASS /
    (forMass + againstMass + HAND_CALCULATED_BELIEF_PRIOR_MASS)
  );
}

// The two stored evidence masses of one node as the tests read them straight
// from SQLite. Both NULL means never assessed; both non-NULL means assessed
// (spec §2: the two columns move together, never one at a time).
export interface BeliefEvidenceMassRow {
  belief_evidence_for_mass: number | null;
  belief_evidence_against_mass: number | null;
}

// Read one node's stored evidence masses. Under the v1 schema this SELECT
// throws ("no such column"), which is this suite's intended red for every
// persistence test that calls it.
export function readBeliefEvidenceMasses(
  db: TempBeliefDatabase,
  nodeId: number
): BeliefEvidenceMassRow {
  return db.sqlite
    .prepare(
      'SELECT belief_evidence_for_mass, belief_evidence_against_mass FROM nodes WHERE id = ?'
    )
    .get(nodeId) as BeliefEvidenceMassRow;
}
