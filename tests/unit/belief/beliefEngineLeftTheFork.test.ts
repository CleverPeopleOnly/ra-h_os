/**
 * FAILING-FIRST red set for slice 9 — THE ENGINE AND BELIEF SERVICES LEAVE
 * THE FORK: the src/services/belief directory keeps ONLY the display surface.
 *
 * The belief math lives in samai-diagnostic now. What the fork keeps of the
 * belief system is presentation and plumbing: the display-belief write, the
 * SQL fragment and presentation helpers the map UI reads through, and the
 * node-read halves of the MCP tool contract. Everything that computed,
 * asserted, or replayed belief is deleted:
 *  - beliefGradingPolicy.ts — the math module (samai owns the engine),
 *  - beliefFixedCredence.ts — the set/clear machinery behind the dead
 *    fixed-credence doors,
 *  - beliefMovements.ts — the movements read over a table this slice drops,
 *  - beliefService.ts — a type-only stub nothing imports for behaviour.
 *
 * These are existence pins over the repo's own files — the one place a
 * deleted module can be pinned without importing it (an import of a deleted
 * module is a compile error, not a test failure), mirroring
 * beliefRecoveryServiceRemoved.test.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Absolute path of the belief services directory whose contents this file pins.
const beliefServicesDirectoryPath = path.join(process.cwd(), 'src', 'services', 'belief');

// The COMPLETE list of files allowed to remain in src/services/belief after
// the deletion — the display surface and the contract halves the map UI and
// the display write still import. Sorted, because the exact-listing assertion
// compares sorted directory contents against it.
const survivingBeliefServiceFileNames = [
  'beliefDisplayWrite.ts',
  'beliefMcpToolContract.d.ts',
  'beliefMcpToolContract.js',
  'beliefNodeReadColumnsSql.ts',
  'beliefPresentation.ts',
].sort();

// The four deleted modules, each pinned individually below so a failure names
// the exact straggler rather than only reporting a mismatched listing.
const deletedBeliefServiceFileNames = [
  'beliefGradingPolicy.ts',
  'beliefFixedCredence.ts',
  'beliefMovements.ts',
  'beliefService.ts',
];

describe('the engine and belief services left the fork', () => {
  // The headline pin: the directory contains EXACTLY the display-surface
  // survivors and nothing else. An exact listing (not just absences) is what
  // stops a renamed or freshly-added engine module slipping back in unseen.
  it('src/services/belief contains exactly the display-surface survivors', () => {
    const actualBeliefServiceFileNames = fs.readdirSync(beliefServicesDirectoryPath).sort();
    expect(
      actualBeliefServiceFileNames,
      'src/services/belief must hold only the display surface — the engine lives in samai now'
    ).toEqual(survivingBeliefServiceFileNames);
  });

  // Per-file absence pins: when the listing above fails, these say WHICH of
  // the four doomed modules is still on disk.
  for (const deletedBeliefServiceFileName of deletedBeliefServiceFileNames) {
    it(`${deletedBeliefServiceFileName} no longer exists`, () => {
      const deletedModulePath = path.join(beliefServicesDirectoryPath, deletedBeliefServiceFileName);
      expect(
        fs.existsSync(deletedModulePath),
        `${deletedModulePath} must be deleted — samai owns the belief math now`
      ).toBe(false);
    });
  }
});
