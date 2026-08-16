/**
 * FAILING-FIRST red set for slice 9 — THE ENGINE AND BELIEF SERVICES LEAVE
 * THE FORK: the REST belief surface shrinks to the one display route.
 *
 * samai owns the belief engine, so the fork's REST surface keeps only the
 * door samai writes display beliefs through: app/api/belief/display. The
 * routes that asserted, withdrew, or replayed belief die with the services
 * behind them:
 *  - app/api/belief/fixed-credence/ (POST set),
 *  - app/api/belief/fixed-credence/clear/ (POST clear),
 *  - app/api/belief/movements/ (GET replay — its table is dropped too).
 *
 * These are existence pins over the route directories, mirroring
 * beliefRecoveryServiceRemoved.test.ts: a deleted route cannot be imported
 * to prove its absence, so the filesystem is the seam.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Absolute path of the belief REST route directory whose contents this file pins.
const beliefApiDirectoryPath = path.join(process.cwd(), 'app', 'api', 'belief');

// The route directories deleted with the engine, relative to app/api/belief.
// fixed-credence/clear is listed before its parent so a failure names the
// nested door even when only the parent listing is checked by eye.
const deletedBeliefRouteDirectoryRelativePaths = [
  'fixed-credence/clear',
  'fixed-credence',
  'movements',
];

describe('the belief REST surface is reduced to the display route', () => {
  // The headline pin: app/api/belief holds EXACTLY the display route and the
  // fixed route (the hand-assertion pair, added by the fixed-credence slice
  // under NEW paths — fixed/ and fixed/clear/ — while the engine-era
  // fixed-credence/ directories above stay dead). An exact listing stops any
  // renamed belief route sneaking back in beside them.
  it('app/api/belief contains only the display and fixed route directories', () => {
    const actualBeliefRouteEntries = fs.readdirSync(beliefApiDirectoryPath).sort();
    expect(
      actualBeliefRouteEntries,
      'app/api/belief must hold only display/ and fixed/ — the other belief doors die with the engine'
    ).toEqual(['display', 'fixed']);
  });

  // Per-directory absence pins: when the listing above fails, these say WHICH
  // dead route directory is still on disk.
  for (const deletedRouteRelativePath of deletedBeliefRouteDirectoryRelativePaths) {
    it(`app/api/belief/${deletedRouteRelativePath} no longer exists`, () => {
      const deletedRouteDirectoryPath = path.join(beliefApiDirectoryPath, deletedRouteRelativePath);
      expect(
        fs.existsSync(deletedRouteDirectoryPath),
        `${deletedRouteDirectoryPath} must be deleted with the belief services behind it`
      ).toBe(false);
    });
  }
});
