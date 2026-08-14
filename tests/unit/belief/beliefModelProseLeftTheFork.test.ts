/**
 * FAILING-FIRST red set for slice 9 — THE ENGINE AND BELIEF SERVICES LEAVE
 * THE FORK: the prose and tooling that described a fork-native engine go
 * with the code.
 *
 * Three pins, one per artefact:
 *  - docs/belief-model-subjective-logic.md is deleted — the model's figures
 *    and derivations live in samai now, and a stale copy here would drift
 *    from the engine that actually runs;
 *  - package.json's lint:belief-surface script stops naming any deleted
 *    module or test (the doomed basenames), and everything it still names
 *    must exist on disk — a lint script over ghosts fails every run;
 *  - the fork's CLAUDE.md stops citing the dead identifiers
 *    recomputeNodeBelief and belief_evidence_support as if a native engine
 *    still lived here — instructions that name deleted code teach the next
 *    session a world that no longer exists.
 *
 * These are text pins over the repo's own files, mirroring
 * beliefRecoveryServiceRemoved.test.ts's technique.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Absolute path of the deleted belief-model document.
const beliefModelDocumentPath = path.join(process.cwd(), 'docs', 'belief-model-subjective-logic.md');

// Absolute path of the repo's package.json, whose lint:belief-surface script
// enumerates the belief surface for lint.
const packageJsonPath = path.join(process.cwd(), 'package.json');

// Absolute path of the fork's own CLAUDE.md instructions file.
const forkClaudeMdPath = path.join(process.cwd(), 'CLAUDE.md');

// The basenames of modules and tests deleted with the engine. None of them
// may appear anywhere in the lint script string once the deletion lands —
// a path token containing one names a deleted file.
const doomedLintScriptBasenames = [
  'beliefGradingPolicy',
  'beliefFixedCredence',
  'beliefMovements',
  'beliefService.ts',
];

// The two identifiers the fork's CLAUDE.md still cites as examples of the
// native engine's naming rules. Both are dead once the engine leaves:
// recomputeNodeBelief was the engine's entry point, and
// belief_evidence_support was the evidence column that already left the
// edges table.
const deadClaudeMdIdentifiers = ['recomputeNodeBelief', 'belief_evidence_support'];

// Read the lint:belief-surface script string out of package.json, failing
// loudly if the script itself has vanished — the survivors still need lint.
function readLintBeliefSurfaceScript(): string {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const lintScript = packageJson.scripts?.['lint:belief-surface'];
  expect(lintScript, 'the lint:belief-surface script must still exist for the survivors').toBeTruthy();
  return String(lintScript);
}

describe('the belief-model prose and tooling leave the fork', () => {
  // The document itself is deleted, not truncated: samai owns the model and
  // its write-up, and a fork copy would silently drift.
  it('docs/belief-model-subjective-logic.md no longer exists', () => {
    expect(
      fs.existsSync(beliefModelDocumentPath),
      `${beliefModelDocumentPath} must be deleted — the model prose lives in samai now`
    ).toBe(false);
  });

  // The lint script sheds every doomed name and enumerates only living
  // files. The basename check is what goes red today (the script still
  // names the fixed-credence and movements tests); the exists-on-disk sweep
  // is the guard that keeps the script honest after the deletion.
  it('lint:belief-surface names no doomed basename, and every path it names exists', () => {
    const lintBeliefSurfaceScript = readLintBeliefSurfaceScript();

    // No deleted module or test may be named, under any path.
    for (const doomedBasename of doomedLintScriptBasenames) {
      expect(
        lintBeliefSurfaceScript,
        `lint:belief-surface must stop naming ${doomedBasename} — that file dies with the engine`
      ).not.toContain(doomedBasename);
    }

    // Everything still enumerated must exist on disk: the first token is the
    // eslint binary, every following token is a path to lint.
    const enumeratedLintPaths = lintBeliefSurfaceScript.split(/\s+/).slice(1);
    expect(enumeratedLintPaths.length, 'the script must still enumerate the survivors').toBeGreaterThan(0);
    for (const enumeratedLintPath of enumeratedLintPaths) {
      expect(
        fs.existsSync(path.join(process.cwd(), enumeratedLintPath)),
        `lint:belief-surface names ${enumeratedLintPath}, which does not exist on disk`
      ).toBe(true);
    }
  });

  // The fork's instructions stop describing a native engine: neither dead
  // identifier may appear anywhere in CLAUDE.md once the engine is gone.
  it('CLAUDE.md no longer cites recomputeNodeBelief or belief_evidence_support', () => {
    const forkClaudeMdText = fs.readFileSync(forkClaudeMdPath, 'utf8');
    for (const deadIdentifier of deadClaudeMdIdentifiers) {
      expect(
        forkClaudeMdText,
        `CLAUDE.md must stop citing ${deadIdentifier} — it names code this slice deletes`
      ).not.toContain(deadIdentifier);
    }
  });
});
