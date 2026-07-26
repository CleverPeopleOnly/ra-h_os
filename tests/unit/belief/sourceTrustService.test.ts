/**
 * Tests for sourceTrustService — the read/write API over the source_trust
 * table (trust_origin_key -> trust score). Runs against a fresh temp-file database
 * per test (see tempBeliefDatabase.ts for the safety seam).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from './helpers/tempBeliefDatabase';

// The database context under test; opened per test, closed after each.
let db: TempBeliefDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('sourceTrustService', () => {
  // Round trip: a score written with upsertTrustScore must come back
  // unchanged from getTrustScore.
  it('returns the score that was upserted for an origin key', async () => {
    db = await openTempBeliefDatabase();
    const { getTrustScore, upsertTrustScore } = await db.importSourceTrustService();

    await upsertTrustScore('origin-round-trip', 0.7);

    expect(await getTrustScore('origin-round-trip')).toBeCloseTo(0.7, 10);
  });

  // Unknown origins are a real state: the lookup must report null, not a
  // default — the DEFAULT_ORIGIN_TRUST fallback belongs to the belief
  // engine, not to this service.
  it('returns null for an origin key with no source_trust row', async () => {
    db = await openTempBeliefDatabase();
    const { getTrustScore } = await db.importSourceTrustService();

    expect(await getTrustScore('origin-never-seen')).toBeNull();
  });

  // Upsert means update-in-place: a second write for the same key must
  // replace the score and keep a single row.
  it('updates the existing row (single row per origin key) on a second upsert', async () => {
    db = await openTempBeliefDatabase();
    const { getTrustScore, upsertTrustScore } = await db.importSourceTrustService();

    await upsertTrustScore('origin-updated', 0.2);
    await upsertTrustScore('origin-updated', 0.9);

    expect(await getTrustScore('origin-updated')).toBeCloseTo(0.9, 10);
    const rowCount = db.sqlite
      .prepare('SELECT COUNT(*) AS count FROM source_trust WHERE trust_origin_key = ?')
      .get('origin-updated') as { count: number };
    expect(rowCount.count).toBe(1);
  });
});
