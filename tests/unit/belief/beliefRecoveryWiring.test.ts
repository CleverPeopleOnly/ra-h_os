/**
 * MR-B wiring pin for the belief recovery sweep.
 *
 * Seam chosen: AutoEmbedQueue.recoverStuckNodes. The app's only startup
 * recovery entry point is instrumentation.ts -> startAutoEmbedRecovery(),
 * which calls autoEmbedQueue.recoverStuckNodes() immediately and then every
 * 60 seconds. Wiring recoverUngradedEvidence into recoverStuckNodes gives
 * the belief sweep exactly the recovery cadence the embed sweep already has
 * (startup + periodic), with no new startup plumbing — and it is testable
 * without booting the Next runtime.
 *
 * This lives in its own file (not beliefRecovery.test.ts) because vi.mock is
 * file-scoped: here the recovery service is a spy, while beliefRecovery.test.ts
 * exercises the real one.
 *
 * Runs against a fresh temp-file database (see tempBeliefDatabase.ts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// Replace the embedding pipeline so any node the recovery pass enqueues can
// never trigger real embedding work.
vi.mock('@/services/embedding/ingestion', () => ({
  embedNodeContent: vi.fn(async () => ({ success: true })),
}));

// Replace the belief recovery service with a spy so the test can observe
// whether recoverStuckNodes triggers the sweep.
vi.mock('@/services/belief/beliefRecoveryService', () => ({
  recoverUngradedEvidence: vi.fn(async () => ({ regradedNodeIds: [] })),
}));

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('belief recovery wiring (MR-B)', () => {
  // The pinned behavior: the app startup recovery pass
  // (AutoEmbedQueue.recoverStuckNodes) must also trigger the belief
  // recovery sweep, so offline standalone evidence writes get graded when
  // the app comes back up.
  it('AutoEmbedQueue.recoverStuckNodes triggers recoverUngradedEvidence', async () => {
    db = await openTempBeliefDatabase();

    // Import through the current database generation so the mock above is
    // what the queue module would resolve.
    const beliefRecoveryModule = await import('@/services/belief/beliefRecoveryService');
    const { AutoEmbedQueue } = await db.importAutoEmbedQueueModule();

    const queue = new AutoEmbedQueue();
    await queue.recoverStuckNodes();

    expect(vi.mocked(beliefRecoveryModule.recoverUngradedEvidence)).toHaveBeenCalledTimes(1);
  });
});
