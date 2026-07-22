/**
 * Source trust service — reads and writes the source_trust table, which maps
 * an evidence origin key (carried in the from-node's metadata as
 * trustOriginKey) to a trust score used to weight that origin's evidence.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';

// Look up the trust score for an origin key; null when no row exists.
// (The DEFAULT_ORIGIN_TRUST fallback belongs to the belief engine, not here.)
export async function getTrustScore(originKey: string): Promise<number | null> {
  // Single-row lookup by primary key; undefined when the origin is unknown.
  const trustRow = getSQLiteClient()
    .prepare('SELECT score FROM source_trust WHERE origin_key = ?')
    .get(originKey) as { score: number } | undefined;
  return trustRow ? trustRow.score : null;
}

// Insert or update the trust score for an origin key (single row per key).
export async function upsertTrustScore(originKey: string, score: number): Promise<void> {
  getSQLiteClient()
    .prepare(
      `INSERT INTO source_trust (origin_key, score, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(origin_key) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`
    )
    .run(originKey, score, new Date().toISOString());
}
