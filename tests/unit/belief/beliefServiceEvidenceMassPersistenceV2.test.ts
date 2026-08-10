/**
 * Behaviour tests for recomputeNodeBelief under belief model v2
 * (docs/belief-model-subjective-logic.md §2–§4) against a real temp-file
 * SQLite database (see tempBeliefDatabase.ts for the safety seam).
 *
 * Pinned here:
 *  - a recompute persists BOTH evidence masses (belief_evidence_for_mass /
 *    belief_evidence_against_mass) and the cached belief_credence PROJECTION
 *    (r − s)/(r + s + 2), plus belief_computed_at and the per-edge stamps,
 *  - the mass columns move together: both NULL (never assessed) or both
 *    non-NULL (assessed) — the service-layer invariant of spec §2,
 *  - zero COUNTED contributions clears masses, credence and timestamp to
 *    NULL (§3 row 7: never assessed → NULL — the service half of that row),
 *  - counted zero contributions are NOT the same thing: they persist masses
 *    (0, 0) and credence 0 — the vacuous opinion, a real graded state,
 *  - an unassessed source (credence NULL) casts no vote and its edge's stamp
 *    clears — the v1 behaviour restated under v2,
 *  - the whole recompute runs in ONE better-sqlite3 transaction (spec §4): a
 *    failure mid-way leaves no partial writes behind.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';
import {
  expectedBeliefCredenceProjection,
  readBeliefEvidenceMasses,
} from './helpers/beliefEvidenceMassExpectations';

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// Create one claim node deriving from one FIXED-credence source over one
// canon evidence edge, claim→source (the bootstrap of every gradeable
// graph), returning all the ids.
function seedClaimFedByFixedSource(
  context: TempBeliefDatabase,
  options: { sourceBeliefCredence: number; support: number }
): { claimNodeId: number; sourceNodeId: number; edgeId: number } {
  const claimNodeId = context.insertNodeFixture({ title: 'claim under v2 grading' });
  const sourceNodeId = context.insertFixedBeliefCredenceNodeFixture({
    title: `fixed source at credence ${options.sourceBeliefCredence}`,
    beliefCredence: options.sourceBeliefCredence,
  });
  const edgeId = context.insertEvidenceEdgeFixture({
    derivedNodeId: claimNodeId,
    sourceNodeId,
    support: options.support,
  });
  return { claimNodeId, sourceNodeId, edgeId };
}

// Assert the spec-§2 pairing invariant on one node's stored masses: never one
// NULL beside one number.
function expectMassesMoveTogether(context: TempBeliefDatabase, nodeId: number): void {
  const masses = readBeliefEvidenceMasses(context, nodeId);
  expect(
    (masses.belief_evidence_for_mass === null) ===
      (masses.belief_evidence_against_mass === null),
    'belief_evidence_for_mass and belief_evidence_against_mass must be both NULL or both non-NULL'
  ).toBe(true);
}

describe('recomputeNodeBelief persists evidence masses and the credence projection (v2)', () => {
  // §3 row 1 — lone weak vote: fixed source 0.9 × support 0.5 = +0.45 →
  // masses (0.45, 0), cached credence 0.45/2.45, timestamp stamped, edge
  // stamped with the contribution.
  it('§3 row 1: one +0.45 contribution persists masses (0.45, 0) and credence 0.45/2.45', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId } = seedClaimFedByFixedSource(db, {
      sourceBeliefCredence: 0.9,
      support: 0.5,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const masses = readBeliefEvidenceMasses(db, claimNodeId);
    expect(Number(masses.belief_evidence_for_mass)).toBeCloseTo(0.45, 10);
    expect(Number(masses.belief_evidence_against_mass)).toBeCloseTo(0, 10);
    const claimBelief = db.readNodeBelief(claimNodeId);
    expect(Number(claimBelief.belief_credence)).toBeCloseTo(
      expectedBeliefCredenceProjection(0.45, 0),
      10
    );
    expect(Number(claimBelief.belief_credence)).toBeCloseTo(0.45 / 2.45, 10);
    expect(claimBelief.belief_computed_at).not.toBeNull();
    expect(Number(db.readEvidenceStamp(edgeId))).toBeCloseTo(0.45, 10);
    expectMassesMoveTogether(db, claimNodeId);
  });

  // §3 row 6 — disbelieved source: fixed source −0.8 × support 0.75 = −0.6 →
  // the magnitude lands in the AGAINST mass, credence −0.6/2.6, stamp −0.6.
  it('§3 row 6: a disbelieved source persists masses (0, 0.6) and credence −0.6/2.6', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId } = seedClaimFedByFixedSource(db, {
      sourceBeliefCredence: -0.8,
      support: 0.75,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const masses = readBeliefEvidenceMasses(db, claimNodeId);
    expect(Number(masses.belief_evidence_for_mass)).toBeCloseTo(0, 10);
    expect(Number(masses.belief_evidence_against_mass)).toBeCloseTo(0.6, 10);
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(-0.6 / 2.6, 10);
    expect(Number(db.readEvidenceStamp(edgeId))).toBeCloseTo(-0.6, 10);
  });

  // Mixed evidence splits by sign across edges: +0.45 and −0.36 land one in
  // each mass, and the cached credence is the projection of the pair.
  it('splits mixed contributions by sign into the two masses', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId } = seedClaimFedByFixedSource(db, {
      sourceBeliefCredence: 0.9,
      support: 0.5,
    });
    // A second, disbelieved source contradicting the same claim: −0.9 × 0.4.
    const disbelievedSourceNodeId = db.insertFixedBeliefCredenceNodeFixture({
      title: 'disbelieved second source',
      beliefCredence: -0.9,
    });
    db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId: disbelievedSourceNodeId,
      support: 0.4,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const masses = readBeliefEvidenceMasses(db, claimNodeId);
    expect(Number(masses.belief_evidence_for_mass)).toBeCloseTo(0.45, 10);
    expect(Number(masses.belief_evidence_against_mass)).toBeCloseTo(0.36, 10);
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredenceProjection(0.45, 0.36),
      10
    );
  });

  // §3 row 7, the service half: zero COUNTED contributions leaves the node
  // NEVER ASSESSED — masses, credence and timestamp all NULL. Here the node
  // was previously graded and its only source's credence is then cleared, so
  // the recompute must CLEAR all three, not merely skip writing.
  it('§3 row 7: zero counted contributions clears masses, credence and timestamp to NULL', async () => {
    db = await openTempBeliefDatabase();
    // A non-fixed source seeded with a credence, so it can be un-graded later.
    const claimNodeId = db.insertNodeFixture({ title: 'claim that loses its evidence' });
    const sourceNodeId = db.insertNodeFixture({
      title: 'source about to be un-graded',
      beliefCredence: 0.8,
    });
    const edgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId,
      support: 0.5,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    await recomputeNodeBelief(claimNodeId);
    // Precondition: the claim really was graded with masses behind it.
    expect(db.readNodeBelief(claimNodeId).belief_credence).not.toBeNull();
    expect(readBeliefEvidenceMasses(db, claimNodeId).belief_evidence_for_mass).not.toBeNull();

    // The source's credence goes back to NULL, so its vote disappears.
    db.setNodeBeliefCredence(sourceNodeId, null);
    await recomputeNodeBelief(claimNodeId);

    const claimBelief = db.readNodeBelief(claimNodeId);
    expect(claimBelief.belief_credence).toBeNull();
    expect(claimBelief.belief_computed_at).toBeNull();
    const masses = readBeliefEvidenceMasses(db, claimNodeId);
    expect(masses.belief_evidence_for_mass).toBeNull();
    expect(masses.belief_evidence_against_mass).toBeNull();
    // The skipped edge's stamp clears too — the v1 behaviour restated.
    expect(db.readEvidenceStamp(edgeId)).toBeNull();
    expectMassesMoveTogether(db, claimNodeId);
  });

  // The vacuous opinion is NOT the never-assessed state: a counted edge whose
  // contribution is 0 (support 0 from a credible source) persists masses
  // (0, 0) and credence 0 — assessed and carrying nothing (spec §2).
  it('a counted zero contribution persists masses (0, 0) and credence 0, never NULL', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId } = seedClaimFedByFixedSource(db, {
      sourceBeliefCredence: 0.9,
      support: 0,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const masses = readBeliefEvidenceMasses(db, claimNodeId);
    expect(masses.belief_evidence_for_mass).toBe(0);
    expect(masses.belief_evidence_against_mass).toBe(0);
    const claimBelief = db.readNodeBelief(claimNodeId);
    expect(claimBelief.belief_credence).toBe(0);
    expect(claimBelief.belief_computed_at).not.toBeNull();
    // The assessed-and-inert edge is stamped 0, not cleared.
    expect(db.readEvidenceStamp(edgeId)).toBe(0);
    expectMassesMoveTogether(db, claimNodeId);
  });

  // An unassessed source (credence NULL) casts no vote while a graded source
  // beside it is counted: only the counted contribution reaches the masses,
  // and the skipped edge's stamp clears. V1 semantics restated under v2.
  it('an unassessed source casts no vote: masses hold only the counted contribution', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId: countedEdgeId } = seedClaimFedByFixedSource(db, {
      sourceBeliefCredence: 0.9,
      support: 0.5,
    });
    // The never-graded source: its edge must be skipped and left unstamped.
    const ungradedSourceNodeId = db.insertNodeFixture({ title: 'never-graded source' });
    const skippedEdgeId = db.insertEvidenceEdgeFixture({
      derivedNodeId: claimNodeId,
      sourceNodeId: ungradedSourceNodeId,
      support: 0.9,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();

    await recomputeNodeBelief(claimNodeId);

    const masses = readBeliefEvidenceMasses(db, claimNodeId);
    expect(Number(masses.belief_evidence_for_mass)).toBeCloseTo(0.45, 10);
    expect(Number(masses.belief_evidence_against_mass)).toBeCloseTo(0, 10);
    expect(Number(db.readNodeBelief(claimNodeId).belief_credence)).toBeCloseTo(
      expectedBeliefCredenceProjection(0.45, 0),
      10
    );
    expect(Number(db.readEvidenceStamp(countedEdgeId))).toBeCloseTo(0.45, 10);
    expect(db.readEvidenceStamp(skippedEdgeId)).toBeNull();
  });

  // Spec §4: the whole recompute runs inside ONE better-sqlite3 transaction.
  // Behavioural probe: with the belief_movements table dropped, the movement
  // insert at the end of a changing recompute must throw — and because the
  // node update and the edge stamps ran in the same transaction, NONE of them
  // may survive the rollback. (Under a bare multi-write engine the node keeps
  // its new credence and the edge its stamp, which is exactly the partial
  // state this test refuses.)
  it('a failure mid-recompute leaves no partial writes: node and stamps roll back together', async () => {
    db = await openTempBeliefDatabase();
    const { claimNodeId, edgeId } = seedClaimFedByFixedSource(db, {
      sourceBeliefCredence: 0.9,
      support: 0.5,
    });
    const { recomputeNodeBelief } = await db.importBeliefService();
    // Injected failure: the movement log vanishes, so the recompute's final
    // write must throw after the node and stamp writes would have run.
    db.sqlite.prepare('DROP TABLE belief_movements').run();

    await expect(recomputeNodeBelief(claimNodeId)).rejects.toThrow();

    // Nothing before the failure point survived: the claim is still exactly
    // as ungraded as it started, and the edge is still unstamped.
    const claimBelief = db.readNodeBelief(claimNodeId);
    expect(claimBelief.belief_credence).toBeNull();
    expect(claimBelief.belief_computed_at).toBeNull();
    expect(db.readEvidenceStamp(edgeId)).toBeNull();
  });
});
