/**
 * The Node type (src/types/database.ts) must gain the two evidence-mass
 * columns of belief model v2 — belief_evidence_for_mass and
 * belief_evidence_against_mass — beside the three belief columns it already
 * declares. Without them, every typed consumer of the list read (MR-B's
 * presentation call sites above all) has to cast to reach the masses, and a
 * cast is exactly where a `?? 0` slips in unseen.
 *
 * A type's ABSENCE cannot be observed at runtime and a straight type-level
 * usage of a missing property would fail `tsc --noEmit` today (which must
 * stay clean), so the pin is split in two:
 *
 *  1. the RED, at runtime: the checked-in declaration source must name both
 *     columns typed `number | null` inside it — read off the file, the same
 *     way the schema tests read PRAGMA table_info off the database,
 *  2. the TSC GATE, compile-time and self-arming: conditional types that fall
 *     back to the pinned column type while Node lacks the column (keeping tsc
 *     clean today), and the moment the column is declared, enforce that it
 *     admits BOTH number and null — NULL means never assessed and is a state
 *     of its own, so a mass column declared as plain `number` must not
 *     compile.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import type { Node } from '@/types/database';

// Absolute path of the checked-in Node type declaration, resolved from this
// test file so the read never depends on the process working directory.
const databaseTypesSourcePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/types/database.ts'
);

// TSC GATE (see module comment): while Node lacks the column this alias IS
// the pinned column type, so the assignments below compile today; once the
// column is declared, the alias becomes the declared type and the same
// assignments enforce that it admits number AND null. `undefined` is admitted
// because the belief columns on Node are optional properties, like the three
// already declared. The indexed access lives behind a GENERIC helper because
// on a concrete type TypeScript checks the unused conditional branch eagerly
// (TS2538 on Node['belief_evidence_for_mass'] while the column is missing);
// inside a generic, the branch is only instantiated when the key exists.
type BeliefColumnTypeOrPinned<
  NodeShape,
  BeliefColumnName extends string,
  PinnedBeliefColumnType,
> = BeliefColumnName extends keyof NodeShape ? NodeShape[BeliefColumnName] : PinnedBeliefColumnType;

// The self-arming gate for the for-mass column.
type BeliefEvidenceForMassColumnType = BeliefColumnTypeOrPinned<
  Node,
  'belief_evidence_for_mass',
  number | null | undefined
>;

// The same self-arming gate for the against-mass column.
type BeliefEvidenceAgainstMassColumnType = BeliefColumnTypeOrPinned<
  Node,
  'belief_evidence_against_mass',
  number | null | undefined
>;

describe('Node type belief evidence mass columns', () => {
  // The red: the declaration source must name both mass columns, typed
  // `number | null`. This is a source pin because a missing property is
  // invisible to the runtime and a direct usage would break today's tsc.
  it('declares belief_evidence_for_mass and belief_evidence_against_mass as number | null', () => {
    const databaseTypesSource = fs.readFileSync(databaseTypesSourcePath, 'utf8');
    // Optional marker allowed (the belief columns on Node are optional);
    // the value type must admit number and null, in that spelling order.
    expect(databaseTypesSource).toMatch(/belief_evidence_for_mass\??:\s*number\s*\|\s*null/);
    expect(databaseTypesSource).toMatch(/belief_evidence_against_mass\??:\s*number\s*\|\s*null/);
  });

  // The compile-time half of the gate, exercised as values so the aliases
  // are used: both a number and a null must be assignable to each declared
  // column type — a mass column that refuses null would turn "never
  // assessed" into an unrepresentable state.
  it('admits number and null on both declared column types (self-arming tsc gate)', () => {
    // A stored mass: unsigned accumulated evidence.
    const beliefEvidenceForMassAsNumber: BeliefEvidenceForMassColumnType = 0.4;
    // A never-assessed node's mass: NULL, a state of its own.
    const beliefEvidenceForMassAsNull: BeliefEvidenceForMassColumnType = null;
    const beliefEvidenceAgainstMassAsNumber: BeliefEvidenceAgainstMassColumnType = 0;
    const beliefEvidenceAgainstMassAsNull: BeliefEvidenceAgainstMassColumnType = null;

    expect(beliefEvidenceForMassAsNumber).toBe(0.4);
    expect(beliefEvidenceForMassAsNull).toBeNull();
    // 0 is an assessed mass carrying nothing — a value, never a rejection.
    expect(beliefEvidenceAgainstMassAsNumber).toBe(0);
    expect(beliefEvidenceAgainstMassAsNull).toBeNull();
  });
});
