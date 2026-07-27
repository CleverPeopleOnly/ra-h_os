/**
 * Source trust service — reads and writes the belief_source_trust table, which maps
 * an evidence origin key (carried in the from-node's metadata as
 * trustOriginKey) to a trust score used to weight that origin's evidence.
 */

import { getSQLiteClient } from '@/services/database/sqlite-client';

// Look up the trust score for an origin key; null when no row exists.
// (A null here means the origin is UNASSESSED — the belief engine excludes
// its evidence entirely rather than inventing a default trust weight.)
export async function getTrustScore(trustOriginKey: string): Promise<number | null> {
  // Single-row lookup by primary key; undefined when the origin is unknown.
  const trustRow = getSQLiteClient()
    .prepare('SELECT score FROM belief_source_trust WHERE trust_origin_key = ?')
    .get(trustOriginKey) as { score: number } | undefined;
  return trustRow ? trustRow.score : null;
}

// Insert or update the trust score for an origin key (single row per key).
export async function upsertTrustScore(trustOriginKey: string, score: number): Promise<void> {
  getSQLiteClient()
    .prepare(
      `INSERT INTO belief_source_trust (trust_origin_key, score, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(trust_origin_key) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`
    )
    .run(trustOriginKey, score, new Date().toISOString());
}
