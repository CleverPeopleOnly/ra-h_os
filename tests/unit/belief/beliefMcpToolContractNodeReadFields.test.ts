/**
 * Tests for the NODE-read belief pieces the shared MCP tool contract
 * (src/services/belief/beliefMcpToolContract.js) must grow: a mapper and an
 * output-schema fragment for the three belief columns of one node, exactly the
 * way beliefEvidenceFieldsForEdgeRead / beliefEvidenceEdgeReadOutputSchemaFields
 * already serve the edge read.
 *
 * WHY IN THE CONTRACT. rah_get_nodes is served by two app-backed doors
 * (apps/mcp-server/stdio-server.js and app/api/mcp/route.ts). The edge-read
 * belief surface only stopped drifting between them when its mapper and schema
 * moved into this one shared module, so the node-read belief surface starts
 * there and never gets a chance to drift at all.
 *
 * THE THREE COLUMNS, per the fork's naming rule (exact column names):
 *  - belief_credence — how much we believe the node; the ONLY signed quantity
 *    in the system. NULL means nobody has grounded the node — a real state
 *    that must never collapse into 0, and 0 (assessed and believed neither
 *    way) must never collapse into null.
 *  - belief_computed_at — when that credence was stamped; NULL when ungraded.
 *  - belief_credence_is_fixed — 0/1 flag: 1 says a human asserted the credence
 *    by hand instead of the engine deriving it. The column is NOT NULL DEFAULT
 *    0, so unlike the other two it has no null state: a node the app never
 *    flagged is an ordinary derived-credence node, i.e. 0.
 *
 * This file pins the module's own behaviour directly, with no MCP door in the
 * way; the doors' own tests pin that they use it. No database is involved:
 * the module under test imports nothing but zod, so the tempBeliefDatabase
 * sentinel other belief tests arm would be misleading here.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

// The whole contract module as a namespace, so the exports this file drives
// can be reached without the .d.ts declaring them yet — the missing
// declarations (and the missing exports behind them) are exactly the red this
// file exists to create.
import * as beliefMcpToolContract from '@/services/belief/beliefMcpToolContract';

// The belief fields of one node as a node-read tool must report them —
// EDITED per belief model v2 §2/§6: belief_uncertainty (derived on read from
// the evidence masses) joins the three stored columns.
type BeliefNodeReadFields = {
  belief_credence: number | null;
  belief_computed_at: string | null;
  belief_credence_is_fixed: number;
  belief_uncertainty: number | null;
};

// The two new exports under test, typed locally because the contract does not
// export them yet — that missing surface is the red this file drives.
const { beliefFieldsForNodeRead, beliefNodeReadOutputSchemaFields } =
  beliefMcpToolContract as unknown as {
    // Normalise one node row's belief columns for a node read.
    beliefFieldsForNodeRead: (nodeRow: Record<string, unknown>) => BeliefNodeReadFields;
    // The output-schema fragment declaring those same three belief columns,
    // for a door to spread into the per-node object of its node-read schema.
    beliefNodeReadOutputSchemaFields: {
      belief_credence: z.ZodTypeAny;
      belief_computed_at: z.ZodTypeAny;
      belief_credence_is_fixed: z.ZodTypeAny;
    };
  };

// A timestamp fixture in the ISO shape the app stamps belief_computed_at with.
const GRADED_BELIEF_COMPUTED_AT = '2026-07-28T09:00:00.000Z';

describe('belief fields mapper for a node read', () => {
  // A node row the app reported without any belief keys at all reads as an
  // ordinary ungraded node: credence and timestamp are "nothing known" (null,
  // with the keys PRESENT so a caller can tell null from absent), and the
  // fixed flag falls back to the column's own default of 0 — is_fixed has no
  // null state, so null would be an invented fourth value.
  it('maps missing belief keys to null credence, null timestamp and a 0 fixed flag', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({ id: 1, title: 'A node' });

    expect(mappedBeliefFields).toEqual({
      belief_credence: null,
      belief_computed_at: null,
      belief_credence_is_fixed: 0,
      // EDITED per v2 §2: no masses on the row means never assessed, so the
      // derived uncertainty is null too.
      belief_uncertainty: null,
    });
    expect(Object.keys(mappedBeliefFields)).toContain('belief_credence');
    expect(Object.keys(mappedBeliefFields)).toContain('belief_computed_at');
    expect(Object.keys(mappedBeliefFields)).toContain('belief_credence_is_fixed');
  });

  // A stored NULL stays null: an ungraded node is a real state, and reporting
  // it as 0 would claim the node was assessed and believed neither way.
  it('keeps a stored NULL credence as null, never 0', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: null,
      belief_computed_at: null,
      belief_credence_is_fixed: 0,
    });

    expect(mappedBeliefFields.belief_credence).toBeNull();
    expect(mappedBeliefFields.belief_credence).not.toBe(0);
    expect(mappedBeliefFields.belief_computed_at).toBeNull();
  });

  // The mirror-image state: a credence of exactly 0 is a graded judgement —
  // assessed and believed neither way — and must never collapse into the null
  // that means "nobody has grounded this node".
  it('keeps a real 0 credence as 0, never null', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      belief_credence: 0,
      belief_computed_at: GRADED_BELIEF_COMPUTED_AT,
      belief_credence_is_fixed: 0,
    });

    expect(mappedBeliefFields.belief_credence).toBe(0);
    expect(mappedBeliefFields.belief_credence).not.toBeNull();
    expect(mappedBeliefFields.belief_computed_at).toBe(GRADED_BELIEF_COMPUTED_AT);
  });

  // Graded values pass through verbatim, including a NEGATIVE credence —
  // credence is the only signed quantity in the system, and a disbelieved
  // node's minus sign is exactly what makes its evidence count against its
  // neighbours — and including the fixed flag of a human-asserted credence.
  it('passes graded values through verbatim, including a negative fixed credence', () => {
    expect(
      beliefFieldsForNodeRead({
        belief_credence: -0.4,
        belief_computed_at: GRADED_BELIEF_COMPUTED_AT,
        belief_credence_is_fixed: 1,
      })
    ).toEqual({
      belief_credence: -0.4,
      belief_computed_at: GRADED_BELIEF_COMPUTED_AT,
      belief_credence_is_fixed: 1,
      // EDITED per v2 §2: a fixed credence is the dogmatic opinion, u = 0.
      belief_uncertainty: 0,
    });
  });

  // The mapper reports the belief fields and nothing else, so a door can
  // spread it into its node read without it overwriting neighbouring columns.
  // EDITED per v2 §6: belief_uncertainty joins the three stored columns.
  it('reports exactly the four belief fields and no others', () => {
    const mappedBeliefFields = beliefFieldsForNodeRead({
      id: 5,
      title: 'A graded node',
      metadata: { type: 'paper' },
      belief_credence: 0.62,
      belief_computed_at: GRADED_BELIEF_COMPUTED_AT,
      belief_credence_is_fixed: 0,
    });

    expect(Object.keys(mappedBeliefFields).sort()).toEqual([
      'belief_computed_at',
      'belief_credence',
      'belief_credence_is_fixed',
      'belief_uncertainty',
    ]);
  });
});

describe('belief output-schema fields for a node read', () => {
  // The fragment must declare exactly the four belief fields, so a door can
  // spread it into its per-node output schema and advertise all of them.
  // EDITED per v2 §6: belief_uncertainty joins the three stored columns.
  it('declares exactly the four belief fields', () => {
    expect(Object.keys(beliefNodeReadOutputSchemaFields).sort()).toEqual([
      'belief_computed_at',
      'belief_credence',
      'belief_credence_is_fixed',
      'belief_uncertainty',
    ]);
  });

  // belief_credence must accept every state the mapper can produce — a signed
  // number including 0, and null for ungraded — or a door would advertise a
  // schema its own replies violate. A numeric string is a non-number and stays
  // refused.
  it('accepts number-or-null credence, including 0 and a negative, and rejects a string', () => {
    const beliefCredenceSchema = beliefNodeReadOutputSchemaFields.belief_credence;

    expect(beliefCredenceSchema.safeParse(0).success, 'credence 0 must be accepted').toBe(true);
    expect(beliefCredenceSchema.safeParse(0.62).success, 'a positive credence must be accepted').toBe(true);
    expect(beliefCredenceSchema.safeParse(-0.4).success, 'a negative credence must be accepted').toBe(true);
    expect(beliefCredenceSchema.safeParse(null).success, 'an ungraded null must be accepted').toBe(true);
    expect(beliefCredenceSchema.safeParse('0.62').success, 'a string must be rejected').toBe(false);
  });

  // belief_computed_at is a timestamp string when graded and null when not;
  // a bare number is neither.
  it('accepts string-or-null computed_at and rejects a number', () => {
    const beliefComputedAtSchema = beliefNodeReadOutputSchemaFields.belief_computed_at;

    expect(beliefComputedAtSchema.safeParse(GRADED_BELIEF_COMPUTED_AT).success).toBe(true);
    expect(beliefComputedAtSchema.safeParse(null).success).toBe(true);
    expect(beliefComputedAtSchema.safeParse(1753693200000).success).toBe(false);
  });

  // belief_credence_is_fixed is a two-state flag with no null state: the
  // column is NOT NULL DEFAULT 0. Anything beyond 0/1 — including a boolean,
  // which would silently re-type the column — must be refused.
  it('accepts exactly 0 and 1 for the fixed flag and rejects every other value', () => {
    const beliefCredenceIsFixedSchema = beliefNodeReadOutputSchemaFields.belief_credence_is_fixed;

    expect(beliefCredenceIsFixedSchema.safeParse(0).success, '0 (derived) must be accepted').toBe(true);
    expect(beliefCredenceIsFixedSchema.safeParse(1).success, '1 (fixed) must be accepted').toBe(true);
    for (const rejectedFixedFlagValue of [2, -1, 0.5, true, false, null, '1'] as const) {
      expect(
        beliefCredenceIsFixedSchema.safeParse(rejectedFixedFlagValue).success,
        `a fixed flag of ${JSON.stringify(rejectedFixedFlagValue)} must be rejected`
      ).toBe(false);
    }
  });
});
