/**
 * The evidence hook on EdgeService.updateEdge — correcting an edge's support
 * must REGRADE the node that edge points at (src/services/database/edges.ts).
 *
 * createEdge already fires this hook: a new gradeable evidence edge calls
 * recomputeNodeBelief(to_node_id) before it returns. updateEdge has no
 * equivalent, and that is a correctness hole rather than a missing nicety:
 *
 *  - edges.belief_evidence_contribution was stamped from the OLD support, so
 *    after a correction it is stale AND STILL NON-NULL,
 *  - beliefRecoveryService finds ungraded evidence by looking for a NULL
 *    contribution, so a stale non-NULL stamp is invisible to it,
 *  - the target node's belief_credence is therefore wrong permanently, not
 *    "until the next sweep".
 *
 * This file pins, at the same door and in the same fixture style as
 * tests/unit/belief/edgeServiceUpdateEdgeSupportRange.test.ts:
 *
 *  - an accepted in-range correction regrades the target node to what the
 *    two-variable model gives for the CORRECTED support (source credence ×
 *    corrected support, fed through the pinned grading policy) — a value the
 *    test derives by asking beliefGradingPolicyV1 itself, never by restating
 *    its formula,
 *  - the edge's own contribution is re-stamped from the corrected support, so
 *    no stale stamp survives the write,
 *  - a correction to exactly 0 still regrades: an assessed-carries-nothing edge
 *    moves the target's credence to the graded value 0, and is not skipped as
 *    if it had never been evidence,
 *  - a REJECTED correction (out of range, or not a number at all) regrades
 *    nothing: the target's credence and the edge's contribution are untouched,
 *  - UN-ASSESSING an edge — setting belief_evidence_support to NULL — regrades
 *    the target too. This is the one case the `!= null` convention borrowed from
 *    createEdge gets wrong: on create, null support means the edge never was
 *    evidence, so there is nothing to regrade; on update it means an edge that
 *    WAS evidence has stopped being evidence, which changes the target's
 *    credence. The write is reachable (PUT /api/edges/[id] spreads the body
 *    through, and the dynamic UPDATE loop filters only undefined), so without a
 *    regrade the target keeps a credence graded from evidence that no longer
 *    exists and the edge keeps a stale non-NULL contribution — invisible to
 *    beliefRecoveryService, which hunts NULL contributions,
 *  - un-assessing the ONLY evidence edge leaves the target with NO credence
 *    (NULL), because a node with no belief evidence is ungraded rather than 0,
 *  - un-assessing CLEARS the edge's own contribution: a non-evidence edge
 *    carrying a contribution is a lying column, and an active trap — were
 *    support later restored on an edge whose stale stamp survived, the recovery
 *    sweep would read it as already graded and skip it,
 *  - GUARD: an explanation-only update does NOT regrade — the credence does not
 *    move and no belief_movements row is appended. Correcting the words is not
 *    new evidence, and a spurious movement row would pollute the credence
 *    history.
 *
 * Runs against a fresh temp-file database per test (see tempBeliefDatabase.ts).
 * Every update goes through the top-level `explanation` field or the support
 * column only, never through context.explanation, so no LLM inference path is
 * ever exercised. beliefGradingPolicy is a pure module that imports nothing, so
 * importing it statically cannot open a database (the same static import
 * tests/unit/belief/beliefGrading.test.ts already makes).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Edge } from '@/types/database';
// EDITED per spec §7: expected credences are derived via the v2 policy — the
// v1 exponential is deleted, not kept beside it.
import { beliefGradingPolicyV2 } from '@/services/belief/beliefGradingPolicy';
import { openTempBeliefDatabase, type TempBeliefDatabase } from './helpers/tempBeliefDatabase';

// The source node's own credence: the one signed term in a contribution, and
// the same number and word as the belief of any other node.
const SOURCE_BELIEF_CREDENCE = 0.9;

// The support the edge carries before the correction, and the in-range value it
// is corrected to. They differ enough that a hook which never fires cannot pass
// by coincidence.
const SUPPORT_BEFORE_CORRECTION = 0.75;
const SUPPORT_AFTER_CORRECTION = 0.4;

// A SECOND source node's own credence, and the support of the edge it supplies.
// The un-assessment tests need a target fed by two evidence edges, so that
// removing one leaves a real non-NULL credence behind to assert against. Both
// values differ from the first edge's so the remaining edge's own grade cannot
// be confused with the pair's.
const SECOND_SOURCE_BELIEF_CREDENCE = 0.5;
const SECOND_EDGE_SUPPORT = 0.6;

// How long an assertion about a regrade waits for the hook to land, and how
// long a "nothing happened" assertion lets a wrongly-fired hook surface first.
const REGRADE_WAIT_TIMEOUT_MS = 1500;
const REGRADE_SETTLE_DELAY_MS = 250;

// The update object EdgeService.updateEdge accepts. Partial<Edge> already
// carries belief_evidence_support; `explanation` is a top-level edges column the
// service reads off the update but which the Edge type does not declare.
type EdgeUpdateFields = Partial<Edge> & { explanation?: string };

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// The credence a node holds when its only counted evidence is one edge with the
// given signed contribution. Derived by asking the pinned v2 policy itself, so
// this file never restates the grading formula.
function expectedBeliefCredenceForOneEvidenceEdge(
  edgeId: number,
  signedContribution: number
): number {
  return beliefGradingPolicyV2.gradeBelief([{ edgeId, signedContribution }]);
}

// Read the support column of one edge straight from SQLite, bypassing the
// service.
function readEdgeSupportColumn(context: TempBeliefDatabase, edgeId: number): number | null {
  const supportRow = context.sqlite
    .prepare('SELECT belief_evidence_support FROM edges WHERE id = ?')
    .get(edgeId) as { belief_evidence_support: number | null };
  return supportRow.belief_evidence_support;
}

// Read the explanation column of one edge straight from SQLite.
function readEdgeExplanationColumn(context: TempBeliefDatabase, edgeId: number): string | null {
  const explanationRow = context.sqlite
    .prepare('SELECT explanation FROM edges WHERE id = ?')
    .get(edgeId) as { explanation: string | null };
  return explanationRow.explanation;
}

// Everything a correction test drives, in the state a real corrected edge is in:
// the target node ALREADY GRADED from the old support and the edge ALREADY
// STAMPED with the contribution that support produced.
interface GradedEvidenceEdgeFixture {
  context: TempBeliefDatabase;
  // The node the evidence edge points at — the one a correction must regrade.
  claimNodeId: number;
  // The evidence edge whose support the tests correct.
  evidenceEdgeId: number;
  // The target's credence before any correction, as the initial grade left it.
  claimBeliefCredenceBeforeCorrection: number;
  // The edge's stamped contribution before any correction (source credence ×
  // the old support).
  edgeContributionBeforeCorrection: number;
  // How many movement rows the initial grade left on the target, so a test can
  // prove a later update appended none.
  claimBeliefMovementCountBeforeCorrection: number;
  edgeService: (typeof import('@/services/database/edges'))['edgeService'];
}

// Open a database holding one graded source node, one claim node and one
// evidence edge between them, then run the initial recompute so the fixture
// starts where a real graph does: target graded, edge stamped, one movement
// logged. Returns the pre-correction readings the assertions compare against.
async function openDatabaseWithGradedEvidenceEdge(): Promise<GradedEvidenceEdgeFixture> {
  const context = await openTempBeliefDatabase();
  const claimNodeId = context.insertNodeFixture({ title: 'claim node' });
  const sourceNodeId = context.insertNodeFixture({
    title: 'evidence source node',
    beliefCredence: SOURCE_BELIEF_CREDENCE,
  });
  const evidenceEdgeId = context.insertEvidenceEdgeFixture({
    fromNodeId: sourceNodeId,
    toNodeId: claimNodeId,
    support: SUPPORT_BEFORE_CORRECTION,
  });

  // Establish the pre-correction state through the real engine rather than by
  // writing the numbers by hand, so the stale-stamp case is genuinely stale.
  const { recomputeNodeBelief } = await context.importBeliefService();
  await recomputeNodeBelief(claimNodeId);

  const claimBeliefCredenceBeforeCorrection = Number(
    context.readNodeBelief(claimNodeId).belief_credence
  );
  const edgeContributionBeforeCorrection = Number(context.readEvidenceStamp(evidenceEdgeId));
  const claimBeliefMovementCountBeforeCorrection =
    context.readBeliefMovements(claimNodeId).length;

  const { edgeService } = await context.importEdgeService();
  return {
    context,
    claimNodeId,
    evidenceEdgeId,
    claimBeliefCredenceBeforeCorrection,
    edgeContributionBeforeCorrection,
    claimBeliefMovementCountBeforeCorrection,
    edgeService,
  };
}

// The credence a node holds when TWO counted evidence edges feed it, derived by
// asking the pinned v2 policy itself so the formula is never restated here.
function expectedBeliefCredenceForTwoEvidenceEdges(
  firstEdgeId: number,
  firstSignedContribution: number,
  secondEdgeId: number,
  secondSignedContribution: number
): number {
  return beliefGradingPolicyV2.gradeBelief([
    { edgeId: firstEdgeId, signedContribution: firstSignedContribution },
    { edgeId: secondEdgeId, signedContribution: secondSignedContribution },
  ]);
}

// Everything an UN-ASSESSMENT test drives: one target fed by two evidence edges
// from two graded source nodes, already regraded, so removing one edge from the
// evidence leaves a known non-NULL credence to assert against.
interface TwoGradedEvidenceEdgesFixture {
  context: TempBeliefDatabase;
  // The node both evidence edges point at — the one un-assessing must regrade.
  claimNodeId: number;
  // The edge the tests un-assess by setting its support to NULL.
  unassessedEvidenceEdgeId: number;
  // The edge that stays evidence, and whose contribution alone must therefore
  // decide the target's credence afterwards.
  remainingEvidenceEdgeId: number;
  // The target's credence while BOTH edges still count.
  claimBeliefCredenceBeforeUnassessment: number;
  // The contribution stamped on the edge that is about to be un-assessed.
  unassessedEdgeContributionBeforeUnassessment: number;
  edgeService: (typeof import('@/services/database/edges'))['edgeService'];
}

// Open a database holding one claim node fed by two evidence edges from two
// graded source nodes, then run the initial recompute so both edges are stamped
// and the target is graded from the pair.
async function openDatabaseWithTwoGradedEvidenceEdges(): Promise<TwoGradedEvidenceEdgesFixture> {
  const context = await openTempBeliefDatabase();
  const claimNodeId = context.insertNodeFixture({ title: 'claim node' });
  const sourceNodeToBeUnassessed = context.insertNodeFixture({
    title: 'evidence source node whose edge gets un-assessed',
    beliefCredence: SOURCE_BELIEF_CREDENCE,
  });
  const sourceNodeThatRemainsEvidence = context.insertNodeFixture({
    title: 'evidence source node whose edge stays evidence',
    beliefCredence: SECOND_SOURCE_BELIEF_CREDENCE,
  });
  const unassessedEvidenceEdgeId = context.insertEvidenceEdgeFixture({
    fromNodeId: sourceNodeToBeUnassessed,
    toNodeId: claimNodeId,
    support: SUPPORT_BEFORE_CORRECTION,
  });
  const remainingEvidenceEdgeId = context.insertEvidenceEdgeFixture({
    fromNodeId: sourceNodeThatRemainsEvidence,
    toNodeId: claimNodeId,
    support: SECOND_EDGE_SUPPORT,
  });

  // Grade through the real engine, so both stamps and the target's credence are
  // the engine's own output rather than numbers written by hand.
  const { recomputeNodeBelief } = await context.importBeliefService();
  await recomputeNodeBelief(claimNodeId);

  const claimBeliefCredenceBeforeUnassessment = Number(
    context.readNodeBelief(claimNodeId).belief_credence
  );
  const unassessedEdgeContributionBeforeUnassessment = Number(
    context.readEvidenceStamp(unassessedEvidenceEdgeId)
  );

  const { edgeService } = await context.importEdgeService();
  return {
    context,
    claimNodeId,
    unassessedEvidenceEdgeId,
    remainingEvidenceEdgeId,
    claimBeliefCredenceBeforeUnassessment,
    unassessedEdgeContributionBeforeUnassessment,
    edgeService,
  };
}

describe('EdgeService.updateEdge evidence hook', () => {
  // Sanity check on the fixture itself: the pre-correction state really is the
  // graded-and-stamped one the correction tests assume, so a failure below is
  // about the hook and not about a fixture that never graded.
  it('starts from a target graded and an edge stamped from the support before the correction', async () => {
    const fixture = await openDatabaseWithGradedEvidenceEdge();
    db = fixture.context;

    expect(fixture.edgeContributionBeforeCorrection).toBeCloseTo(
      SOURCE_BELIEF_CREDENCE * SUPPORT_BEFORE_CORRECTION,
      10
    );
    expect(fixture.claimBeliefCredenceBeforeCorrection).toBeCloseTo(
      expectedBeliefCredenceForOneEvidenceEdge(
        fixture.evidenceEdgeId,
        SOURCE_BELIEF_CREDENCE * SUPPORT_BEFORE_CORRECTION
      ),
      10
    );
    expect(fixture.claimBeliefMovementCountBeforeCorrection).toBe(1);
  });

  // The correctness hole: after an accepted correction the target's credence
  // must be what the corrected support grades to, not what the old one did.
  it('regrades the target node to the credence the corrected support produces', async () => {
    const fixture = await openDatabaseWithGradedEvidenceEdge();
    db = fixture.context;

    const correctedSupportUpdate: EdgeUpdateFields = {
      belief_evidence_support: SUPPORT_AFTER_CORRECTION,
    };
    await fixture.edgeService.updateEdge(fixture.evidenceEdgeId, correctedSupportUpdate);

    const expectedCredenceAfterCorrection = expectedBeliefCredenceForOneEvidenceEdge(
      fixture.evidenceEdgeId,
      SOURCE_BELIEF_CREDENCE * SUPPORT_AFTER_CORRECTION
    );
    await vi.waitFor(
      () => {
        expect(Number(fixture.context.readNodeBelief(fixture.claimNodeId).belief_credence)).toBeCloseTo(
          expectedCredenceAfterCorrection,
          10
        );
      },
      { timeout: REGRADE_WAIT_TIMEOUT_MS, interval: 25 }
    );
    // And it genuinely MOVED: a hook that never fired would leave the old
    // credence in place, which is the failure this guards against.
    expect(expectedCredenceAfterCorrection).not.toBeCloseTo(
      fixture.claimBeliefCredenceBeforeCorrection,
      10
    );
    expect(
      Number(fixture.context.readNodeBelief(fixture.claimNodeId).belief_credence)
    ).not.toBeCloseTo(fixture.claimBeliefCredenceBeforeCorrection, 10);
  });

  // The stale stamp is the reason the hole is permanent: a contribution left
  // over from the old support is still NON-NULL, so the recovery sweep — which
  // looks for a NULL contribution — never revisits this edge.
  it('re-stamps the edge contribution from the corrected support, leaving no stale non-NULL stamp', async () => {
    const fixture = await openDatabaseWithGradedEvidenceEdge();
    db = fixture.context;

    const correctedSupportUpdate: EdgeUpdateFields = {
      belief_evidence_support: SUPPORT_AFTER_CORRECTION,
    };
    await fixture.edgeService.updateEdge(fixture.evidenceEdgeId, correctedSupportUpdate);

    const expectedContributionAfterCorrection =
      SOURCE_BELIEF_CREDENCE * SUPPORT_AFTER_CORRECTION;
    await vi.waitFor(
      () => {
        expect(Number(fixture.context.readEvidenceStamp(fixture.evidenceEdgeId))).toBeCloseTo(
          expectedContributionAfterCorrection,
          10
        );
      },
      { timeout: REGRADE_WAIT_TIMEOUT_MS, interval: 25 }
    );
    expect(Number(fixture.context.readEvidenceStamp(fixture.evidenceEdgeId))).not.toBeCloseTo(
      fixture.edgeContributionBeforeCorrection,
      10
    );
  });

  // A correction to exactly 0 is an assessed judgement that the edge carries
  // nothing, so it must still regrade: the target lands on the graded value 0
  // (the formula's answer for S = 0, C = 0), never on its old credence and never
  // back on NULL, which would claim the edge had never been assessed.
  it('regrades the target node when the support is corrected to exactly 0', async () => {
    const fixture = await openDatabaseWithGradedEvidenceEdge();
    db = fixture.context;

    const neutralSupportUpdate: EdgeUpdateFields = { belief_evidence_support: 0 };
    await fixture.edgeService.updateEdge(fixture.evidenceEdgeId, neutralSupportUpdate);

    const expectedCredenceForNeutralEvidence = expectedBeliefCredenceForOneEvidenceEdge(
      fixture.evidenceEdgeId,
      SOURCE_BELIEF_CREDENCE * 0
    );
    await vi.waitFor(
      () => {
        const claimBeliefAfterCorrection = fixture.context.readNodeBelief(fixture.claimNodeId);
        // Graded-and-balanced, not ungraded: the credence must be a number.
        expect(claimBeliefAfterCorrection.belief_credence).not.toBeNull();
        expect(Number(claimBeliefAfterCorrection.belief_credence)).toBeCloseTo(
          expectedCredenceForNeutralEvidence,
          10
        );
      },
      { timeout: REGRADE_WAIT_TIMEOUT_MS, interval: 25 }
    );
    // The edge is still evidence, so its contribution is re-stamped as 0 rather
    // than cleared to NULL.
    expect(fixture.context.readEvidenceStamp(fixture.evidenceEdgeId)).toBe(0);
  });

  // Sanity check on the two-edge fixture: the target really is graded from BOTH
  // contributions and both edges really are stamped, so an un-assessment failure
  // below is about the hook and not about a fixture that never graded.
  it('starts from a target graded by both evidence edges before either is un-assessed', async () => {
    const fixture = await openDatabaseWithTwoGradedEvidenceEdges();
    db = fixture.context;

    expect(fixture.unassessedEdgeContributionBeforeUnassessment).toBeCloseTo(
      SOURCE_BELIEF_CREDENCE * SUPPORT_BEFORE_CORRECTION,
      10
    );
    expect(Number(fixture.context.readEvidenceStamp(fixture.remainingEvidenceEdgeId))).toBeCloseTo(
      SECOND_SOURCE_BELIEF_CREDENCE * SECOND_EDGE_SUPPORT,
      10
    );
    expect(fixture.claimBeliefCredenceBeforeUnassessment).toBeCloseTo(
      expectedBeliefCredenceForTwoEvidenceEdges(
        fixture.unassessedEvidenceEdgeId,
        SOURCE_BELIEF_CREDENCE * SUPPORT_BEFORE_CORRECTION,
        fixture.remainingEvidenceEdgeId,
        SECOND_SOURCE_BELIEF_CREDENCE * SECOND_EDGE_SUPPORT
      ),
      10
    );
  });

  // UN-ASSESSING is a real change to the evidence: an edge that was evidence
  // stops being evidence, so the target must be regraded from what is LEFT. The
  // `!= null` guard borrowed from createEdge skips exactly this write, leaving
  // the target graded from evidence that no longer exists.
  it('regrades the target node to the remaining edge alone when an evidence edge is un-assessed', async () => {
    const fixture = await openDatabaseWithTwoGradedEvidenceEdges();
    db = fixture.context;

    // NULL support is the one thing that makes an edge not evidence at all.
    const unassessingUpdate: EdgeUpdateFields = { belief_evidence_support: null };
    await fixture.edgeService.updateEdge(fixture.unassessedEvidenceEdgeId, unassessingUpdate);

    const expectedCredenceFromRemainingEdgeAlone = expectedBeliefCredenceForOneEvidenceEdge(
      fixture.remainingEvidenceEdgeId,
      SECOND_SOURCE_BELIEF_CREDENCE * SECOND_EDGE_SUPPORT
    );
    await vi.waitFor(
      () => {
        const claimBeliefAfterUnassessment = fixture.context.readNodeBelief(fixture.claimNodeId);
        // Still graded, just from less evidence: one edge remains, so the
        // credence is a real number rather than NULL.
        expect(claimBeliefAfterUnassessment.belief_credence).not.toBeNull();
        expect(Number(claimBeliefAfterUnassessment.belief_credence)).toBeCloseTo(
          expectedCredenceFromRemainingEdgeAlone,
          10
        );
      },
      { timeout: REGRADE_WAIT_TIMEOUT_MS, interval: 25 }
    );
    // And it genuinely MOVED off the two-edge grade: a hook that never fired
    // would leave the pair's credence in place, which is the hole this closes.
    expect(expectedCredenceFromRemainingEdgeAlone).not.toBeCloseTo(
      fixture.claimBeliefCredenceBeforeUnassessment,
      10
    );
    expect(
      Number(fixture.context.readNodeBelief(fixture.claimNodeId).belief_credence)
    ).not.toBeCloseTo(fixture.claimBeliefCredenceBeforeUnassessment, 10);
  });

  // Un-assessing the ONLY evidence edge leaves the node with no evidence at all,
  // and a node with no evidence has NO credence: NULL, never 0. 0 would claim
  // the node was graded and came out balanced, which is a different statement.
  it('leaves the target node with a NULL credence when its only evidence edge is un-assessed', async () => {
    const fixture = await openDatabaseWithGradedEvidenceEdge();
    db = fixture.context;

    const unassessingUpdate: EdgeUpdateFields = { belief_evidence_support: null };
    await fixture.edgeService.updateEdge(fixture.evidenceEdgeId, unassessingUpdate);

    await vi.waitFor(
      () => {
        expect(fixture.context.readNodeBelief(fixture.claimNodeId).belief_credence).toBeNull();
      },
      { timeout: REGRADE_WAIT_TIMEOUT_MS, interval: 25 }
    );
    // The support really is NULL now, so the assertion above is about an
    // un-assessed edge rather than a write that never landed.
    expect(readEdgeSupportColumn(fixture.context, fixture.evidenceEdgeId)).toBeNull();
  });

  // An edge that is no longer evidence must not keep a contribution. Beyond
  // being a lying column, a surviving stamp is a trap: the recovery sweep looks
  // for a NULL contribution, so if support were later restored on this edge it
  // would read as already graded and be skipped.
  it('clears the un-assessed edge contribution to NULL while the remaining edge keeps its own', async () => {
    const fixture = await openDatabaseWithTwoGradedEvidenceEdges();
    db = fixture.context;

    const unassessingUpdate: EdgeUpdateFields = { belief_evidence_support: null };
    await fixture.edgeService.updateEdge(fixture.unassessedEvidenceEdgeId, unassessingUpdate);

    await vi.waitFor(
      () => {
        expect(fixture.context.readEvidenceStamp(fixture.unassessedEvidenceEdgeId)).toBeNull();
      },
      { timeout: REGRADE_WAIT_TIMEOUT_MS, interval: 25 }
    );
    // Targeted, not a blanket wipe: the edge that is still evidence keeps the
    // contribution its own source and support produce.
    expect(Number(fixture.context.readEvidenceStamp(fixture.remainingEvidenceEdgeId))).toBeCloseTo(
      SECOND_SOURCE_BELIEF_CREDENCE * SECOND_EDGE_SUPPORT,
      10
    );
  });

  // A refused correction must leave the belief state exactly as it was: nothing
  // was written, so there is nothing to regrade from.
  it('regrades nothing when the correction is rejected as out of range or not a number', async () => {
    const fixture = await openDatabaseWithGradedEvidenceEdge();
    db = fixture.context;

    // One value per rejection reason: below the range, above it, and a value
    // that is not a number at all (which no range comparison can catch).
    const rejectedSupportUpdates: EdgeUpdateFields[] = [
      { belief_evidence_support: -0.4 },
      { belief_evidence_support: 1.5 },
      { belief_evidence_support: 'quite strongly' } as unknown as EdgeUpdateFields,
    ];
    for (const rejectedSupportUpdate of rejectedSupportUpdates) {
      await expect(
        fixture.edgeService.updateEdge(fixture.evidenceEdgeId, rejectedSupportUpdate),
        `a support of ${String(rejectedSupportUpdate.belief_evidence_support)} must be rejected before anything is written`
      ).rejects.toThrow(/belief_evidence_support/);
    }

    // Let any wrongly-fired regrade surface before asserting nothing happened.
    await new Promise((resolve) => setTimeout(resolve, REGRADE_SETTLE_DELAY_MS));

    expect(readEdgeSupportColumn(fixture.context, fixture.evidenceEdgeId)).toBe(
      SUPPORT_BEFORE_CORRECTION
    );
    expect(
      Number(fixture.context.readNodeBelief(fixture.claimNodeId).belief_credence)
    ).toBeCloseTo(fixture.claimBeliefCredenceBeforeCorrection, 10);
    expect(Number(fixture.context.readEvidenceStamp(fixture.evidenceEdgeId))).toBeCloseTo(
      fixture.edgeContributionBeforeCorrection,
      10
    );
    expect(fixture.context.readBeliefMovements(fixture.claimNodeId)).toHaveLength(
      fixture.claimBeliefMovementCountBeforeCorrection
    );
  });

  // GUARD: rewording an explanation is not new evidence. The credence must not
  // move and no movement row may be appended — a spurious movement would put a
  // change into the credence history that never happened.
  it('GUARD: an explanation-only update neither regrades the target node nor appends a belief movement', async () => {
    const fixture = await openDatabaseWithGradedEvidenceEdge();
    db = fixture.context;

    const explanationOnlyUpdate: EdgeUpdateFields = {
      explanation: 'The source node reports a measured result bearing on the claim node.',
    };
    await fixture.edgeService.updateEdge(fixture.evidenceEdgeId, explanationOnlyUpdate);

    // Let any wrongly-fired regrade surface before asserting nothing happened.
    await new Promise((resolve) => setTimeout(resolve, REGRADE_SETTLE_DELAY_MS));

    expect(readEdgeExplanationColumn(fixture.context, fixture.evidenceEdgeId)).toBe(
      'The source node reports a measured result bearing on the claim node.'
    );
    expect(
      Number(fixture.context.readNodeBelief(fixture.claimNodeId).belief_credence)
    ).toBeCloseTo(fixture.claimBeliefCredenceBeforeCorrection, 10);
    expect(Number(fixture.context.readEvidenceStamp(fixture.evidenceEdgeId))).toBeCloseTo(
      fixture.edgeContributionBeforeCorrection,
      10
    );
    expect(fixture.context.readBeliefMovements(fixture.claimNodeId)).toHaveLength(
      fixture.claimBeliefMovementCountBeforeCorrection
    );
  });

  // The regrade lands in the database, but the Edge object updateEdge RETURNS
  // is read before the hook runs, so its contribution is the one stamped from
  // the OLD support. A caller reading it off the return value gets a number
  // that was true a moment ago and is not true now.
  it('returns an edge carrying the contribution re-stamped from the corrected support', async () => {
    const fixture = await openDatabaseWithGradedEvidenceEdge();
    db = fixture.context;

    const correctedSupportUpdate: EdgeUpdateFields = {
      belief_evidence_support: SUPPORT_AFTER_CORRECTION,
    };
    const correctedEdge = await fixture.edgeService.updateEdge(
      fixture.evidenceEdgeId,
      correctedSupportUpdate
    );

    expect(correctedEdge.belief_evidence_contribution).not.toBeNull();
    expect(Number(correctedEdge.belief_evidence_contribution)).toBeCloseTo(
      SOURCE_BELIEF_CREDENCE * SUPPORT_AFTER_CORRECTION,
      10
    );
    // Explicitly NOT the pre-correction stamp: without this a return value that
    // merely happened to re-read a stale-but-equal number could pass.
    expect(Number(correctedEdge.belief_evidence_contribution)).not.toBeCloseTo(
      fixture.edgeContributionBeforeCorrection,
      10
    );
  });

  // Same defect on the un-assessment path, where it is starker: the hook clears
  // the column to NULL, so the returned object reports a contribution for an
  // edge that is no longer evidence at all.
  it('returns an edge carrying a NULL contribution when the edge is un-assessed', async () => {
    const fixture = await openDatabaseWithGradedEvidenceEdge();
    db = fixture.context;

    // NULL support is the one thing that makes an edge not evidence at all.
    const unassessingUpdate: EdgeUpdateFields = { belief_evidence_support: null };
    const unassessedEdge = await fixture.edgeService.updateEdge(
      fixture.evidenceEdgeId,
      unassessingUpdate
    );

    expect(unassessedEdge.belief_evidence_support ?? null).toBeNull();
    expect(unassessedEdge.belief_evidence_contribution ?? null).toBeNull();
  });

  // The rule the two tests above are instances of: the edge object updateEdge
  // hands back must not disagree with the row in the database. Both write paths
  // are checked against the stored column itself rather than against a
  // recomputed expectation, so the object and the row are compared directly.
  it('returns an edge whose contribution agrees with the stored row on both write paths', async () => {
    const correctionFixture = await openDatabaseWithGradedEvidenceEdge();
    db = correctionFixture.context;

    const correctedSupportUpdate: EdgeUpdateFields = {
      belief_evidence_support: SUPPORT_AFTER_CORRECTION,
    };
    const correctedEdge = await correctionFixture.edgeService.updateEdge(
      correctionFixture.evidenceEdgeId,
      correctedSupportUpdate
    );
    // The contribution as SQLite holds it after the regrade — the only source
    // of truth the returned object is allowed to differ from by nothing.
    const storedContributionAfterCorrection = correctionFixture.context.readEvidenceStamp(
      correctionFixture.evidenceEdgeId
    );
    expect(Number(correctedEdge.belief_evidence_contribution)).toBeCloseTo(
      Number(storedContributionAfterCorrection),
      10
    );

    // Second database for the un-assessment path, so neither path can be
    // influenced by the other's writes.
    correctionFixture.context.close();
    const unassessmentFixture = await openDatabaseWithGradedEvidenceEdge();
    db = unassessmentFixture.context;

    const unassessingUpdate: EdgeUpdateFields = { belief_evidence_support: null };
    const unassessedEdge = await unassessmentFixture.edgeService.updateEdge(
      unassessmentFixture.evidenceEdgeId,
      unassessingUpdate
    );
    const storedContributionAfterUnassessment = unassessmentFixture.context.readEvidenceStamp(
      unassessmentFixture.evidenceEdgeId
    );
    expect(unassessedEdge.belief_evidence_contribution ?? null).toBe(
      storedContributionAfterUnassessment
    );
  });

  // GUARD: no regrade ran, so there is nothing fresher to read — the returned
  // edge must still carry the contribution it had, matching the stored row.
  it('GUARD: an explanation-only update returns the edge with its contribution untouched', async () => {
    const fixture = await openDatabaseWithGradedEvidenceEdge();
    db = fixture.context;

    const explanationOnlyUpdate: EdgeUpdateFields = {
      explanation: 'The source node reports a measured result bearing on the claim node.',
    };
    const rewordedEdge = await fixture.edgeService.updateEdge(
      fixture.evidenceEdgeId,
      explanationOnlyUpdate
    );

    expect(Number(rewordedEdge.belief_evidence_contribution)).toBeCloseTo(
      fixture.edgeContributionBeforeCorrection,
      10
    );
    expect(Number(rewordedEdge.belief_evidence_contribution)).toBeCloseTo(
      Number(fixture.context.readEvidenceStamp(fixture.evidenceEdgeId)),
      10
    );
  });
});
