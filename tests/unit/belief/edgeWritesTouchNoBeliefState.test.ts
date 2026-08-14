/**
 * FAILING-FIRST tests for the evidence-leaves-the-edges-table slice, service
 * level (src/services/database/edges.ts): AN EDGE WRITE TOUCHES NO BELIEF
 * STATE, EVER.
 *
 * Belief evidence moved out of this fork into samai's own store, so
 * EdgeService loses every belief hook: no support validation, no contribution
 * stamping, no regrade on create, update or delete. This file pins:
 *
 *  - createEdge from a LEGACY caller still passing belief_evidence_support is
 *    not an error — the key is simply not part of the contract any more: no
 *    belief column changes on any node, no belief_movements row appears, and
 *    the answer row carries neither evidence field,
 *  - deleting that same edge also touches no belief state,
 *  - a plain createEdge's answer row carries neither evidence field,
 *  - an explanation-only updateEdge touches no belief state and answers a row
 *    without either evidence field.
 *
 * The belief snapshot is the WHOLE surviving belief surface: every node's
 * belief_credence, belief_computed_at, belief_credence_is_fixed and both
 * evidence masses, plus every belief_movements row — compared before/after
 * each write, so "no belief read or write" is pinned structurally rather
 * than one column at a time.
 *
 * All edges are created with skip_inference: true and explicit explanations
 * so no LLM path is ever exercised. Runs against a fresh temp-file database
 * per test (see tempBeliefDatabase.ts for the safety seam).
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Edge, EdgeData } from '@/types/database';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// The two evidence fields that must never appear on an edge answer again.
const removedEdgeEvidenceFieldNames = [
  'belief_evidence_support',
  'belief_evidence_contribution',
];

// The database context under test; opened per test, closed after each.
let tempDb: TempBeliefDatabase | undefined;

afterEach(() => {
  tempDb?.close();
  tempDb = undefined;
});

// One node's entire surviving belief surface, snapshotted whole so any belief
// write at all — credence, timestamp, flag or either mass — breaks equality.
interface NodeBeliefSnapshotRow {
  id: number;
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  belief_evidence_for_mass: number | null;
  belief_evidence_against_mass: number | null;
}

// Every node's belief columns plus every movement row: the full belief state
// an edge write must leave byte-untouched.
interface BeliefStateSnapshot {
  nodeBeliefRows: NodeBeliefSnapshotRow[];
  beliefMovementRows: unknown[];
}

// Snapshot the whole database's belief state through the open client.
function snapshotBeliefState(context: TempBeliefDatabase): BeliefStateSnapshot {
  const nodeBeliefRows = context.sqlite
    .prepare(
      `SELECT id, belief_credence, belief_computed_at, belief_credence_is_fixed,
              belief_evidence_for_mass, belief_evidence_against_mass
       FROM nodes ORDER BY id ASC`
    )
    .all() as NodeBeliefSnapshotRow[];
  const beliefMovementRows = context.sqlite
    .prepare('SELECT * FROM belief_movements ORDER BY id ASC')
    .all();
  return { nodeBeliefRows, beliefMovementRows };
}

// Assert an edge answer object carries NEITHER evidence field — not even as
// an explicit null key: the fields left the contract, they did not go blank.
function expectAnswerCarriesNoEvidenceFields(edgeAnswer: object): void {
  for (const removedFieldName of removedEdgeEvidenceFieldNames) {
    expect(
      Object.prototype.hasOwnProperty.call(edgeAnswer, removedFieldName),
      `edge answer must not carry ${removedFieldName}`
    ).toBe(false);
  }
}

// An EdgeData as a LEGACY caller would still build it: the evidence field is
// no longer part of EdgeData, so it rides as an extra property. The
// intersection stays assignable to EdgeData, which is exactly the point —
// such a call must be tolerated, and must mean nothing.
type LegacyEvidenceCarryingEdgeInput = EdgeData & { belief_evidence_support: number };

describe('edge writes touch no belief state (post-slice EdgeService)', () => {
  // The legacy-caller pin, on both create and delete. The fixture graph is
  // the exact shape that USED to trigger a regrade — a derived node pointing
  // at a fixed graded source — so any surviving hook shows up as a changed
  // snapshot.
  it('createEdge and deleteEdge from a legacy caller still sending belief_evidence_support touch no belief state', async () => {
    tempDb = await openTempBeliefDatabase();
    const derivedNodeId = tempDb.insertNodeFixture({ title: 'derived node' });
    const fixedSourceNodeId = tempDb.insertFixedBeliefCredenceNodeFixture({
      title: 'fixed graded source node',
      beliefCredence: 0.8,
    });
    const { edgeService } = await tempDb.importEdgeService();

    const beliefStateBeforeAnyEdgeWrite = snapshotBeliefState(tempDb);

    // The legacy caller's input: pre-slice this was gradeable evidence and
    // createEdge regraded the derived end; now the key means nothing.
    const legacyEvidenceCarryingInput: LegacyEvidenceCarryingEdgeInput = {
      from_node_id: derivedNodeId,
      to_node_id: fixedSourceNodeId,
      explanation: 'legacy caller fixture edge toward the fixed source node',
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
      belief_evidence_support: 0.9,
    };
    const createdEdgeAnswer = await edgeService.createEdge(legacyEvidenceCarryingInput);

    // No belief write of any kind happened: every node's belief columns and
    // the whole movement table are byte-identical to before the create.
    expect(snapshotBeliefState(tempDb)).toEqual(beliefStateBeforeAnyEdgeWrite);

    // The answer row carries neither evidence field, and neither does the
    // stored row itself (the answer IS the re-read stored row).
    expectAnswerCarriesNoEvidenceFields(createdEdgeAnswer);

    // Deleting the edge is also not a belief event.
    await edgeService.deleteEdge(createdEdgeAnswer.id);
    expect(snapshotBeliefState(tempDb)).toEqual(beliefStateBeforeAnyEdgeWrite);
  });

  // The plain-create pin: even an ordinary relationship edge's answer must
  // not mention the departed evidence fields.
  it('a plain createEdge answers a row without either evidence field and touches no belief state', async () => {
    tempDb = await openTempBeliefDatabase();
    const firstPlainNodeId = tempDb.insertNodeFixture({ title: 'first plain node' });
    const secondPlainNodeId = tempDb.insertNodeFixture({ title: 'second plain node' });
    const { edgeService } = await tempDb.importEdgeService();

    const beliefStateBeforePlainCreate = snapshotBeliefState(tempDb);

    const plainEdgeAnswer = await edgeService.createEdge({
      from_node_id: firstPlainNodeId,
      to_node_id: secondPlainNodeId,
      explanation: 'plain relationship fixture edge',
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
    });

    expectAnswerCarriesNoEvidenceFields(plainEdgeAnswer);
    expect(snapshotBeliefState(tempDb)).toEqual(beliefStateBeforePlainCreate);
  });

  // The update pin: correcting an explanation is the one edge update that
  // remains, and it neither reads nor writes belief state, and its answer
  // row carries neither evidence field.
  it('an explanation-only updateEdge touches no belief state and answers a row without either evidence field', async () => {
    tempDb = await openTempBeliefDatabase();
    const firstPlainNodeId = tempDb.insertNodeFixture({ title: 'first plain node' });
    const secondPlainNodeId = tempDb.insertNodeFixture({ title: 'second plain node' });
    const { edgeService } = await tempDb.importEdgeService();

    const existingPlainEdge = await edgeService.createEdge({
      from_node_id: firstPlainNodeId,
      to_node_id: secondPlainNodeId,
      explanation: 'plain relationship fixture edge before correction',
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
    });

    const beliefStateBeforeExplanationUpdate = snapshotBeliefState(tempDb);

    // Top-level explanation write: validated and stored without any context
    // re-inference, so no LLM path runs. Declared as an intersection with
    // Partial<Edge> because updateEdge reads the top-level explanation key
    // explicitly even though the Edge row type does not declare it.
    const explanationOnlyUpdate: Partial<Edge> & { explanation: string } = {
      explanation: 'plain relationship fixture edge after correction',
    };
    const updatedEdgeAnswer = await edgeService.updateEdge(
      existingPlainEdge.id,
      explanationOnlyUpdate
    );

    expectAnswerCarriesNoEvidenceFields(updatedEdgeAnswer);
    expect(snapshotBeliefState(tempDb)).toEqual(beliefStateBeforeExplanationUpdate);
  });
});
