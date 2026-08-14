/**
 * FAILING-FIRST tests for the evidence-leaves-the-edges-table slice, engine
 * side (src/services/belief/beliefService.ts): THE ENGINE'S EVIDENCE-READ
 * PATH IS GONE.
 *
 * Belief evidence moved out of this fork into samai's own store, so no edge
 * carries evidence any more and every node's evidence basis is EMPTY BY
 * DEFINITION. Until later slices delete the engine wholesale, the interim
 * semantics pinned here are:
 *
 *  - recomputeNodeBelief of a NON-FIXED node lands never-assessed — credence
 *    NULL, computed_at NULL, both masses NULL — no matter what edges the node
 *    has or how well graded the nodes they point at are, and null credence is
 *    a REAL answer carried in the normal result shape,
 *  - a FIXED node keeps its asserted credence through a recompute (already
 *    true today via the fixed short-circuit — pinned here as the survivor it
 *    is),
 *  - clearBeliefFixedCredence still clears the flag, and its immediate
 *    regrade now lands never-assessed with NO movement row (an ungraded
 *    outcome has no to_credence to record, so nothing is logged),
 *  - setBeliefFixedCredence no longer propagates to any other node: the
 *    dependent sweep has no evidence edges to walk, so a neighbouring node
 *    stays exactly as it was.
 *
 * LEGACY-SHAPE FIXTURES. To make these tests FAIL against the pre-slice
 * engine, each edge fixture writes belief_evidence_support ONLY WHERE THE
 * COLUMN STILL EXISTS: pre-slice that makes the edge gradeable evidence the
 * old engine acts on (the red state); post-slice the same call writes a plain
 * relationship edge — the only kind there is — and every pin holds by
 * definition.
 *
 * Runs against a fresh temp-file database per test (see tempBeliefDatabase.ts
 * for the safety seam).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// The database context under test; opened per test, closed after each.
let tempDb: TempBeliefDatabase | undefined;

afterEach(() => {
  tempDb?.close();
  tempDb = undefined;
});

/**
 * Insert one edge from derivedNodeId to sourceNodeId (canon orientation,
 * Derivative→Source). Where the edges table still carries the pre-slice
 * belief_evidence_support column, the edge gets the given support so the OLD
 * engine treats it as gradeable evidence — which is exactly what makes these
 * tests red before the slice lands. After the slice the column does not
 * exist, the same call writes a plain relationship edge, and the pins hold.
 */
function insertEdgeCarryingLegacySupportWhereColumnExists(
  context: TempBeliefDatabase,
  options: { derivedNodeId: number; sourceNodeId: number; legacySupport: number }
): number {
  const edgeTableStillHasLegacySupportColumn = context
    .readTableColumns('edges')
    .some(column => column.name === 'belief_evidence_support');

  const insertResult = edgeTableStillHasLegacySupportColumn
    ? context.sqlite
        .prepare(
          `INSERT INTO edges (from_node_id, to_node_id, source, explanation, belief_evidence_support)
           VALUES (?, ?, 'user', 'legacy-shape engine fixture edge', ?)`
        )
        .run(options.derivedNodeId, options.sourceNodeId, options.legacySupport)
    : context.sqlite
        .prepare(
          `INSERT INTO edges (from_node_id, to_node_id, source, explanation)
           VALUES (?, ?, 'user', 'legacy-shape engine fixture edge')`
        )
        .run(options.derivedNodeId, options.sourceNodeId);
  return Number(insertResult.lastInsertRowid);
}

// One node's full belief state as stored, including both evidence masses —
// what "never assessed" must look like on the row itself.
interface StoredNodeBeliefState {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  belief_evidence_for_mass: number | null;
  belief_evidence_against_mass: number | null;
}

// Read one node's full stored belief state.
function readStoredNodeBeliefState(
  context: TempBeliefDatabase,
  nodeId: number
): StoredNodeBeliefState {
  return context.sqlite
    .prepare(
      `SELECT belief_credence, belief_computed_at, belief_credence_is_fixed,
              belief_evidence_for_mass, belief_evidence_against_mass
       FROM nodes WHERE id = ?`
    )
    .get(nodeId) as StoredNodeBeliefState;
}

describe('belief engine without edge evidence (interim semantics)', () => {
  // The core interim pin: with no evidence column in the world, a non-fixed
  // node's evidence basis is empty by definition, so a recompute lands
  // never-assessed even when the node has edges pointing at graded nodes —
  // and null credence rides the normal result shape, not an error.
  it('recomputeNodeBelief of a non-fixed node with edges to graded nodes lands never-assessed', async () => {
    tempDb = await openTempBeliefDatabase();
    const derivedNodeId = tempDb.insertNodeFixture({ title: 'derived node' });
    const fixedGradedSourceNodeId = tempDb.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed graded source node',
      beliefCredence: 0.8,
    });
    // Outgoing edge to a graded node — pre-slice this was the node's whole
    // evidence basis; now it is just a relationship.
    insertEdgeCarryingLegacySupportWhereColumnExists(tempDb, {
      derivedNodeId,
      sourceNodeId: fixedGradedSourceNodeId,
      legacySupport: 0.9,
    });

    const { recomputeNodeBelief } = await tempDb.importBeliefService();
    const recomputeResult = await recomputeNodeBelief(derivedNodeId, 'mcp-recompute');

    // The rah_recompute_belief contract shape survives: null credence is a
    // real answer, with no movement and no contributions to report.
    expect(recomputeResult).toEqual({
      beliefCredence: null,
      movement: null,
      contributions: [],
    });

    // The stored row IS never-assessed: credence, timestamp and BOTH masses
    // NULL together.
    expect(readStoredNodeBeliefState(tempDb, derivedNodeId)).toEqual({
      belief_credence: null,
      belief_computed_at: null,
      belief_credence_is_fixed: 0,
      belief_evidence_for_mass: null,
      belief_evidence_against_mass: null,
    });

    // Never-assessed is not a movement: nothing was logged for the node.
    expect(tempDb.readBeliefMovements(derivedNodeId)).toEqual([]);
  });

  // The fixed survivor pin: a human-asserted credence is not derived from
  // the graph, so a recompute reports it back and writes nothing. (This is
  // already the fixed short-circuit's behaviour today and it must stay true
  // once the evidence-read path is gone.)
  it('recomputeNodeBelief keeps a fixed node\'s asserted credence untouched', async () => {
    tempDb = await openTempBeliefDatabase();
    const fixedNodeId = tempDb.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed asserted node',
      beliefCredence: 0.55,
    });
    const fixedGradedSourceNodeId = tempDb.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed graded source node',
      beliefCredence: 0.9,
    });
    insertEdgeCarryingLegacySupportWhereColumnExists(tempDb, {
      derivedNodeId: fixedNodeId,
      sourceNodeId: fixedGradedSourceNodeId,
      legacySupport: 0.9,
    });

    const { recomputeNodeBelief } = await tempDb.importBeliefService();
    const recomputeResult = await recomputeNodeBelief(fixedNodeId, 'mcp-recompute');

    expect(recomputeResult.beliefCredence).toBe(0.55);
    const storedFixedNodeBeliefState = readStoredNodeBeliefState(tempDb, fixedNodeId);
    expect(storedFixedNodeBeliefState.belief_credence).toBe(0.55);
    expect(storedFixedNodeBeliefState.belief_credence_is_fixed).toBe(1);
    expect(tempDb.readBeliefMovements(fixedNodeId)).toEqual([]);
  });

  // The un-fix pin: the door still clears the flag, but the immediate
  // regrade now finds an empty evidence basis and lands never-assessed —
  // and an ungraded outcome is never a movement (to_credence is NOT NULL),
  // so nothing is logged for the clear.
  it('clearBeliefFixedCredence clears the flag, lands never-assessed and logs no movement', async () => {
    tempDb = await openTempBeliefDatabase();
    const fixedNodeId = tempDb.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed node being un-fixed',
      beliefCredence: 0.6,
    });
    const fixedGradedSourceNodeId = tempDb.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed graded source node',
      beliefCredence: 0.9,
    });
    // Pre-slice this edge made the un-fixed node regrade to a REAL credence;
    // post-slice the regrade has nothing to read and lands never-assessed.
    insertEdgeCarryingLegacySupportWhereColumnExists(tempDb, {
      derivedNodeId: fixedNodeId,
      sourceNodeId: fixedGradedSourceNodeId,
      legacySupport: 0.9,
    });

    // Imported dynamically AFTER the temp database is open, per the
    // tempBeliefDatabase module-generation rule.
    const { clearBeliefFixedCredence } = await import('@/services/belief/beliefFixedCredence');
    const clearance = await clearBeliefFixedCredence(fixedNodeId);

    // Ungraded is the real outcome the clearance reports.
    expect(clearance).toEqual({ beliefCredence: null });

    // The flag cleared and the row is never-assessed.
    expect(readStoredNodeBeliefState(tempDb, fixedNodeId)).toEqual({
      belief_credence: null,
      belief_computed_at: null,
      belief_credence_is_fixed: 0,
      belief_evidence_for_mass: null,
      belief_evidence_against_mass: null,
    });

    // No movement row was appended for the clear: an ungraded outcome has no
    // to_credence to record.
    const movementTriggersLoggedForClearedNode = tempDb
      .readBeliefMovements(fixedNodeId)
      .map(movement => movement.trigger);
    expect(movementTriggersLoggedForClearedNode).not.toContain('belief-fixed-credence-cleared');
  });

  // The dead-propagation pin: asserting a credence still logs the assertion
  // on the asserted node itself, but the sweep to the nodes deriving from it
  // is gone — there are no evidence edges to walk — so a neighbouring node
  // stays exactly as it was.
  it('setBeliefFixedCredence no longer regrades any neighbouring node', async () => {
    tempDb = await openTempBeliefDatabase();
    const neighbouringNodeId = tempDb.insertNodeFixture({ title: 'neighbouring node' });
    const assertedSourceNodeId = tempDb.insertNodeFixture({ title: 'source node being asserted' });
    // Pre-slice this edge carried the assertion outward to the neighbouring
    // node ('propagation' regrade); post-slice it is just a relationship.
    insertEdgeCarryingLegacySupportWhereColumnExists(tempDb, {
      derivedNodeId: neighbouringNodeId,
      sourceNodeId: assertedSourceNodeId,
      legacySupport: 0.8,
    });

    // Imported dynamically AFTER the temp database is open, per the
    // tempBeliefDatabase module-generation rule.
    const { setBeliefFixedCredence } = await import('@/services/belief/beliefFixedCredence');
    const assertion = setBeliefFixedCredence(assertedSourceNodeId, 0.8);
    expect(assertion?.beliefCredence).toBe(0.8);

    // The neighbouring node is untouched: still ungraded, no movement of any
    // kind — in particular no 'propagation' movement.
    expect(readStoredNodeBeliefState(tempDb, neighbouringNodeId)).toEqual({
      belief_credence: null,
      belief_computed_at: null,
      belief_credence_is_fixed: 0,
      belief_evidence_for_mass: null,
      belief_evidence_against_mass: null,
    });
    expect(tempDb.readBeliefMovements(neighbouringNodeId)).toEqual([]);
  });
});
