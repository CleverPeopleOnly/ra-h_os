/**
 * Seed a brand-new demo database whose graph exercises every visual state of
 * the belief map overlay (slice 8): a fixed anchor, a believed node, a
 * disbelieved node, a contested node, a barely-assessed node, and an ungraded
 * node — every credence graded by the REAL belief engine through the real
 * services (nodeService.createNode, edgeService.createEdge on the no-LLM
 * skip_inference path, setBeliefFixedCredence), never by raw SQL writes of
 * any belief column.
 *
 * REFUSAL PIN: the seed owns fresh files only. Any pre-existing file at the
 * target path — including this seed's own earlier output — rejects with an
 * error naming the path; a demo seed has no merge-into-existing-data story.
 *
 * IMPORT DISCIPLINE: the app's SQLite client opens its database file from
 * SQLITE_DB_PATH as a MODULE-IMPORT side effect, so this module keeps every
 * product import dynamic and performs the existing-file refusal and the
 * env-var pin BEFORE the first of them loads. Importing this module therefore
 * never creates or opens any database file.
 *
 * CLI: `npx tsx scripts/seed-belief-demo-graph.ts <database-path>` — a thin,
 * direct-execution-guarded wrapper over seedBeliefDemoGraph.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

// The six exemplar node ids the seed hands back — one per visual state of the
// belief map overlay, so callers (the seed tests, the slice-9 screenshot run)
// can address each exemplar without guessing at titles.
export interface BeliefDemoGraphSeedResult {
  // State 1: human-asserted positive credence (fixed badge, solid ring,
  // 'for' hue, uncertainty exactly 0).
  fixedAnchorNodeId: number;
  // State 2: engine-believed from multiple supporting evidence edges
  // ('for' hue, solid ring, uncertainty < 0.5).
  believedNodeId: number;
  // State 3: engine-disbelieved from a negatively-fixed source ('against' hue).
  disbelievedNodeId: number;
  // State 4: engine-contested on balanced heavy evidence both ways
  // ('neutral' hue, solid ring, uncertainty well below the dashed threshold).
  contestedNodeId: number;
  // State 5: barely assessed on one weak evidence edge (dashed ring,
  // uncertainty >= 0.5).
  barelyAssessedNodeId: number;
  // State 6: never assessed (no belief treatment at all).
  ungradedNodeId: number;
}

// Credence asserted by hand on the fixed anchor (exemplar 1): positive, so the
// anchor renders 'for' with the fixed badge and uncertainty exactly 0 (the
// dogmatic opinion). The anchor doubles as a graded source for other exemplars.
const BELIEF_DEMO_FIXED_ANCHOR_CREDENCE = 0.9;

// Credence fixed on each supporting scaffolding source the believed node
// derives from. Three supporting edges at support 0.9 give the believed node
// a for mass of 3 x (0.9 x 0.9) = 2.43, so uncertainty 2 / (2.43 + 2) ~= 0.45
// < 0.5: a solid 'for' ring resting on real evidence. Two edges could not get
// there — each contribution is < 1, so two of them can never push the total
// mass past the prior mass of 2.
const BELIEF_DEMO_SUPPORTING_SOURCE_CREDENCE = 0.9;

// Support carried by each of the believed node's three supporting edges.
const BELIEF_DEMO_SUPPORTING_EDGE_SUPPORT = 0.9;

// Credence fixed on the discredited source the disbelieved node derives from:
// negative, so the evidence it supplies counts AGAINST the node deriving from
// it — the sign lives on the source node's credence, never on an edge.
const BELIEF_DEMO_DISBELIEVED_SOURCE_CREDENCE = -0.8;

// Support on the disbelieved node's single evidence edge: against mass
// 0.8 x 0.8 = 0.64, projecting the derived node's credence below zero
// ('against').
const BELIEF_DEMO_DISBELIEVED_EDGE_SUPPORT = 0.8;

// Magnitude of the credence fixed on each of the four contested-side sources
// (two at +, two at -). Symmetric magnitudes and supports make the
// cancellation EXACT: both masses accumulate the very same doubles, so the
// contested credence projects to exactly 0 ('neutral' hue).
const BELIEF_DEMO_CONTESTED_SOURCE_CREDENCE_MAGNITUDE = 0.9;

// Support on each of the four contested edges. Total mass 4 x 0.9 = 3.6, so
// uncertainty 2 / (3.6 + 2) ~= 0.36 < 0.4: contested on lots of evidence,
// never confusable with barely assessed.
const BELIEF_DEMO_CONTESTED_EDGE_SUPPORT = 1;

// Support on the barely-assessed node's single weak edge (citing the anchor
// as its source): for mass 0.9 x 0.3 = 0.27, uncertainty 2 / (0.27 + 2) ~=
// 0.88 >= 0.5 — the dashed "assessed, but questionable" ring.
const BELIEF_DEMO_WEAK_EDGE_SUPPORT = 0.3;

/**
 * Seed the belief demo graph into a FRESH database file at databasePath.
 * Rejects (naming the path) when any file already exists there. Returns the
 * six exemplar node ids. The SQLite client bound to the file is left open so
 * the caller can keep reading through the same services.
 */
export async function seedBeliefDemoGraph(
  databasePath: string
): Promise<BeliefDemoGraphSeedResult> {
  // The refusal comes FIRST, before any product import: importing the client
  // would itself create the file, defeating the check.
  if (fs.existsSync(databasePath)) {
    throw new Error(
      `refusing to seed the belief demo graph: a file already exists at ${databasePath}. ` +
        'This seed owns fresh files only — delete the file or pick a new path.'
    );
  }

  // Pin the client's target BEFORE the first product import: the client reads
  // this env var and opens the file the moment its module loads.
  process.env.SQLITE_DB_PATH = databasePath;

  // The product modules, imported only now that the path is pinned. The
  // client import creates the file and runs the app's own schema migration.
  const { getSQLiteClient } = await import('@/services/database/sqlite-client');
  const { nodeService } = await import('@/services/database/nodes');
  const { edgeService } = await import('@/services/database/edges');
  const { setBeliefFixedCredence } = await import('@/services/belief/beliefFixedCredence');

  // Post-open guard (same discipline as the belief test harness): a cached
  // module registry may hold a client generation bound to some OTHER file, so
  // verify the file the client ACTUALLY has open is the caller's path before
  // writing a single row.
  const attachedDatabaseRows = getSQLiteClient()
    .prepare('PRAGMA database_list')
    .all() as Array<{ name: string; file: string }>;
  // The file the client's main database really points at.
  const openDatabaseFile = attachedDatabaseRows.find(row => row.name === 'main')?.file ?? '';
  // The caller's path in comparable form (realpath once the client created it).
  const requestedDatabaseRealPath = fs.existsSync(databasePath)
    ? fs.realpathSync(databasePath)
    : path.resolve(databasePath);
  if (openDatabaseFile === '' || fs.realpathSync(openDatabaseFile) !== requestedDatabaseRealPath) {
    throw new Error(
      `belief demo seed SAFETY: the SQLite client has "${openDatabaseFile}" open, ` +
        `not the requested "${databasePath}" — refusing to write`
    );
  }

  // Create one demo node through the real node service, returning its id.
  async function createBeliefDemoNode(title: string, description: string): Promise<number> {
    const createdNode = await nodeService.createNode({ title, description, source: description });
    return createdNode.id;
  }

  // Assert one demo node's credence by hand through the real fixed-credence
  // door. The node was created moments ago, so a missing-node refusal (null)
  // can only be a seed bug and throws.
  function assertBeliefDemoFixedCredence(nodeId: number, beliefCredence: number): void {
    const fixedCredenceAssertion = setBeliefFixedCredence(nodeId, beliefCredence);
    if (fixedCredenceAssertion === null) {
      throw new Error(
        `belief demo seed: node #${nodeId} vanished before its credence could be fixed`
      );
    }
  }

  // Create one evidence edge through the real edge service on the no-LLM path
  // (skip_inference, which also pins swap_direction to false, so the row is
  // STORED with exactly the ends written here). The edge runs in RA-H's canon
  // direction, Derivative→Source: the derived node at from_node_id, the
  // source it derives from at to_node_id — so the edge write itself makes the
  // engine regrade the derived node, the edge's from-end.
  async function createBeliefDemoEvidenceEdge(evidenceEdge: {
    derivedNodeId: number;
    sourceNodeId: number;
    support: number;
    explanation: string;
  }): Promise<void> {
    await edgeService.createEdge({
      from_node_id: evidenceEdge.derivedNodeId,
      to_node_id: evidenceEdge.sourceNodeId,
      explanation: evidenceEdge.explanation,
      created_via: 'workflow',
      source: 'user',
      skip_inference: true,
      belief_evidence_support: evidenceEdge.support,
    });
  }

  // ---- exemplar 1: the fixed anchor ---------------------------------------
  // Human-asserted positive credence: badge, solid ring, 'for' hue, u = 0.
  const fixedAnchorNodeId = await createBeliefDemoNode(
    'Belief demo: fixed anchor',
    'Exemplar 1 — credence asserted by hand, so the fixed badge shows and uncertainty is exactly 0.'
  );
  assertBeliefDemoFixedCredence(fixedAnchorNodeId, BELIEF_DEMO_FIXED_ANCHOR_CREDENCE);

  // ---- scaffolding sources ------------------------------------------------
  // Every source is fixed BEFORE any evidence cites it, so each later edge
  // write regrades its derived from-end against an already-graded source.

  // Two extra supporting sources for the believed node (the anchor is its third).
  const supportingSourceAlphaNodeId = await createBeliefDemoNode(
    'Belief demo source: corroborator alpha',
    'Scaffolding — a believed source whose evidence supports the believed exemplar.'
  );
  assertBeliefDemoFixedCredence(supportingSourceAlphaNodeId, BELIEF_DEMO_SUPPORTING_SOURCE_CREDENCE);
  const supportingSourceBetaNodeId = await createBeliefDemoNode(
    'Belief demo source: corroborator beta',
    'Scaffolding — a second believed source whose evidence supports the believed exemplar.'
  );
  assertBeliefDemoFixedCredence(supportingSourceBetaNodeId, BELIEF_DEMO_SUPPORTING_SOURCE_CREDENCE);

  // The discredited source the disbelieved node derives from: its NEGATIVE
  // fixed credence is what turns its evidence into against mass on the node
  // deriving from it.
  const disbelievedSourceNodeId = await createBeliefDemoNode(
    'Belief demo source: discredited origin',
    'Scaffolding — a disbelieved source; evidence it supplies counts against the node deriving from it.'
  );
  assertBeliefDemoFixedCredence(disbelievedSourceNodeId, BELIEF_DEMO_DISBELIEVED_SOURCE_CREDENCE);

  // The four contested-side sources: two fixed positive, two fixed negative,
  // with one shared magnitude so the contested node cancels exactly.
  const contestedForSourceAlphaNodeId = await createBeliefDemoNode(
    'Belief demo source: contested for-side alpha',
    'Scaffolding — one of two believed sources on the for side of the contested exemplar.'
  );
  assertBeliefDemoFixedCredence(
    contestedForSourceAlphaNodeId,
    BELIEF_DEMO_CONTESTED_SOURCE_CREDENCE_MAGNITUDE
  );
  const contestedForSourceBetaNodeId = await createBeliefDemoNode(
    'Belief demo source: contested for-side beta',
    'Scaffolding — the second believed source on the for side of the contested exemplar.'
  );
  assertBeliefDemoFixedCredence(
    contestedForSourceBetaNodeId,
    BELIEF_DEMO_CONTESTED_SOURCE_CREDENCE_MAGNITUDE
  );
  const contestedAgainstSourceAlphaNodeId = await createBeliefDemoNode(
    'Belief demo source: contested against-side alpha',
    'Scaffolding — one of two disbelieved sources on the against side of the contested exemplar.'
  );
  assertBeliefDemoFixedCredence(
    contestedAgainstSourceAlphaNodeId,
    -BELIEF_DEMO_CONTESTED_SOURCE_CREDENCE_MAGNITUDE
  );
  const contestedAgainstSourceBetaNodeId = await createBeliefDemoNode(
    'Belief demo source: contested against-side beta',
    'Scaffolding — the second disbelieved source on the against side of the contested exemplar.'
  );
  assertBeliefDemoFixedCredence(
    contestedAgainstSourceBetaNodeId,
    -BELIEF_DEMO_CONTESTED_SOURCE_CREDENCE_MAGNITUDE
  );

  // ---- exemplar 2: the believed node --------------------------------------
  // Three supporting evidence edges (anchor + both corroborators) push the
  // total mass past the prior mass of 2, so the ring is solid.
  const believedNodeId = await createBeliefDemoNode(
    'Belief demo: believed',
    'Exemplar 2 — engine-graded for on three supporting evidence edges; solid ring.'
  );
  await createBeliefDemoEvidenceEdge({
    derivedNodeId: believedNodeId,
    sourceNodeId: fixedAnchorNodeId,
    support: BELIEF_DEMO_SUPPORTING_EDGE_SUPPORT,
    explanation: 'The believed exemplar derives its credence strongly from the fixed anchor.',
  });
  await createBeliefDemoEvidenceEdge({
    derivedNodeId: believedNodeId,
    sourceNodeId: supportingSourceAlphaNodeId,
    support: BELIEF_DEMO_SUPPORTING_EDGE_SUPPORT,
    explanation: 'The believed exemplar derives its credence strongly from corroborator alpha.',
  });
  await createBeliefDemoEvidenceEdge({
    derivedNodeId: believedNodeId,
    sourceNodeId: supportingSourceBetaNodeId,
    support: BELIEF_DEMO_SUPPORTING_EDGE_SUPPORT,
    explanation: 'The believed exemplar derives its credence strongly from corroborator beta.',
  });

  // ---- exemplar 3: the disbelieved node -----------------------------------
  // Evidence from the negatively-fixed source grades the node below zero.
  const disbelievedNodeId = await createBeliefDemoNode(
    'Belief demo: disbelieved',
    'Exemplar 3 — engine-graded against on evidence from a disbelieved source.'
  );
  await createBeliefDemoEvidenceEdge({
    derivedNodeId: disbelievedNodeId,
    sourceNodeId: disbelievedSourceNodeId,
    support: BELIEF_DEMO_DISBELIEVED_EDGE_SUPPORT,
    explanation: 'The disbelieved exemplar derives its credence solely from the discredited origin.',
  });

  // ---- exemplar 4: the contested node -------------------------------------
  // Two heavy edges each way: masses 1.8 for and 1.8 against, credence
  // exactly 0 by symmetric cancellation, uncertainty ~0.36 — neutral, solid.
  const contestedNodeId = await createBeliefDemoNode(
    'Belief demo: contested',
    'Exemplar 4 — engine-graded neutral on balanced heavy evidence both ways; solid ring.'
  );
  await createBeliefDemoEvidenceEdge({
    derivedNodeId: contestedNodeId,
    sourceNodeId: contestedForSourceAlphaNodeId,
    support: BELIEF_DEMO_CONTESTED_EDGE_SUPPORT,
    explanation: 'The contested exemplar derives credence fully from for-side alpha.',
  });
  await createBeliefDemoEvidenceEdge({
    derivedNodeId: contestedNodeId,
    sourceNodeId: contestedForSourceBetaNodeId,
    support: BELIEF_DEMO_CONTESTED_EDGE_SUPPORT,
    explanation: 'The contested exemplar derives credence fully from for-side beta.',
  });
  await createBeliefDemoEvidenceEdge({
    derivedNodeId: contestedNodeId,
    sourceNodeId: contestedAgainstSourceAlphaNodeId,
    support: BELIEF_DEMO_CONTESTED_EDGE_SUPPORT,
    explanation: 'The contested exemplar derives credence fully from against-side alpha.',
  });
  await createBeliefDemoEvidenceEdge({
    derivedNodeId: contestedNodeId,
    sourceNodeId: contestedAgainstSourceBetaNodeId,
    support: BELIEF_DEMO_CONTESTED_EDGE_SUPPORT,
    explanation: 'The contested exemplar derives credence fully from against-side beta.',
  });

  // ---- exemplar 5: the barely-assessed node -------------------------------
  // Exactly one weak edge: assessed, but on so little evidence the ring dashes.
  const barelyAssessedNodeId = await createBeliefDemoNode(
    'Belief demo: barely assessed',
    'Exemplar 5 — engine-graded on one weak evidence edge; dashed ring.'
  );
  await createBeliefDemoEvidenceEdge({
    derivedNodeId: barelyAssessedNodeId,
    sourceNodeId: fixedAnchorNodeId,
    support: BELIEF_DEMO_WEAK_EDGE_SUPPORT,
    explanation: 'The barely-assessed exemplar derives its credence faintly from the fixed anchor.',
  });

  // ---- exemplar 6: the ungraded node --------------------------------------
  // No evidence at all: credence and both masses stay NULL, no belief
  // treatment anywhere — the never-assessed state, not a zero.
  const ungradedNodeId = await createBeliefDemoNode(
    'Belief demo: ungraded',
    'Exemplar 6 — no evidence; the overlay must give it no belief treatment at all.'
  );

  return {
    fixedAnchorNodeId,
    believedNodeId,
    disbelievedNodeId,
    contestedNodeId,
    barelyAssessedNodeId,
    ungradedNodeId,
  };
}

// The thin CLI: read the target database path from the command line, hand it
// to seedBeliefDemoGraph, and report the six exemplar ids on success.
async function runBeliefDemoGraphSeedCli(): Promise<void> {
  // The target database path — the CLI's one argument.
  const cliDatabasePath = process.argv[2];
  if (!cliDatabasePath) {
    console.error('Usage: npx tsx scripts/seed-belief-demo-graph.ts <database-path>');
    process.exitCode = 1;
    return;
  }
  const seedResult = await seedBeliefDemoGraph(cliDatabasePath);
  // Close the client so the freshly-seeded file is checkpointed and whole.
  const { getSQLiteClient } = await import('@/services/database/sqlite-client');
  getSQLiteClient().close();
  console.log(`Seeded the belief demo graph into ${cliDatabasePath}:`, seedResult);
}

// Direct-execution guard: true only when this script file itself is the
// process entry point (process.argv[1]), so importing the module — as the
// tests do — never fires the CLI.
const beliefDemoSeedScriptIsProcessEntry = (() => {
  // The file node was told to execute; absent in embedded/import contexts.
  const processEntryPath = process.argv[1];
  if (!processEntryPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(processEntryPath)).href;
})();

if (beliefDemoSeedScriptIsProcessEntry) {
  runBeliefDemoGraphSeedCli().catch(cliSeedError => {
    console.error('belief demo graph seed failed:', cliSeedError);
    process.exitCode = 1;
  });
}
