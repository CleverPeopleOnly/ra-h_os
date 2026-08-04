/**
 * Spec for the belief demo-graph seed (overlay slice 8):
 * `scripts/seed-belief-demo-graph.ts` exporting
 * `seedBeliefDemoGraph(databasePath)` plus a thin CLI wrapper in the same
 * file. Run against a FRESH database path, the seed must create the schema
 * through the app's own SQLite client and populate, THROUGH THE REAL
 * SERVICES (nodeService.createNode, edgeService.createEdge,
 * setBeliefFixedCredence — never raw SQL writes of the belief columns), six
 * clearly-titled exemplar nodes whose belief states, graded by the REAL
 * engine, exercise every visual state of the belief map overlay:
 *
 *  1. a FIXED ANCHOR (human-asserted positive credence): badge, solid ring,
 *     'for' hue, uncertainty exactly 0,
 *  2. a BELIEVED node (multiple supporting evidence edges): 'for' hue, solid
 *     ring (uncertainty < 0.5), engine-graded (not fixed),
 *  3. a DISBELIEVED node (evidence from a negatively-fixed source):
 *     'against' hue,
 *  4. a CONTESTED node (balanced heavy evidence both ways): 'neutral' hue,
 *     solid ring, uncertainty well below the dashed threshold,
 *  5. a BARELY-ASSESSED node (one weak evidence edge): dashed ring
 *     (uncertainty >= 0.5),
 *  6. an UNGRADED node (no evidence): no belief treatment at all.
 *
 * DELIBERATE LOOSENESS: the tests pin hue / ring style / badge and the
 * uncertainty THRESHOLDS through deriveBeliefPresentation — never exact
 * credence decimals — because the engine's numbers may evolve while the six
 * visual states must not. Engine PROVENANCE is pinned structurally instead:
 * the believed node's stored masses must reproduce its own evidence ledger
 * (spot-pin), and every seeded support must sit inside unsigned [0, 1].
 *
 * PINNED CHOICE (flagged for the Reviewer): the seed REFUSES an existing
 * database file — rerunning it or aiming it at any pre-existing file must
 * reject with an error naming the path, never silently reseed. A demo seed
 * has no legitimate merge-into-existing-data story.
 *
 * RED expectation while unimplemented: scripts/seed-belief-demo-graph.ts
 * does not exist, so the dynamic import (and the CLI source-text read)
 * fails in every test.
 *
 * SAFETY: same sentinel discipline as helpers/tempBeliefDatabase.ts — the
 * SQLite client opens its file at MODULE LOAD from SQLITE_DB_PATH, so this
 * file pins that env var to a throwaway temp sentinel the moment it loads,
 * and every product module that touches the database is imported dynamically
 * AFTER the target path is pinned and the module registry reset.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Pure presentation lens (no sqlite-client anywhere in its import graph —
// beliefPresentation -> beliefMcpToolContract.js -> zod only), so a static
// import can never touch the real database and the lens needs no per-test
// re-import.
import {
  deriveBeliefPresentation,
  type BeliefPresentationNodeFields,
} from '@/services/belief/beliefPresentation';
// Independent hand-calculation of the v2 projection (type-only dependency on
// the temp-database helper, erased at runtime), for the engine-provenance
// spot-pin.
import {
  expectedBeliefCredenceProjection,
} from './helpers/beliefEvidenceMassExpectations';

// Module-load sentinel: from the instant this file loads, any accidental
// sqlite-client import opens a harmless temp file instead of the user's real
// database (same pattern as helpers/tempBeliefDatabase.ts).
const sentinelTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-belief-demo-seed-sentinel-'));
process.env.SQLITE_DB_PATH = path.join(sentinelTempDir, 'rah-sentinel.sqlite');

// Repo root, resolved from this test file's location (tests/unit/belief/).
const repoRootDir = path.resolve(__dirname, '..', '..', '..');

// The seed module under test. Held in a variable (not an import literal)
// because the module does not exist yet — this slice's red — and a literal
// specifier would fail tsc's module resolution; the cast below keeps
// `tsc --noEmit` clean while the runtime import reds with a readable
// resolution error.
const seedBeliefDemoGraphScriptPath = path.join(
  repoRootDir,
  'scripts',
  'seed-belief-demo-graph.ts'
);

// The six exemplar node ids the seed must hand back, one per visual state,
// so callers (these tests, and the slice-9 screenshot run) can address each
// exemplar without guessing at titles.
interface BeliefDemoGraphSeedResult {
  // State 1: human-asserted positive credence (badge, solid, 'for', u = 0).
  fixedAnchorNodeId: number;
  // State 2: engine-believed ('for', solid, u < 0.5).
  believedNodeId: number;
  // State 3: engine-disbelieved ('against').
  disbelievedNodeId: number;
  // State 4: engine-contested ('neutral', solid, u well below 0.5).
  contestedNodeId: number;
  // State 5: barely assessed (dashed, u >= 0.5).
  barelyAssessedNodeId: number;
  // State 6: never assessed (no belief treatment at all).
  ungradedNodeId: number;
}

// The seed module's expected export surface, asserted through a cast because
// the module does not exist yet (see seedBeliefDemoGraphScriptPath).
interface SeedBeliefDemoGraphModule {
  // Seed the demo graph into a FRESH database file at databasePath; rejects
  // when a file already exists there.
  seedBeliefDemoGraph(databasePath: string): Promise<BeliefDemoGraphSeedResult>;
}

// Every per-test mkdtemp directory, deleted after each test.
const tempDirsToCleanUp: string[] = [];

// One prepared seed target: a fresh (not-yet-existing) database path inside
// its own temp directory, with SQLITE_DB_PATH already pointing at it and the
// module registry reset so the next product import binds to it.
interface BeliefDemoSeedTarget {
  // The fresh path the seed must create its database file at.
  databasePath: string;
}

// Point the process at a brand-new database path: fresh temp dir, env pinned,
// module registry reset. The file itself is NOT created — creating it is the
// seed's job (and pre-creating it is the refusal tests' job).
function prepareFreshBeliefDemoSeedTarget(): BeliefDemoSeedTarget {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-belief-demo-seed-test-'));
  tempDirsToCleanUp.push(tempDir);
  const databasePath = path.join(tempDir, 'rah-belief-demo.sqlite');
  process.env.SQLITE_DB_PATH = databasePath;
  vi.resetModules();
  return { databasePath };
}

// Import the seed module bound to the CURRENT registry generation (call only
// after prepareFreshBeliefDemoSeedTarget). The unimplemented module makes
// this rejection the red of nearly every test below.
async function importSeedBeliefDemoGraphModule(): Promise<SeedBeliefDemoGraphModule> {
  return (await import(/* @vite-ignore */ seedBeliefDemoGraphScriptPath)) as unknown as
    SeedBeliefDemoGraphModule;
}

// Prepare a fresh target, import the seed module, run the seed, and hand back
// everything the state assertions need. The shared happy path of tests 3-10.
async function seedFreshBeliefDemoGraph(): Promise<{
  databasePath: string;
  seedResult: BeliefDemoGraphSeedResult;
}> {
  const { databasePath } = prepareFreshBeliefDemoSeedTarget();
  const seedModule = await importSeedBeliefDemoGraphModule();
  const seedResult = await seedModule.seedBeliefDemoGraph(databasePath);
  return { databasePath, seedResult };
}

// Read one seeded node THROUGH THE REAL NODE SERVICE (the same read the app
// renders from), returning its title plus the belief fields the presentation
// lens consumes. Cast locally: the Node type does not declare the two mass
// columns.
async function readSeededNodeThroughNodeService(
  nodeId: number
): Promise<BeliefPresentationNodeFields & { title: string }> {
  // The node service bound to THIS registry generation (same database file).
  const { nodeService } = await import('@/services/database/nodes');
  const seededNode = await nodeService.getNodeById(nodeId);
  expect(seededNode, `seeded node #${nodeId} must be readable through the node service`).not.toBeNull();
  return seededNode as unknown as BeliefPresentationNodeFields & { title: string };
}

// Read one seeded node and derive its whole presentation decision — the lens
// every visual-state assertion below looks through.
async function deriveSeededNodeBeliefPresentation(nodeId: number) {
  const seededNodeBeliefFields = await readSeededNodeThroughNodeService(nodeId);
  return deriveBeliefPresentation(seededNodeBeliefFields);
}

// Run one read-only raw query against the seeded database FILE (verification
// reads only — the seed itself must never write the belief columns raw).
// Opening the literal path is also the proof the seed honoured its
// databasePath argument rather than writing somewhere else.
function readRawRowsFromSeededBeliefDemoDatabase<RawRow>(
  databasePath: string,
  sql: string,
  params: ReadonlyArray<number | string> = []
): RawRow[] {
  const rawDatabase = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return rawDatabase.prepare(sql).all(...params) as RawRow[];
  } finally {
    rawDatabase.close();
  }
}

// Count a node's incoming evidence edges (support NOT NULL is the one thing
// that makes an edge evidence) in the seeded file.
function countIncomingEvidenceEdgesInSeededDatabase(
  databasePath: string,
  toNodeId: number
): number {
  const countRows = readRawRowsFromSeededBeliefDemoDatabase<{ evidence_edge_count: number }>(
    databasePath,
    'SELECT COUNT(*) AS evidence_edge_count FROM edges WHERE to_node_id = ? AND belief_evidence_support IS NOT NULL',
    [toNodeId]
  );
  return countRows[0].evidence_edge_count;
}

afterEach(async () => {
  // Close whatever client generation the test left open (dynamically, so a
  // test that never loaded the client just opens-and-closes a temp file),
  // then delete this test's temp directories and re-arm the sentinel.
  try {
    const sqliteClientModule = await import('@/services/database/sqlite-client');
    sqliteClientModule.getSQLiteClient().close();
  } catch {
    // A red import path may leave no client to close; nothing to do.
  }
  for (const tempDir of tempDirsToCleanUp.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  process.env.SQLITE_DB_PATH = path.join(sentinelTempDir, 'rah-sentinel.sqlite');
});

describe('seedBeliefDemoGraph (scripts/seed-belief-demo-graph.ts)', () => {
  // The check-before-open contract: merely importing the seed module must not
  // create (or open) any database file — otherwise the module's own import
  // side effect would defeat its existing-file refusal, and importing it from
  // a test or another script would touch a database unasked.
  it('creates no database file on module import alone', async () => {
    const { databasePath } = prepareFreshBeliefDemoSeedTarget();

    await importSeedBeliefDemoGraphModule();

    expect(fs.existsSync(databasePath)).toBe(false);
  });

  // The core deliverable: one call against a fresh path creates the database
  // file AT THAT PATH and returns six distinct, clearly-titled exemplars.
  it('seeds a fresh path with six distinct, distinctly-titled exemplar nodes', async () => {
    const { databasePath, seedResult } = await seedFreshBeliefDemoGraph();

    // The file landed at the literal path the caller gave.
    expect(fs.existsSync(databasePath)).toBe(true);

    // Six ids, all distinct — one node per visual state, never one node
    // wearing two hats.
    const exemplarNodeIds = [
      seedResult.fixedAnchorNodeId,
      seedResult.believedNodeId,
      seedResult.disbelievedNodeId,
      seedResult.contestedNodeId,
      seedResult.barelyAssessedNodeId,
      seedResult.ungradedNodeId,
    ];
    for (const exemplarNodeId of exemplarNodeIds) {
      expect(typeof exemplarNodeId).toBe('number');
    }
    expect(new Set(exemplarNodeIds).size).toBe(6);

    // Clearly titled: every exemplar carries its own non-empty title, and no
    // two share one — slice 9's screenshots must be tellable apart by title.
    const exemplarTitles: string[] = [];
    for (const exemplarNodeId of exemplarNodeIds) {
      const seededNode = await readSeededNodeThroughNodeService(exemplarNodeId);
      expect(seededNode.title.trim().length).toBeGreaterThan(0);
      exemplarTitles.push(seededNode.title);
    }
    expect(new Set(exemplarTitles).size).toBe(6);
  });

  // State 1 — the fixed anchor: a human-asserted positive credence renders
  // with the fixed badge, a solid ring, the 'for' hue, and uncertainty
  // EXACTLY 0 (the dogmatic opinion; the one exact number in this suite,
  // because it is definitional, not an engine decimal).
  it('renders the fixed anchor with badge, solid ring, for hue and uncertainty 0', async () => {
    const { databasePath, seedResult } = await seedFreshBeliefDemoGraph();

    const anchorPresentation = await deriveSeededNodeBeliefPresentation(
      seedResult.fixedAnchorNodeId
    );

    expect(anchorPresentation.beliefFixedBadgeShown).toBe(true);
    expect(anchorPresentation.beliefRingHue).toBe('for');
    expect(anchorPresentation.beliefRingStyle).toBe('solid');
    expect(anchorPresentation.beliefUncertainty).toBe(0);

    // The assertion really went through the fixed-credence door: flag 1 and
    // a positive stored credence in the seeded file.
    const anchorRows = readRawRowsFromSeededBeliefDemoDatabase<{
      belief_credence: number | null;
      belief_credence_is_fixed: number;
    }>(
      databasePath,
      'SELECT belief_credence, belief_credence_is_fixed FROM nodes WHERE id = ?',
      [seedResult.fixedAnchorNodeId]
    );
    expect(anchorRows[0].belief_credence_is_fixed).toBe(1);
    expect(anchorRows[0].belief_credence).toBeGreaterThan(0);
  });

  // State 2 — the believed node: multiple supporting evidence edges leave it
  // engine-graded 'for' on enough evidence mass that the ring is solid
  // (uncertainty < 0.5). Thresholds only, never the credence decimal.
  it('renders the believed node with for hue and a solid ring from multiple evidence edges', async () => {
    const { databasePath, seedResult } = await seedFreshBeliefDemoGraph();

    const believedPresentation = await deriveSeededNodeBeliefPresentation(
      seedResult.believedNodeId
    );

    expect(believedPresentation.beliefRingHue).toBe('for');
    expect(believedPresentation.beliefRingStyle).toBe('solid');
    expect(believedPresentation.beliefUncertainty).not.toBeNull();
    expect(believedPresentation.beliefUncertainty!).toBeLessThan(0.5);
    // Engine-graded, never asserted: no badge.
    expect(believedPresentation.beliefFixedBadgeShown).toBe(false);

    // "Multiple" is structural: at least two incoming evidence edges.
    expect(
      countIncomingEvidenceEdgesInSeededDatabase(databasePath, seedResult.believedNodeId)
    ).toBeGreaterThanOrEqual(2);
  });

  // State 3 — the disbelieved node: evidence from a negatively-fixed source
  // grades it below zero, so the ring reads 'against'. Engine-graded, not a
  // hand assertion.
  it('renders the disbelieved node with the against hue, engine-graded', async () => {
    const { seedResult } = await seedFreshBeliefDemoGraph();

    const disbelievedPresentation = await deriveSeededNodeBeliefPresentation(
      seedResult.disbelievedNodeId
    );

    expect(disbelievedPresentation.beliefRingHue).toBe('against');
    expect(disbelievedPresentation.beliefFixedBadgeShown).toBe(false);
  });

  // State 4 — the contested node: balanced heavy evidence both ways grades to
  // the 'neutral' hue on a SOLID ring — uncertainty pinned below 0.4 (well
  // below the 0.5 dashed threshold) so "contested on lots of evidence" can
  // never be confused with "barely assessed". Both masses must be real
  // positive evidence: neutral-by-balance, never neutral-by-absence.
  it('renders the contested node neutral and solid, with positive evidence mass both ways', async () => {
    const { databasePath, seedResult } = await seedFreshBeliefDemoGraph();

    const contestedPresentation = await deriveSeededNodeBeliefPresentation(
      seedResult.contestedNodeId
    );

    expect(contestedPresentation.beliefRingHue).toBe('neutral');
    expect(contestedPresentation.beliefRingStyle).toBe('solid');
    expect(contestedPresentation.beliefUncertainty).not.toBeNull();
    expect(contestedPresentation.beliefUncertainty!).toBeLessThan(0.4);
    expect(contestedPresentation.beliefFixedBadgeShown).toBe(false);

    // The balance is real: the engine persisted evidence mass on BOTH sides.
    const contestedMassRows = readRawRowsFromSeededBeliefDemoDatabase<{
      belief_evidence_for_mass: number | null;
      belief_evidence_against_mass: number | null;
    }>(
      databasePath,
      'SELECT belief_evidence_for_mass, belief_evidence_against_mass FROM nodes WHERE id = ?',
      [seedResult.contestedNodeId]
    );
    expect(contestedMassRows[0].belief_evidence_for_mass).toBeGreaterThan(0);
    expect(contestedMassRows[0].belief_evidence_against_mass).toBeGreaterThan(0);
  });

  // State 5 — the barely-assessed node: exactly one weak evidence edge leaves
  // its credence resting on so little evidence that the ring is DASHED
  // (uncertainty >= 0.5) — the overlay's "assessed, but questionable" look.
  it('renders the barely-assessed node with a dashed ring from one weak evidence edge', async () => {
    const { databasePath, seedResult } = await seedFreshBeliefDemoGraph();

    const barelyAssessedPresentation = await deriveSeededNodeBeliefPresentation(
      seedResult.barelyAssessedNodeId
    );

    // Assessed at all: some hue, never the no-treatment state.
    expect(barelyAssessedPresentation.beliefRingHue).not.toBeNull();
    expect(barelyAssessedPresentation.beliefRingStyle).toBe('dashed');
    expect(barelyAssessedPresentation.beliefUncertainty).not.toBeNull();
    expect(barelyAssessedPresentation.beliefUncertainty!).toBeGreaterThanOrEqual(0.5);

    // "One weak edge" is structural: exactly one incoming evidence edge.
    expect(
      countIncomingEvidenceEdgesInSeededDatabase(databasePath, seedResult.barelyAssessedNodeId)
    ).toBe(1);
  });

  // State 6 — the ungraded node: no evidence at all means NO belief treatment
  // — every ring field null, no badge, null uncertainty, and accessible text
  // that says so with no number. NULL never renders as 0.
  it('renders the ungraded node with no belief treatment at all', async () => {
    const { databasePath, seedResult } = await seedFreshBeliefDemoGraph();

    const ungradedPresentation = await deriveSeededNodeBeliefPresentation(
      seedResult.ungradedNodeId
    );

    expect(ungradedPresentation.beliefRingHue).toBeNull();
    expect(ungradedPresentation.beliefRingIntensityPercent).toBeNull();
    expect(ungradedPresentation.beliefRingStyle).toBeNull();
    expect(ungradedPresentation.beliefFixedBadgeShown).toBe(false);
    expect(ungradedPresentation.beliefUncertainty).toBeNull();
    expect(ungradedPresentation.beliefAccessibleText).toBe('belief not assessed');

    // Truly ungraded in storage too: no incoming evidence, and credence and
    // both masses NULL — the never-assessed state, not a zero.
    expect(
      countIncomingEvidenceEdgesInSeededDatabase(databasePath, seedResult.ungradedNodeId)
    ).toBe(0);
    const ungradedRows = readRawRowsFromSeededBeliefDemoDatabase<{
      belief_credence: number | null;
      belief_evidence_for_mass: number | null;
      belief_evidence_against_mass: number | null;
    }>(
      databasePath,
      'SELECT belief_credence, belief_evidence_for_mass, belief_evidence_against_mass FROM nodes WHERE id = ?',
      [seedResult.ungradedNodeId]
    );
    expect(ungradedRows[0].belief_credence).toBeNull();
    expect(ungradedRows[0].belief_evidence_for_mass).toBeNull();
    expect(ungradedRows[0].belief_evidence_against_mass).toBeNull();
  });

  // Engine-provenance spot-pin: the believed node's persisted masses must
  // reproduce its OWN evidence ledger (each counted contribution = from-node
  // credence x support, split by sign), and its cached credence must be the
  // v2 projection of those masses — proof the numbers came from the real
  // engine, not from any hand-written credence.
  it('grades the believed node from its own evidence ledger through the real engine', async () => {
    const { databasePath, seedResult } = await seedFreshBeliefDemoGraph();

    // The believed node's incoming evidence ledger, joined with each source
    // node's own credence — the same join the engine grades from.
    const evidenceLedgerRows = readRawRowsFromSeededBeliefDemoDatabase<{
      belief_evidence_support: number;
      from_node_belief_credence: number | null;
    }>(
      databasePath,
      `SELECT e.belief_evidence_support, n.belief_credence AS from_node_belief_credence
       FROM edges e JOIN nodes n ON n.id = e.from_node_id
       WHERE e.to_node_id = ? AND e.belief_evidence_support IS NOT NULL`,
      [seedResult.believedNodeId]
    );

    // Hand-accumulate the ledger into the two unsigned masses: positive
    // contributions to the for mass, magnitudes of negative ones to the
    // against mass; an ungraded source (credence NULL) casts no vote.
    let handAccumulatedForMass = 0;
    let handAccumulatedAgainstMass = 0;
    for (const evidenceLedgerRow of evidenceLedgerRows) {
      if (evidenceLedgerRow.from_node_belief_credence === null) continue;
      // This edge's signed contribution: source credence x unsigned support.
      const signedContribution =
        evidenceLedgerRow.from_node_belief_credence * evidenceLedgerRow.belief_evidence_support;
      if (signedContribution >= 0) {
        handAccumulatedForMass += signedContribution;
      } else {
        handAccumulatedAgainstMass += -signedContribution;
      }
    }

    // The believed node's persisted belief state, straight from the file.
    const believedRows = readRawRowsFromSeededBeliefDemoDatabase<{
      belief_credence: number | null;
      belief_credence_is_fixed: number;
      belief_computed_at: string | null;
      belief_evidence_for_mass: number | null;
      belief_evidence_against_mass: number | null;
    }>(
      databasePath,
      `SELECT belief_credence, belief_credence_is_fixed, belief_computed_at,
              belief_evidence_for_mass, belief_evidence_against_mass
       FROM nodes WHERE id = ?`,
      [seedResult.believedNodeId]
    );
    const believedRow = believedRows[0];

    // Engine-graded, never asserted: flag 0 and a grading timestamp.
    expect(believedRow.belief_credence_is_fixed).toBe(0);
    expect(typeof believedRow.belief_computed_at).toBe('string');
    // The persisted masses ARE the ledger's accumulation.
    expect(believedRow.belief_evidence_for_mass).toBeCloseTo(handAccumulatedForMass, 10);
    expect(believedRow.belief_evidence_against_mass).toBeCloseTo(handAccumulatedAgainstMass, 10);
    // The cached credence IS the v2 projection of those masses.
    expect(believedRow.belief_credence).toBeCloseTo(
      expectedBeliefCredenceProjection(handAccumulatedForMass, handAccumulatedAgainstMass),
      10
    );
  });

  // Support hygiene: every evidence edge the seed wrote carries an unsigned
  // support inside [0, 1] — the sign of any contribution lives on the source
  // node's credence, never on an edge — and at least one evidence edge exists
  // at all (a seed that wrote none could not have exercised the engine).
  it('keeps every seeded evidence support inside the unsigned [0, 1] range', async () => {
    const { databasePath } = await seedFreshBeliefDemoGraph();

    const seededSupportRows = readRawRowsFromSeededBeliefDemoDatabase<{
      belief_evidence_support: number;
    }>(
      databasePath,
      'SELECT belief_evidence_support FROM edges WHERE belief_evidence_support IS NOT NULL'
    );

    expect(seededSupportRows.length).toBeGreaterThan(0);
    for (const seededSupportRow of seededSupportRows) {
      expect(seededSupportRow.belief_evidence_support).toBeGreaterThanOrEqual(0);
      expect(seededSupportRow.belief_evidence_support).toBeLessThanOrEqual(1);
    }
  });

  // The refusal, half one: any pre-existing file at the path — whatever put
  // it there — must reject with an error NAMING the path, never silently
  // reseed or append. A demo seed owns fresh files only.
  it('refuses to seed over a pre-existing file, naming the path', async () => {
    const { databasePath } = prepareFreshBeliefDemoSeedTarget();
    // Any pre-existing file counts, even an empty non-database one.
    fs.writeFileSync(databasePath, '');
    const seedModule = await importSeedBeliefDemoGraphModule();

    await expect(seedModule.seedBeliefDemoGraph(databasePath)).rejects.toThrow(databasePath);
  });

  // The refusal, half two: the seed's own output is also an existing file, so
  // a second run over the same path must reject the same way — rerun safety
  // by refusal, the pinned alternative to idempotent reseeding.
  it('refuses a second run over its own freshly-seeded output', async () => {
    const { databasePath } = prepareFreshBeliefDemoSeedTarget();
    const seedModule = await importSeedBeliefDemoGraphModule();
    // First run: fresh path, must succeed.
    await seedModule.seedBeliefDemoGraph(databasePath);

    await expect(seedModule.seedBeliefDemoGraph(databasePath)).rejects.toThrow(databasePath);
  });

  // The thin CLI wrapper, pinned as source text: the same script file must
  // read its target path from argv and hand it to seedBeliefDemoGraph, and
  // must gate that call behind a direct-execution guard (any mechanism —
  // require.main, import.meta.url, argv[1] comparison) so that importing the
  // module, as every test above does, never fires the CLI. The guard's
  // effectiveness is pinned behaviourally by the import-only test up top;
  // this test pins that the wrapper exists at all.
  it('ships a CLI wrapper: argv path parsing, a guarded call to seedBeliefDemoGraph', () => {
    const seedScriptSourceText = fs.readFileSync(seedBeliefDemoGraphScriptPath, 'utf8');

    // Parses a path argument from the command line.
    expect(seedScriptSourceText).toContain('process.argv');
    // Calls the exported seed function.
    expect(seedScriptSourceText).toMatch(/seedBeliefDemoGraph\s*\(/);
    // Carries some direct-execution guard so import alone never runs main.
    expect(seedScriptSourceText).toMatch(/require\.main|import\.meta\.url|process\.argv\[1\]/);
  });
});
