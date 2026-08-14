/**
 * FAILING-FIRST tests for the evidence-leaves-the-edges-table slice: THE
 * BELIEF RECOVERY SERVICE IS GONE.
 *
 * src/services/belief/beliefRecoveryService.ts existed solely to find edges
 * whose belief_evidence_contribution stamp was NULL or stale and regrade
 * their derived nodes. Its column is leaving the edges table with this slice,
 * so the service has nothing left to detect: the module goes, and the startup
 * path (the auto-embed queue's recoverStuckNodes) stops invoking any belief
 * recovery sweep.
 *
 * These are existence pins over the repo's own files — the one place a
 * deleted module can be pinned without importing it (an import of a deleted
 * module is a compile error, not a test failure).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Absolute path the recovery service module lived at.
const beliefRecoveryServiceModulePath = path.join(
  process.cwd(),
  'src',
  'services',
  'belief',
  'beliefRecoveryService.ts'
);

// Absolute path of the startup queue that used to run the sweep.
const autoEmbedQueueModulePath = path.join(
  process.cwd(),
  'src',
  'services',
  'embedding',
  'autoEmbedQueue.ts'
);

describe('belief recovery service removed', () => {
  // The module itself is deleted, not emptied: an evidence-stamp sweep with
  // no stamp column to sweep is dead code, and dead code goes.
  it('the beliefRecoveryService module no longer exists', () => {
    expect(
      fs.existsSync(beliefRecoveryServiceModulePath),
      `${beliefRecoveryServiceModulePath} must be deleted with its column`
    ).toBe(false);
  });

  // The startup invocation goes with it: recoverStuckNodes must no longer
  // run any belief recovery sweep. Pinned over the module's source text
  // because the sweep call was fire-and-forget inside a catch — invisible to
  // any behavioural probe once the module it called is gone.
  it('the auto-embed queue no longer invokes a belief recovery sweep at startup', () => {
    const autoEmbedQueueSourceText = fs.readFileSync(autoEmbedQueueModulePath, 'utf8');
    expect(
      autoEmbedQueueSourceText,
      'autoEmbedQueue must not import or call the deleted belief recovery sweep'
    ).not.toMatch(/beliefRecovery|runBeliefRecoverySweep/i);
  });
});
