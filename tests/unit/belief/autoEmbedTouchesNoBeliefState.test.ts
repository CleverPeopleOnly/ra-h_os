/**
 * The auto-embed queue touches NO belief state after the display-belief
 * slice: the post-embed belief hook dies with the recompute surface, because
 * a hook that writes never-assessed would erase the display beliefs samai
 * writes through the remote door. Completing an embed for a node must leave
 * the node's belief columns byte-unchanged.
 *
 * Went red when AutoEmbedQueue.executeTask still ran the engine's post-embed
 * belief hook after a successful embed, which wrote the node never-assessed —
 * the seeded credence 0.62 became NULL and the before/after snapshot
 * differed. Green since the hook died with the recompute surface.
 *
 * The queue is exercised for real (a fresh AutoEmbedQueue instance over a
 * temp-file database) with the REAL belief service in place — only
 * '@/services/embedding/ingestion' is mocked, so no embedding work runs but
 * whatever the queue does to belief state actually lands in the file.
 *
 * The snapshot tolerates BOTH schemas: it reads whichever of the four
 * display-belief columns (belief_credence, belief_uncertainty,
 * belief_computed_at, belief_credence_is_fixed) the nodes table actually
 * has, so the test fails for the HOOK's write — never for a missing column —
 * and keeps guarding after the schema slice lands.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// Replace the real embedding pipeline with an instantly-successful stub so
// executeTask reaches its completion path — and therefore the point where the
// removed belief hook used to run — without network or vector work. The
// belief service is deliberately NOT mocked: this file pins what actually
// lands in the database.
vi.mock('@/services/embedding/ingestion', () => ({
  embedNodeContent: vi.fn(async () => ({ success: true })),
}));

// The four display-belief columns as they stand after the slice; the
// snapshot below reads whichever of them the open database actually has.
const displayBeliefColumnNames = [
  'belief_credence',
  'belief_uncertainty',
  'belief_computed_at',
  'belief_credence_is_fixed',
] as const;

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// One node's full belief state as stored: every present display column —
// since the belief_movements table left the schema, the four display columns
// are ALL the belief state there is for an embed to leave alone.
interface NodeBeliefStateSnapshot {
  presentDisplayColumns: Record<string, unknown>;
}

// Snapshot one node's belief state, tolerating both the pre- and post-slice
// nodes schema by selecting only the display columns that exist.
function snapshotNodeBeliefState(
  context: TempBeliefDatabase,
  nodeId: number
): NodeBeliefStateSnapshot {
  // The display columns actually present on this database's nodes table.
  const presentColumnNames = context
    .readTableColumns('nodes')
    .map(column => column.name)
    .filter(columnName =>
      (displayBeliefColumnNames as readonly string[]).includes(columnName)
    );
  const presentDisplayColumns = context.sqlite
    .prepare(`SELECT ${presentColumnNames.join(', ')} FROM nodes WHERE id = ?`)
    .get(nodeId) as Record<string, unknown>;
  return {
    presentDisplayColumns,
  };
}

describe('AutoEmbedQueue touches no belief state', () => {
  // The whole pin in one pass: a graded node's belief columns are
  // byte-identical before and after its embed task completes — no regrade
  // and no never-assessed write.
  it('completing an embed leaves the node\'s belief columns byte-unchanged', async () => {
    db = await openTempBeliefDatabase();
    // A GRADED node, so the old hook's never-assessed write is visible: a
    // credence that survives is the proof, a credence nulled is the red.
    const gradedNodeId = db.insertNodeFixture({
      title: 'Graded node awaiting an embed',
      beliefCredence: 0.62,
    });

    // The belief state the embed must not touch.
    const beliefStateBeforeEmbed = snapshotNodeBeliefState(db, gradedNodeId);

    // Import through the helper so all modules bind to this database
    // generation; the ingestion mock above still applies.
    const ingestionModule = await db.importIngestionModule();
    const { AutoEmbedQueue } = await db.importAutoEmbedQueueModule();

    const queue = new AutoEmbedQueue();
    queue.enqueue(gradedNodeId, { force: true, reason: 'no-belief-touch-test' });

    // First confirm the embed pass itself ran, so a snapshot equality below
    // can never be a vacuous "the queue never executed".
    await vi.waitFor(
      () => {
        expect(vi.mocked(ingestionModule.embedNodeContent)).toHaveBeenCalledWith(gradedNodeId);
      },
      { timeout: 2000, interval: 25 }
    );

    // Then wait for the task to actually FINISH: everything executeTask does
    // after the embed (today: the belief hook) runs before the queue clears
    // the node from its running set. The set is private to the class, so the
    // wait reads it through a test-only cast.
    await vi.waitFor(
      () => {
        const runningNodeIds = (queue as unknown as { running: Set<number> }).running;
        expect(runningNodeIds.size).toBe(0);
      },
      { timeout: 2000, interval: 25 }
    );

    // The pinned behaviour: byte-unchanged belief state — the seeded
    // credence survives.
    const beliefStateAfterEmbed = snapshotNodeBeliefState(db, gradedNodeId);
    expect(beliefStateAfterEmbed).toEqual(beliefStateBeforeEmbed);
  });
});
