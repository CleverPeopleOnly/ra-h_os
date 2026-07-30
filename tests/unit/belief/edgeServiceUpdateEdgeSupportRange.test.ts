/**
 * UNSIGNED support range on EdgeService.updateEdge — the load-bearing write
 * door for correcting an edge's support (src/services/database/edges.ts).
 *
 * updateEdgeSQLite builds its UPDATE dynamically from Object.entries(updates),
 * so a belief_evidence_support handed to it today is written to a REAL column
 * with no check of any kind. createEdge already guards this range (see
 * tests/unit/belief/edgeEvidenceHook.test.ts); updateEdge is the same kind of
 * door on the same column and must guard it the same way. This file pins:
 *
 *  - a negative support and a support above 1 are REJECTED, with the stored
 *    support left exactly as it was: support is UNSIGNED 0..1, and the sign of a
 *    contribution comes only from the source NODE's credence,
 *  - exactly 0, exactly 1 and values between are accepted and stored verbatim.
 *    0 must be stored AS 0, never collapsed to NULL: NULL means the edge was
 *    never assessed as evidence, 0 means it was assessed and carries nothing,
 *  - a support that is not a number at all is REJECTED. This is the last door
 *    before SQL and a range test cannot catch it: every NaN comparison is false,
 *    so `< 0 || > 1` waves both cases through. Bound to the REAL column,
 *    better-sqlite3 stores a string AS TEXT and silently turns NaN into NULL —
 *    which would downgrade an assessed edge to "never assessed" and hide it
 *    from the recovery sweep,
 *  - a support-only correction neither requires nor alters the edge's
 *    explanation, and an explanation-only update leaves the stored support
 *    untouched — the two corrections are independent.
 *
 * Runs against a fresh temp-file database per test (see tempBeliefDatabase.ts).
 * Every update goes through the top-level `explanation` field or the support
 * column only, never through context.explanation, so no LLM inference path is
 * ever exercised.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Edge } from '@/types/database';
import { openTempBeliefDatabase, type TempBeliefDatabase } from './helpers/tempBeliefDatabase';

// The support the edge fixture starts with, so a rejected correction can be
// shown to have changed nothing.
const SUPPORT_BEFORE_CORRECTION = 0.75;

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

// Read the support column of one edge straight from SQLite, bypassing the
// service, so a stored 0 can be told apart from a collapsed NULL.
function readEdgeSupportColumn(
  context: TempBeliefDatabase,
  edgeId: number
): number | null {
  const supportRow = context.sqlite
    .prepare('SELECT belief_evidence_support FROM edges WHERE id = ?')
    .get(edgeId) as { belief_evidence_support: number | null };
  return supportRow.belief_evidence_support;
}

// Read the explanation column of one edge straight from SQLite, so a support
// correction can be shown to have left the explanation alone.
function readEdgeExplanationColumn(
  context: TempBeliefDatabase,
  edgeId: number
): string | null {
  const explanationRow = context.sqlite
    .prepare('SELECT explanation FROM edges WHERE id = ?')
    .get(edgeId) as { explanation: string | null };
  return explanationRow.explanation;
}

// Open a database seeded with one graded source node, one claim node, and one
// evidence edge between them carrying SUPPORT_BEFORE_CORRECTION.
async function openDatabaseWithOneEvidenceEdge(): Promise<{
  context: TempBeliefDatabase;
  evidenceEdgeId: number;
  edgeService: (typeof import('@/services/database/edges'))['edgeService'];
}> {
  const context = await openTempBeliefDatabase();
  const claimNodeId = context.insertNodeFixture({ title: 'claim node' });
  // The source carries its own credence: that credence IS the weight its
  // evidence would contribute if anything regraded the target.
  const sourceNodeId = context.insertNodeFixture({
    title: 'evidence source node',
    beliefCredence: 0.9,
  });
  const evidenceEdgeId = context.insertEvidenceEdgeFixture({
    fromNodeId: sourceNodeId,
    toNodeId: claimNodeId,
    support: SUPPORT_BEFORE_CORRECTION,
  });
  const { edgeService } = await context.importEdgeService();
  return { context, evidenceEdgeId, edgeService };
}

describe('EdgeService.updateEdge support range', () => {
  // Support is unsigned: a negative correction is an invalid write, not a
  // contradiction, and it must leave the previously stored support in place.
  it('rejects a negative belief_evidence_support and leaves the stored support unchanged', async () => {
    const { context, evidenceEdgeId, edgeService } = await openDatabaseWithOneEvidenceEdge();
    db = context;

    for (const rejectedNegativeSupport of [-0.4, -1]) {
      const negativeSupportUpdate: EdgeUpdateFields = {
        belief_evidence_support: rejectedNegativeSupport,
      };
      await expect(
        edgeService.updateEdge(evidenceEdgeId, negativeSupportUpdate),
        `a support of ${rejectedNegativeSupport} must be rejected at the EdgeService door`
      ).rejects.toThrow(/belief_evidence_support/);
    }

    expect(readEdgeSupportColumn(context, evidenceEdgeId)).toBe(SUPPORT_BEFORE_CORRECTION);
  });

  // The other invalid side: a support greater than 1 must be refused, again
  // without touching the stored value.
  it('rejects a belief_evidence_support greater than 1 and leaves the stored support unchanged', async () => {
    const { context, evidenceEdgeId, edgeService } = await openDatabaseWithOneEvidenceEdge();
    db = context;

    const oversizedSupportUpdate: EdgeUpdateFields = { belief_evidence_support: 1.5 };
    await expect(edgeService.updateEdge(evidenceEdgeId, oversizedSupportUpdate)).rejects.toThrow(
      /belief_evidence_support/
    );

    expect(readEdgeSupportColumn(context, evidenceEdgeId)).toBe(SUPPORT_BEFORE_CORRECTION);
  });

  // A support that is not a number cannot be in range, and the range check
  // alone cannot refuse it: NaN < 0 and NaN > 1 are both false, and a string
  // compares false too. This door is the last one before SQL, where a string
  // lands in the REAL column as TEXT and NaN lands as NULL — so it must refuse
  // both by name.
  it('rejects a belief_evidence_support that is not a number and leaves the stored support unchanged', async () => {
    const { context, evidenceEdgeId, edgeService } = await openDatabaseWithOneEvidenceEdge();
    db = context;

    // The casts are the shape of the defect, not a convenience: an untyped
    // request body reaching this door through the API route carries exactly
    // these values, so the door cannot rely on the type to have filtered them.
    const nonNumericSupportUpdates: EdgeUpdateFields[] = [
      { belief_evidence_support: 'quite strongly' } as unknown as EdgeUpdateFields,
      { belief_evidence_support: Number.NaN },
    ];

    for (const nonNumericSupportUpdate of nonNumericSupportUpdates) {
      await expect(
        edgeService.updateEdge(evidenceEdgeId, nonNumericSupportUpdate),
        `a support of ${String(nonNumericSupportUpdate.belief_evidence_support)} must be rejected — it is not a number`
      ).rejects.toThrow(/belief_evidence_support/);
    }

    expect(readEdgeSupportColumn(context, evidenceEdgeId)).toBe(SUPPORT_BEFORE_CORRECTION);
  });

  // A support of exactly 0 must survive the correction as 0, never collapse to
  // NULL: NULL would say the edge was never assessed as evidence, when in fact
  // it was assessed and found to carry nothing.
  it('accepts a corrected belief_evidence_support of exactly 0 and stores it as 0, not NULL', async () => {
    const { context, evidenceEdgeId, edgeService } = await openDatabaseWithOneEvidenceEdge();
    db = context;

    const neutralSupportUpdate: EdgeUpdateFields = { belief_evidence_support: 0 };
    await edgeService.updateEdge(evidenceEdgeId, neutralSupportUpdate);

    const storedSupport = readEdgeSupportColumn(context, evidenceEdgeId);
    expect(storedSupport).toBe(0);
    expect(storedSupport).not.toBeNull();
  });

  // The upper boundary of the unsigned range is in range: a correction to
  // full-strength evidence must be stored verbatim.
  it('accepts a corrected belief_evidence_support of exactly 1 and stores it', async () => {
    const { context, evidenceEdgeId, edgeService } = await openDatabaseWithOneEvidenceEdge();
    db = context;

    const fullStrengthSupportUpdate: EdgeUpdateFields = { belief_evidence_support: 1 };
    await edgeService.updateEdge(evidenceEdgeId, fullStrengthSupportUpdate);

    expect(readEdgeSupportColumn(context, evidenceEdgeId)).toBe(1);
  });

  // An ordinary in-between correction must pass through unchanged: the range
  // check must not clamp, round or otherwise touch a valid support.
  it('stores an in-range corrected belief_evidence_support verbatim', async () => {
    const { context, evidenceEdgeId, edgeService } = await openDatabaseWithOneEvidenceEdge();
    db = context;

    const correctedSupportUpdate: EdgeUpdateFields = { belief_evidence_support: 0.42 };
    const correctedEdge = await edgeService.updateEdge(evidenceEdgeId, correctedSupportUpdate);

    expect(Number(readEdgeSupportColumn(context, evidenceEdgeId))).toBeCloseTo(0.42, 10);
    // The returned edge reports the corrected support too, so a caller does not
    // have to re-read the row to see what it just wrote.
    expect(Number(correctedEdge.belief_evidence_support)).toBeCloseTo(0.42, 10);
  });

  // A support correction stands on its own: it must not demand an explanation,
  // and it must not rewrite the one the edge already has.
  it('corrects the support without requiring or altering the edge explanation', async () => {
    const { context, evidenceEdgeId, edgeService } = await openDatabaseWithOneEvidenceEdge();
    db = context;
    const explanationBeforeCorrection = readEdgeExplanationColumn(context, evidenceEdgeId);

    const supportOnlyUpdate: EdgeUpdateFields = { belief_evidence_support: 0.42 };
    await edgeService.updateEdge(evidenceEdgeId, supportOnlyUpdate);

    expect(readEdgeExplanationColumn(context, evidenceEdgeId)).toBe(explanationBeforeCorrection);
  });

  // GUARD: explanation-only updates must keep working exactly as they do today,
  // and must leave the support column alone — correcting the words must not
  // silently un-assess the evidence.
  it('GUARD: an explanation-only update rewrites the explanation and leaves the stored support untouched', async () => {
    const { context, evidenceEdgeId, edgeService } = await openDatabaseWithOneEvidenceEdge();
    db = context;

    const explanationOnlyUpdate: EdgeUpdateFields = {
      explanation: 'The source node reports a measured result bearing on the claim node.',
    };
    await edgeService.updateEdge(evidenceEdgeId, explanationOnlyUpdate);

    expect(readEdgeExplanationColumn(context, evidenceEdgeId)).toBe(
      'The source node reports a measured result bearing on the claim node.'
    );
    expect(readEdgeSupportColumn(context, evidenceEdgeId)).toBe(SUPPORT_BEFORE_CORRECTION);
  });
});
