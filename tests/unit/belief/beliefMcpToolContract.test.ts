/**
 * Tests for the fork-owned shared MCP belief contract
 * (src/services/belief/beliefMcpToolContract.js).
 *
 * WHY THIS MODULE EXISTS. RA-H has two app-backed MCP doors that serve the
 * same rah_* tools from two separate files: the local door
 * (apps/mcp-server/stdio-server.js) and the remote door (app/api/mcp/route.ts).
 * Every belief change the fork has made landed on the local door only, so the
 * belief surface silently drifted apart — the remote door could not write
 * evidence at all and reported a `weight` taken from the relationship-label
 * confidence, a word this fork bans. Declaring the belief pieces twice is what
 * allowed that. They are declared ONCE here and both doors use them.
 *
 * WHY IT IS COMMONJS. The local door is a CommonJS script (`require`,
 * `'use strict'`) that is spawned from source with no build step, so it can
 * only `require` a CommonJS file; the remote door is TypeScript ESM inside
 * Next and needs types. A bare `.js` here is CommonJS ONLY because the repo
 * root package.json declares no `"type"` field — if that ever gains
 * `"type": "module"`, this module breaks the local door and must become
 * `.cjs`. The companion `.d.ts` is what gives the TypeScript side its types.
 *
 * This file pins the module's own behaviour directly, with no MCP door in the
 * way. The doors' own tests pin that they use it.
 *
 * No database is involved: the module under test imports nothing but zod, so
 * the tempBeliefDatabase sentinel other belief tests arm would be misleading
 * here rather than protective.
 */

import { describe, expect, it } from 'vitest';

import {
  beliefEvidenceSupportInputSchemaForEdgeCreate,
  beliefEvidenceSupportInputSchemaForEdgeUpdate,
  beliefEvidenceFieldsForEdgeRead,
  beliefEvidenceEdgeReadOutputSchemaFields,
} from '@/services/belief/beliefMcpToolContract';

// The two write tools that share the support input schema, tested as one set
// so neither door and neither tool can quietly acquire a different range rule.
// They differ only in what their description says omission means, which is
// pinned separately below.
const supportInputSchemasBothWriteToolsUse = [
  ['rah_create_edge', beliefEvidenceSupportInputSchemaForEdgeCreate],
  ['rah_update_edge', beliefEvidenceSupportInputSchemaForEdgeUpdate],
] as const;

// Values inside the unsigned range that every support schema must accept.
// 0 and 1 are the boundaries and are the whole point: 0 is a recorded
// judgement that the evidence carries nothing, never an absence of one.
const acceptedSupportValues = [0, 0.5, 1];

// Values outside the unsigned range. Negatives are not merely out of bounds —
// support says how strongly a source talks about its neighbour, never which
// way, and credence on the source node is the only signed quantity in the
// system, so a signed support is a category error.
const rejectedOutOfRangeSupportValues = [-1, -0.5, -0.0001, 1.0001, 1.5, 2];

// Values that are not numbers at all and that BOTH write tools must refuse. A
// numeric string must not be coerced: a caller that sends "0.5" has a bug, and
// silently accepting it would let a non-number reach the belief engine.
//
// null is deliberately NOT in this list, because the two schemas differ on it.
// On an UPDATE null is a legitimate un-assessment — it takes the stored support
// back, so the edge stops being evidence at all — and is pinned as accepted in
// tests/unit/belief/beliefMcpToolContractSupportUnassessment.test.ts. On a
// CREATE there is no stored support to take back, so null says nothing that
// omission does not already say and stays refused; that half is pinned just
// below, on the create schema alone.
const rejectedNonNumberSupportValues: unknown[] = ['0.5', '', true, false, {}, [], NaN];

describe('belief_evidence_support input schema shared by both MCP doors', () => {
  for (const [toolName, supportInputSchema] of supportInputSchemasBothWriteToolsUse) {
    // The in-range acceptance both write tools must offer, boundaries included.
    it(`accepts every support in the unsigned range for ${toolName}`, () => {
      for (const acceptedSupport of acceptedSupportValues) {
        const parseOutcome = supportInputSchema.safeParse(acceptedSupport);
        expect(parseOutcome.success, `a support of ${acceptedSupport} must be accepted`).toBe(true);
        if (parseOutcome.success) {
          // Accepted verbatim: a 0 that came back as anything else would turn
          // an assessed "carries nothing" into something it is not.
          expect(parseOutcome.data).toBe(acceptedSupport);
        }
      }
    });

    // Out-of-range values must be refused by the schema, before any request
    // reaches the app.
    it(`rejects every out-of-range support for ${toolName}`, () => {
      for (const rejectedSupport of rejectedOutOfRangeSupportValues) {
        expect(
          supportInputSchema.safeParse(rejectedSupport).success,
          `a support of ${rejectedSupport} must be rejected — support is unsigned and capped at 1`
        ).toBe(false);
      }
    });

    // Non-numbers must be refused rather than coerced.
    it(`rejects every non-number support for ${toolName}`, () => {
      for (const rejectedSupport of rejectedNonNumberSupportValues) {
        expect(
          supportInputSchema.safeParse(rejectedSupport).success,
          `a support of ${JSON.stringify(rejectedSupport)} must be rejected as a non-number`
        ).toBe(false);
      }
    });

    // The field is optional on both write tools: omitting it is how a caller
    // says "this is a plain relationship edge, not evidence".
    it(`treats an omitted support as absent rather than invalid for ${toolName}`, () => {
      const parseOutcome = supportInputSchema.safeParse(undefined);
      expect(parseOutcome.success).toBe(true);
      if (parseOutcome.success) {
        expect(parseOutcome.data).toBeUndefined();
      }
    });
  }

  // The create half of the null asymmetry, asserted on the create schema alone
  // because the update schema legitimately accepts null as an un-assessment.
  // A newly created edge has no stored support to withdraw, so null there would
  // offer a caller a second spelling of omission and invite the reading that a
  // create can un-assess something.
  it('rejects null for rah_create_edge, which has no stored support to withdraw', () => {
    expect(
      beliefEvidenceSupportInputSchemaForEdgeCreate.safeParse(null).success,
      'null must stay invalid on create — omission is how a plain relationship edge is created'
    ).toBe(false);
  });

  // The two schemas share a range but must NOT share a description: omitting
  // support on a create means "this edge is not evidence", while omitting it
  // on an update means "leave the stored support alone". Collapsing them into
  // one description would tell an agent something false on one of the tools.
  it('describes what omission means differently for create and for update', () => {
    const createDescription = beliefEvidenceSupportInputSchemaForEdgeCreate.description ?? '';
    const updateDescription = beliefEvidenceSupportInputSchemaForEdgeUpdate.description ?? '';

    expect(createDescription).not.toBe('');
    expect(updateDescription).not.toBe('');
    expect(createDescription).not.toBe(updateDescription);
    expect(createDescription).toContain('plain non-evidence edge');
    expect(updateDescription).toContain('unchanged');
    // Both must still tell the agent the quantity is unsigned and where the
    // direction actually comes from.
    for (const description of [createDescription, updateDescription]) {
      expect(description).toContain('unsigned');
      expect(description).toContain('belief_credence');
    }
  });
});

describe('belief evidence fields mapper for an edge read', () => {
  // A MISSING key means the app did not report the column at all, which reads
  // as "nothing known" — null, never undefined, so the key is always present
  // in the tool's reply.
  it('maps a missing key to null for both belief fields', () => {
    const mappedBeliefFields = beliefEvidenceFieldsForEdgeRead({ id: 1 });

    expect(mappedBeliefFields).toEqual({
      belief_evidence_support: null,
      belief_evidence_contribution: null,
    });
    // Present-and-null, not absent: an absent key would drop out of JSON.
    expect(Object.keys(mappedBeliefFields)).toContain('belief_evidence_support');
    expect(Object.keys(mappedBeliefFields)).toContain('belief_evidence_contribution');
  });

  // A stored NULL stays null. On support this means the edge is not evidence
  // at all; on contribution it means the edge has never been graded.
  it('keeps a stored NULL as null for both belief fields', () => {
    expect(
      beliefEvidenceFieldsForEdgeRead({
        belief_evidence_support: null,
        belief_evidence_contribution: null,
      })
    ).toEqual({
      belief_evidence_support: null,
      belief_evidence_contribution: null,
    });
  });

  // The state the whole three-way normalisation exists for: a real 0 is a
  // recorded judgement — assessed, and carrying nothing — and must never
  // collapse into the null that means "never assessed".
  it('keeps a real 0 as 0 for both belief fields', () => {
    const mappedBeliefFields = beliefEvidenceFieldsForEdgeRead({
      belief_evidence_support: 0,
      belief_evidence_contribution: 0,
    });

    expect(mappedBeliefFields).toEqual({
      belief_evidence_support: 0,
      belief_evidence_contribution: 0,
    });
    expect(mappedBeliefFields.belief_evidence_support).not.toBeNull();
    expect(mappedBeliefFields.belief_evidence_contribution).not.toBeNull();
  });

  // Ordinary graded values pass through untouched, including a negative
  // contribution — contribution is signed because the source node's credence
  // is, which is exactly how a disbelieved source counts against its neighbour.
  it('passes graded values through verbatim, including a negative contribution', () => {
    expect(
      beliefEvidenceFieldsForEdgeRead({
        belief_evidence_support: 0.8,
        belief_evidence_contribution: -0.4,
      })
    ).toEqual({
      belief_evidence_support: 0.8,
      belief_evidence_contribution: -0.4,
    });
  });

  // The mapper reports the belief fields and nothing else, so a caller can
  // spread it into an edge read without it overwriting neighbouring columns.
  it('reports exactly the two belief fields and no others', () => {
    const mappedBeliefFields = beliefEvidenceFieldsForEdgeRead({
      id: 5,
      from_node_id: 2,
      to_node_id: 1,
      explanation: 'Reports a measured result about the neighbouring node.',
      belief_evidence_support: 0.3,
      belief_evidence_contribution: 0.15,
    });

    expect(Object.keys(mappedBeliefFields).sort()).toEqual([
      'belief_evidence_contribution',
      'belief_evidence_support',
    ]);
  });
});

describe('belief evidence output-schema fields for an edge read', () => {
  // The fragment must declare exactly the two belief columns, so a door can
  // spread it into its edge output schema and advertise both.
  it('declares exactly the two belief columns', () => {
    expect(Object.keys(beliefEvidenceEdgeReadOutputSchemaFields).sort()).toEqual([
      'belief_evidence_contribution',
      'belief_evidence_support',
    ]);
  });

  // Each declared field must accept the states the mapper can produce —
  // a number including 0, and null — or a door would advertise a schema its
  // own replies violate.
  it('accepts every state the mapper can produce, and rejects a non-number', () => {
    // Named explicitly rather than enumerated, so each field's schema keeps
    // its declared type instead of being widened by a lookup.
    const declaredBeliefFieldSchemas = [
      ['belief_evidence_support', beliefEvidenceEdgeReadOutputSchemaFields.belief_evidence_support],
      [
        'belief_evidence_contribution',
        beliefEvidenceEdgeReadOutputSchemaFields.belief_evidence_contribution,
      ],
    ] as const;

    for (const [fieldName, fieldSchema] of declaredBeliefFieldSchemas) {
      expect(fieldSchema.safeParse(0).success, `${fieldName} must accept 0`).toBe(true);
      expect(fieldSchema.safeParse(0.75).success, `${fieldName} must accept a number`).toBe(true);
      expect(fieldSchema.safeParse(-0.4).success, `${fieldName} must accept a negative`).toBe(true);
      expect(fieldSchema.safeParse(null).success, `${fieldName} must accept null`).toBe(true);
      expect(fieldSchema.safeParse('0').success, `${fieldName} must reject a string`).toBe(false);
    }
  });
});
