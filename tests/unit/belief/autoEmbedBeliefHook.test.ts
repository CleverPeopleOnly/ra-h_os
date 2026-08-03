/**
 * Test for the AutoEmbedQueue belief hook (MR-A).
 *
 * Pins that after a node's embed task completes, the queue triggers
 * recomputeNodeBelief(nodeId). The queue is exercised for real (a fresh
 * AutoEmbedQueue instance over a temp-file database); only the two module
 * boundaries are mocked:
 *  - '@/services/embedding/ingestion' so no real embedding work runs,
 *  - '@/services/belief/beliefService' so the recompute call is observable.
 *
 * Runs against a fresh temp-file database (see tempBeliefDatabase.ts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// Replace the real embedding pipeline with an instantly-successful stub so
// executeTask reaches its completion path without network or vector work.
vi.mock('@/services/embedding/ingestion', () => ({
  embedNodeContent: vi.fn(async () => ({ success: true })),
}));

// Replace the belief service with a spy so the test can observe whether the
// queue's post-embed hook invokes the recompute.
vi.mock('@/services/belief/beliefService', () => ({
  recomputeNodeBelief: vi.fn(async () => ({
    // EDITED from beliefValue: the recompute result names the graded
    // quantity, and that quantity is credence.
    beliefCredence: null,
    movement: null,
    contributions: [],
  })),
}));

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('AutoEmbedQueue belief hook', () => {
  // After the embed task for a node completes, the queue must call
  // recomputeNodeBelief(nodeId).
  it('recomputes the node belief after the embed task completes', async () => {
    db = await openTempBeliefDatabase();
    const nodeId = db.insertNodeFixture({ title: 'freshly captured node' });

    // Import through the helper so all modules bind to this database
    // generation; the mocks above still apply to these imports.
    const ingestionModule = await db.importIngestionModule();
    const beliefServiceModule = await db.importBeliefService();
    const { AutoEmbedQueue } = await db.importAutoEmbedQueueModule();

    const queue = new AutoEmbedQueue();
    queue.enqueue(nodeId, { force: true, reason: 'belief-hook-test' });

    // First confirm the embed pass itself ran, so a failure below clearly
    // means "the belief hook is missing", not "the queue never executed".
    await vi.waitFor(
      () => {
        expect(vi.mocked(ingestionModule.embedNodeContent)).toHaveBeenCalledWith(nodeId);
      },
      { timeout: 2000, interval: 25 }
    );

    // The pinned behavior: the completed embed task triggers the recompute.
    // EDITED per Reviewer ruling 8 (belief model v2 §5): the queue now names
    // its entry point, so the call carries the 'embed-grade' trigger beside
    // the node id.
    await vi.waitFor(
      () => {
        expect(vi.mocked(beliefServiceModule.recomputeNodeBelief)).toHaveBeenCalledWith(
          nodeId,
          'embed-grade'
        );
      },
      { timeout: 2000, interval: 25 }
    );
  });
});
