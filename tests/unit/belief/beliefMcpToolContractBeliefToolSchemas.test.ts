/**
 * Tests for the input and output schemas of the THREE new belief tools the
 * shared MCP tool contract (src/services/belief/beliefMcpToolContract.js) must
 * grow, so both app-backed doors can register them from one declaration:
 *
 *  - rah_set_belief_fixed_credence — assert one node's credence by hand,
 *  - rah_get_belief_movements — read the log of a node's credence changing,
 *  - rah_recompute_node_belief — ask the app's belief engine to regrade a node.
 *
 * The set tool mirrors the standalone door's setBeliefFixedCredence semantics
 * (apps/mcp-server-standalone/index.js): credence lives in the OPEN interval
 * (-1, +1) — total certainty either way is not expressible, so both endpoints
 * are rejected while 0, assessed and torn, is accepted. The standalone door is
 * a schema-semantics REFERENCE only; it never grades and gains no tools here.
 *
 * As with the edge-read pieces already in the contract, declaring these once
 * is what makes cross-door agreement structural instead of maintained. This
 * file pins the schemas' own behaviour with no MCP door in the way; the doors'
 * tests pin that they use them. No database is involved — the module imports
 * nothing but zod.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// The whole contract module as a namespace, so the exports this file drives
// can be reached without the .d.ts declaring them yet — the missing exports
// are the red this file exists to create.
import * as beliefMcpToolContract from '@/services/belief/beliefMcpToolContract';

// One bag of named zod field schemas, as a door spreads into a tool's
// inputSchema/outputSchema registration.
type BeliefToolSchemaFields = Record<string, z.ZodTypeAny>;

// The six new schema-field exports under test, typed locally because the
// contract does not export them yet — that missing surface is the red.
const {
  beliefSetFixedCredenceInputSchemaFields,
  beliefSetFixedCredenceOutputSchemaFields,
  beliefMovementsReadInputSchemaFields,
  beliefMovementsReadOutputSchemaFields,
  beliefRecomputeInputSchemaFields,
  beliefRecomputeOutputSchemaFields,
} = beliefMcpToolContract as unknown as {
  beliefSetFixedCredenceInputSchemaFields: BeliefToolSchemaFields;
  beliefSetFixedCredenceOutputSchemaFields: BeliefToolSchemaFields;
  beliefMovementsReadInputSchemaFields: BeliefToolSchemaFields;
  beliefMovementsReadOutputSchemaFields: BeliefToolSchemaFields;
  beliefRecomputeInputSchemaFields: BeliefToolSchemaFields;
  beliefRecomputeOutputSchemaFields: BeliefToolSchemaFields;
};

// Credences inside the open interval every set call must accept. 0 is the
// deliberate boundary of meaning: assessed, and believed neither way.
const acceptedFixedCredenceValues = [0, 0.5, -0.5, 0.999, -0.999];

// Credences at or beyond the endpoints, all refused: ±1 would claim total
// certainty, which the model deliberately cannot express.
const rejectedOutOfIntervalCredenceValues = [1, -1, 1.0001, -1.0001, 1.5, -2];

// Values that are not numbers at all. A numeric string must not be coerced —
// a caller that sends '0.5' has a bug, and silently accepting it would let a
// non-number reach the belief engine. null is refused too: unlike an edge's
// support on update, an asserted credence has no un-assess spelling here.
const rejectedNonNumberCredenceValues: unknown[] = ['0.5', '', null, true, false, {}, [], NaN];

// node_id values every belief tool must accept / refuse: node ids are
// positive integers, so zero, negatives, fractions and strings are all
// schema-level refusals that must never reach the app.
const acceptedNodeIdValues = [1, 7, 100000];
const rejectedNodeIdValues: unknown[] = [0, -3, 2.5, '7', null, true, {}];

// The three tools' node_id schemas, tested as one set: the same identifier
// rule must hold at every belief tool, or an agent that learned it once would
// be misled at the next tool.
const nodeIdSchemasAllBeliefToolsShare = [
  ['rah_set_belief_fixed_credence', () => beliefSetFixedCredenceInputSchemaFields.node_id],
  ['rah_get_belief_movements', () => beliefMovementsReadInputSchemaFields.node_id],
  ['rah_recompute_node_belief', () => beliefRecomputeInputSchemaFields.node_id],
] as const;

// One well-formed movement entry as the movements read must report it — the
// belief_movements columns by their exact names.
const wellFormedMovementEntry = {
  id: 3,
  node_id: 9,
  from_credence: null,
  to_credence: 0.4,
  trigger: 'belief-fixed-credence-set',
  occurred_at: '2026-07-30T10:00:00.000Z',
};

describe('rah_set_belief_fixed_credence input schema', () => {
  // The open interval, accepted verbatim: an asserted credence is stored as
  // the literal number the human asserted.
  it('accepts every credence strictly inside (-1, +1), including 0', () => {
    for (const acceptedCredence of acceptedFixedCredenceValues) {
      const parseOutcome =
        beliefSetFixedCredenceInputSchemaFields.belief_credence.safeParse(acceptedCredence);
      expect(parseOutcome.success, `a credence of ${acceptedCredence} must be accepted`).toBe(true);
      if (parseOutcome.success) {
        expect(parseOutcome.data).toBe(acceptedCredence);
      }
    }
  });

  // The endpoints and beyond are refused — matching the standalone door's
  // schema semantics, where total certainty is not expressible.
  it('rejects -1 and +1 and everything beyond them', () => {
    for (const rejectedCredence of rejectedOutOfIntervalCredenceValues) {
      expect(
        beliefSetFixedCredenceInputSchemaFields.belief_credence.safeParse(rejectedCredence).success,
        `a credence of ${rejectedCredence} must be rejected — the interval is open`
      ).toBe(false);
    }
  });

  // Non-numbers are refused rather than coerced, and the field is REQUIRED:
  // a set call with no credence asserts nothing and must not parse.
  it('rejects every non-number credence and an omitted credence', () => {
    for (const rejectedCredence of rejectedNonNumberCredenceValues) {
      expect(
        beliefSetFixedCredenceInputSchemaFields.belief_credence.safeParse(rejectedCredence).success,
        `a credence of ${JSON.stringify(rejectedCredence)} must be rejected as a non-number`
      ).toBe(false);
    }
    expect(
      beliefSetFixedCredenceInputSchemaFields.belief_credence.safeParse(undefined).success,
      'an omitted credence must be rejected — the field is required'
    ).toBe(false);
  });

  // The field descriptions are what an external agent reads; each must exist
  // and speak the fork's one word for the quantity.
  it('describes belief_credence in the vocabulary, naming credence', () => {
    const beliefCredenceDescription =
      beliefSetFixedCredenceInputSchemaFields.belief_credence.description ?? '';
    expect(beliefCredenceDescription).not.toBe('');
    expect(beliefCredenceDescription.toLowerCase()).toContain('credence');
  });
});

describe('node_id input schema shared by all three belief tools', () => {
  for (const [beliefToolName, getNodeIdSchema] of nodeIdSchemasAllBeliefToolsShare) {
    // Node ids are positive integers everywhere in RA-H; the belief tools
    // refuse anything else at the schema, before a request reaches the app.
    it(`accepts positive integers and rejects everything else for ${beliefToolName}`, () => {
      const nodeIdSchema = getNodeIdSchema();
      for (const acceptedNodeId of acceptedNodeIdValues) {
        expect(
          nodeIdSchema.safeParse(acceptedNodeId).success,
          `a node_id of ${acceptedNodeId} must be accepted`
        ).toBe(true);
      }
      for (const rejectedNodeId of rejectedNodeIdValues) {
        expect(
          nodeIdSchema.safeParse(rejectedNodeId).success,
          `a node_id of ${JSON.stringify(rejectedNodeId)} must be rejected`
        ).toBe(false);
      }
      expect(
        nodeIdSchema.safeParse(undefined).success,
        'an omitted node_id must be rejected — every belief tool needs its node'
      ).toBe(false);
    });
  }
});

describe('rah_get_belief_movements limit input schema', () => {
  // The page size is optional (a reasonable default applies), integer, and
  // capped at 100 — an unbounded movement read is how a long-lived node would
  // flood an agent's context.
  it('accepts an omitted limit and every integer from 1 to 100', () => {
    expect(beliefMovementsReadInputSchemaFields.limit.safeParse(undefined).success).toBe(true);
    for (const acceptedLimit of [1, 50, 100]) {
      expect(
        beliefMovementsReadInputSchemaFields.limit.safeParse(acceptedLimit).success,
        `a limit of ${acceptedLimit} must be accepted`
      ).toBe(true);
    }
  });

  // Everything outside 1..100, and every non-integer, is a schema refusal.
  it('rejects 0, negatives, values over 100, fractions and strings', () => {
    for (const rejectedLimit of [0, -5, 101, 250, 2.5, '10'] as const) {
      expect(
        beliefMovementsReadInputSchemaFields.limit.safeParse(rejectedLimit).success,
        `a limit of ${JSON.stringify(rejectedLimit)} must be rejected`
      ).toBe(false);
    }
  });
});

describe('rah_get_belief_movements output schema', () => {
  // The whole reply as a door would validate it: a count plus the movement
  // entries under their exact column names, newest first (the ORDER is pinned
  // behaviourally in the app-route and door tests; the SHAPE is pinned here).
  it('accepts a reply whose movements carry the exact belief_movements columns', () => {
    const movementsReadOutputSchema = z.object(
      beliefMovementsReadOutputSchemaFields as z.ZodRawShape
    );

    const parseOutcome = movementsReadOutputSchema.safeParse({
      count: 1,
      movements: [wellFormedMovementEntry],
    });
    expect(parseOutcome.success, 'a well-formed movements reply must be accepted').toBe(true);
  });

  // An empty log is a success state, not an error: a node whose credence has
  // never changed simply has no movements yet.
  it('accepts an empty movement log', () => {
    const movementsReadOutputSchema = z.object(
      beliefMovementsReadOutputSchemaFields as z.ZodRawShape
    );

    expect(movementsReadOutputSchema.safeParse({ count: 0, movements: [] }).success).toBe(true);
  });

  // from_credence records the credence BEFORE the change and is null exactly
  // when the node was previously ungraded; to_credence records the credence
  // AFTER and always exists — a movement to nowhere is not a movement.
  it('accepts a null from_credence but rejects a null or missing to_credence', () => {
    const movementsReadOutputSchema = z.object(
      beliefMovementsReadOutputSchemaFields as z.ZodRawShape
    );

    expect(
      movementsReadOutputSchema.safeParse({
        count: 1,
        movements: [{ ...wellFormedMovementEntry, from_credence: -0.2 }],
      }).success,
      'a numeric from_credence must be accepted'
    ).toBe(true);
    expect(
      movementsReadOutputSchema.safeParse({
        count: 1,
        movements: [{ ...wellFormedMovementEntry, to_credence: null }],
      }).success,
      'a null to_credence must be rejected'
    ).toBe(false);
    const movementEntryMissingToCredence: Record<string, unknown> = { ...wellFormedMovementEntry };
    delete movementEntryMissingToCredence.to_credence;
    expect(
      movementsReadOutputSchema.safeParse({
        count: 1,
        movements: [movementEntryMissingToCredence],
      }).success,
      'a movement without to_credence must be rejected'
    ).toBe(false);
  });
});

describe('rah_set_belief_fixed_credence output schema', () => {
  // The reply mirrors the standalone door's shape, field for field.
  it('accepts the standalone-shaped success reply', () => {
    const setFixedCredenceOutputSchema = z.object(
      beliefSetFixedCredenceOutputSchemaFields as z.ZodRawShape
    );

    expect(
      setFixedCredenceOutputSchema.safeParse({
        success: true,
        node_id: 9,
        belief_credence: 0.7,
        belief_credence_is_fixed: 1,
        belief_computed_at: '2026-07-30T10:00:00.000Z',
        message: 'Asserted belief_credence 0.7 on node #9.',
      }).success
    ).toBe(true);
  });

  // A successful set ALWAYS leaves the node fixed — the flag in the reply can
  // only ever be 1, so 0 there would mean the tool wrote something it did not.
  it('rejects a fixed flag of 0 in the reply', () => {
    const setFixedCredenceOutputSchema = z.object(
      beliefSetFixedCredenceOutputSchemaFields as z.ZodRawShape
    );

    expect(
      setFixedCredenceOutputSchema.safeParse({
        success: true,
        node_id: 9,
        belief_credence: 0.7,
        belief_credence_is_fixed: 0,
        belief_computed_at: '2026-07-30T10:00:00.000Z',
        message: 'Asserted belief_credence 0.7 on node #9.',
      }).success,
      'a set reply must always carry belief_credence_is_fixed: 1'
    ).toBe(false);
  });
});

describe('rah_recompute_node_belief output schema', () => {
  // The recompute reply carries the regraded credence — and null is a REAL
  // outcome, not an error: a node with no counted evidence is ungraded.
  it('accepts a graded reply and an ungraded (null credence) reply alike', () => {
    const recomputeOutputSchema = z.object(beliefRecomputeOutputSchemaFields as z.ZodRawShape);

    expect(
      recomputeOutputSchema.safeParse({
        success: true,
        node_id: 9,
        belief_credence: 0.44,
        message: 'Recomputed belief for node #9.',
      }).success,
      'a graded recompute reply must be accepted'
    ).toBe(true);
    expect(
      recomputeOutputSchema.safeParse({
        success: true,
        node_id: 9,
        belief_credence: null,
        message: 'Node #9 has no counted evidence and stays ungraded.',
      }).success,
      'an ungraded (null credence) recompute reply must be accepted — null is a real state'
    ).toBe(true);
  });

  // A numeric string is a non-number wherever credence travels.
  it('rejects a string credence in the reply', () => {
    const recomputeOutputSchema = z.object(beliefRecomputeOutputSchemaFields as z.ZodRawShape);

    expect(
      recomputeOutputSchema.safeParse({
        success: true,
        node_id: 9,
        belief_credence: '0.44',
        message: 'Recomputed belief for node #9.',
      }).success
    ).toBe(false);
  });
});

describe('belief vocabulary in the new tool schemas', () => {
  // Every description an agent reads must speak the vocabulary: trust,
  // standing, score and weight are banned as synonyms for credence anywhere
  // in belief code, comments or tool descriptions.
  it('uses no banned synonym for credence in any new field description', () => {
    // All six new schema-field bags, flattened to their per-field descriptions.
    const allNewBeliefSchemaFieldBags: BeliefToolSchemaFields[] = [
      beliefSetFixedCredenceInputSchemaFields,
      beliefSetFixedCredenceOutputSchemaFields,
      beliefMovementsReadInputSchemaFields,
      beliefMovementsReadOutputSchemaFields,
      beliefRecomputeInputSchemaFields,
      beliefRecomputeOutputSchemaFields,
    ];
    // The banned synonyms, checked case-insensitively against every
    // description string the schemas carry.
    const bannedCredenceSynonyms = ['trust', 'standing', 'score', 'weight'];

    for (const schemaFieldBag of allNewBeliefSchemaFieldBags) {
      for (const [fieldName, fieldSchema] of Object.entries(schemaFieldBag)) {
        const fieldDescription = (fieldSchema.description ?? '').toLowerCase();
        for (const bannedSynonym of bannedCredenceSynonyms) {
          expect(
            fieldDescription,
            `the description of ${fieldName} must not say "${bannedSynonym}"`
          ).not.toContain(bannedSynonym);
        }
      }
    }
  });
});
