/**
 * UN-ASSESSMENT through the shared MCP belief contract
 * (src/services/belief/beliefMcpToolContract.js).
 *
 * WHY THIS FILE EXISTS. Setting belief_evidence_support back to NULL returns a
 * graded evidence edge to a plain relationship: the edge stops being evidence
 * at all, its belief_evidence_contribution is cleared and the target node is
 * regraded from whatever evidence is left. edgeService.updateEdge and
 * PUT /api/edges/[id] both accept that write and are already tested for it.
 * The one thing that makes it unreachable from an MCP client is this module:
 * beliefEvidenceSupportInputSchemaForEdgeUpdate is `.optional()` but not
 * `.nullable()`, so BOTH doors reject `belief_evidence_support: null` at the
 * schema before the app is ever asked. A downstream agent can therefore raise
 * and lower a support forever but can never take one back.
 *
 * The asymmetry pinned here is deliberate, not an oversight to be tidied up.
 * On an UPDATE there are three distinct states a caller must be able to
 * express — null (un-assess: not evidence any more), omitted (leave the stored
 * support exactly as it is) and 0 (assessed, carries nothing). On a CREATE
 * there is no stored value to take back, so null would mean nothing that
 * omission does not already mean, and the create schema must keep refusing it.
 *
 * No database is involved: the module under test imports nothing but zod, so
 * the tempBeliefDatabase sentinel other belief tests arm would be misleading
 * here rather than protective. Companion file:
 * tests/unit/belief/beliefMcpToolContract.test.ts pins the rest of the module.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  beliefEvidenceSupportInputSchemaForEdgeCreate,
  beliefEvidenceSupportInputSchemaForEdgeUpdate,
} from '@/services/belief/beliefMcpToolContract';

// Supports the update schema must keep accepting alongside null. The
// boundaries carry meaning: 0 is an assessed "carries nothing", 1 is the
// strongest a source can talk about its neighbour.
const acceptedUpdateSupportValues = [0, 0.25, 0.5, 1];

// Values the update schema must keep REFUSING even once null is allowed.
// Widening one hole must not widen the others: a numeric string means the
// caller has a bug, and NaN bound to a REAL column becomes NULL, which would
// un-assess an edge by accident rather than by intent.
const rejectedUpdateSupportValues: unknown[] = [-0.1, -1, 1.1, 1.5, NaN, '0.5', '', true, false];

/**
 * TYPE-LEVEL PIN for the hand-written companion declaration file
 * (src/services/belief/beliefMcpToolContract.d.ts). The module is CommonJS and
 * its types are declared by hand, so a runtime widening that the .d.ts does not
 * follow leaves the TypeScript remote door unable to pass the very null this
 * change exists to allow — and no runtime test can see that. This binding fails
 * `npm run type-check` until the declaration is widened to match.
 */
const unassessingBeliefSupportInput: z.input<
  typeof beliefEvidenceSupportInputSchemaForEdgeUpdate
> = null;

describe('rah_update_edge belief_evidence_support accepts an un-assessment', () => {
  // The whole point of the change: without this, an edge graded by mistake is
  // permanently evidence as far as every MCP client is concerned — the support
  // can be corrected downwards but never withdrawn.
  it('accepts null and returns it verbatim as null', () => {
    const parseOutcome = beliefEvidenceSupportInputSchemaForEdgeUpdate.safeParse(null);

    expect(parseOutcome.success, 'null must be accepted as an un-assessment').toBe(true);
    if (parseOutcome.success) {
      // Verbatim null, not coerced to undefined: undefined would reach the app
      // as "no support supplied" and silently leave the edge graded.
      expect(parseOutcome.data).toBeNull();
    }
  });

  // The type-level pin above must correspond to something real at runtime, and
  // stating it as a value keeps the declaration file honest even if a future
  // reader deletes the type binding without understanding it.
  it('accepts the null carried by its own declared input type', () => {
    expect(
      beliefEvidenceSupportInputSchemaForEdgeUpdate.safeParse(unassessingBeliefSupportInput).success
    ).toBe(true);
  });

  // Omission is a THIRD state, not a synonym for null: it says leave the stored
  // support exactly as it is. A support-only correction and an explanation-only
  // correction travel through the same tool, so collapsing the two would make
  // every explanation edit silently un-assess its edge.
  it('keeps an omitted support distinct from null', () => {
    const omittedParseOutcome = beliefEvidenceSupportInputSchemaForEdgeUpdate.safeParse(undefined);

    expect(omittedParseOutcome.success).toBe(true);
    if (omittedParseOutcome.success) {
      expect(omittedParseOutcome.data).toBeUndefined();
      expect(omittedParseOutcome.data).not.toBeNull();
    }
  });

  // Widening to nullable must not disturb the numbers already accepted; 0 in
  // particular is a recorded judgement and must survive as 0, never collapsing
  // into the null that means "never assessed".
  it('still accepts every in-range number, with 0 staying 0', () => {
    for (const acceptedSupport of acceptedUpdateSupportValues) {
      const parseOutcome =
        beliefEvidenceSupportInputSchemaForEdgeUpdate.safeParse(acceptedSupport);

      expect(parseOutcome.success, `a support of ${acceptedSupport} must be accepted`).toBe(true);
      if (parseOutcome.success) {
        expect(parseOutcome.data).toBe(acceptedSupport);
      }
    }
  });

  // GUARD: nullable must widen exactly one hole. An out-of-range or non-number
  // support that slipped through would be written straight to a REAL column.
  it('GUARD: still rejects every out-of-range and non-number support', () => {
    for (const rejectedSupport of rejectedUpdateSupportValues) {
      expect(
        beliefEvidenceSupportInputSchemaForEdgeUpdate.safeParse(rejectedSupport).success,
        `a support of ${JSON.stringify(rejectedSupport) ?? String(rejectedSupport)} must still be rejected`
      ).toBe(false);
    }
  });
});

describe('rah_create_edge belief_evidence_support refuses an un-assessment', () => {
  // The deliberate asymmetry. On a create there is no stored support to take
  // back, so accepting null would offer a caller two spellings of the same
  // thing and invite the reading that a created edge can be "un-assessed".
  // Pinned so nobody later makes the two schemas symmetric for tidiness.
  it('rejects null, because a new edge has no stored support to withdraw', () => {
    expect(
      beliefEvidenceSupportInputSchemaForEdgeCreate.safeParse(null).success,
      'null must stay invalid on create — omission is how a plain relationship edge is created'
    ).toBe(false);
  });

  // GUARD: omission remains the create-side way to say "not evidence", so the
  // rejection above leaves the caller with a way to express the same intent.
  it('GUARD: still accepts an omitted support on create', () => {
    expect(beliefEvidenceSupportInputSchemaForEdgeCreate.safeParse(undefined).success).toBe(true);
  });
});

describe('the two support descriptions tell an agent apart the three states', () => {
  // The description IS the contract for an LLM caller: it is the only place an
  // agent learns that null exists and what it does. A widened schema with an
  // unchanged description is a feature no caller can discover.
  //
  // The assertions match on tokens that survive rewording rather than on
  // sentences: `null` is the literal value the caller must actually send, so it
  // cannot be worded away, and the alternation below covers the ways of saying
  // "this edge stops being evidence" without pinning any one of them.
  it('names null and what it does on the update description', () => {
    const updateSupportDescription = beliefEvidenceSupportInputSchemaForEdgeUpdate.description ?? '';

    expect(updateSupportDescription).not.toBe('');
    expect(updateSupportDescription, 'the update description must name null itself').toMatch(
      /null/i
    );
    expect(
      updateSupportDescription,
      'the update description must say null means the edge stops being evidence'
    ).toMatch(/un-?assess|no longer evidence|not evidence/i);
  });

  // Three states, three meanings. An agent that cannot tell them apart will
  // either wipe a support it meant to leave alone, or send 0 when it meant to
  // withdraw the assessment entirely.
  it('distinguishes null from omission and from a support of 0', () => {
    const updateSupportDescription = beliefEvidenceSupportInputSchemaForEdgeUpdate.description ?? '';

    // Omission: the stored support survives the write untouched.
    expect(updateSupportDescription).toContain('unchanged');
    // Zero: assessed and carrying nothing, a recorded judgement.
    expect(updateSupportDescription).toMatch(/\b0\b/);
  });

  // GUARD: the create description must NOT offer null, or an agent would send
  // it to a schema that refuses it and be unable to tell why.
  it('GUARD: the create description never offers null', () => {
    const createSupportDescription = beliefEvidenceSupportInputSchemaForEdgeCreate.description ?? '';

    expect(createSupportDescription).not.toBe('');
    expect(createSupportDescription).not.toMatch(/null/i);
    expect(createSupportDescription).toContain('plain non-evidence edge');
  });

  // GUARD: the two descriptions stay separate. They differ precisely because
  // omission means different things on the two tools.
  it('GUARD: the create and update descriptions remain different texts', () => {
    expect(beliefEvidenceSupportInputSchemaForEdgeCreate.description).not.toBe(
      beliefEvidenceSupportInputSchemaForEdgeUpdate.description
    );
  });
});
