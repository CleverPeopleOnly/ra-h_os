/**
 * Spec for getEmbeddingProviderInfo() with EMBEDDING_PROFILE=voyage.
 *
 * Voyage AI is a first-class embedding profile: it needs no base URL (the
 * endpoint is fixed at https://api.voyageai.com/v1/embeddings), defaults to
 * model voyage-4-large, and defaults to 1024 dimensions so it drops straight
 * into the existing 1024-dim sqlite-vec tables.
 *
 * RED expectation while unimplemented: normalizeProfile() collapses 'voyage'
 * to 'openai', so every profile assertion below fails.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEmbeddingProviderInfo } from '@/services/embedding/provider';

afterEach(() => {
  vi.unstubAllEnvs();
});

// Remove every embedding-related env override so each test starts from a
// clean slate and only sets what it is specifying.
function clearEmbeddingEnv(): void {
  delete process.env.EMBEDDING_PROFILE;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.EMBEDDING_BASE_URL;
}

describe('getEmbeddingProviderInfo with EMBEDDING_PROFILE=voyage', () => {
  // The voyage profile must be recognised as its own profile (not collapsed
  // to 'openai') and must supply Voyage's defaults: model voyage-4-large and
  // 1024 dimensions matching the existing sqlite-vec tables.
  it('returns the voyage profile with voyage-4-large and 1024 dimensions by default', () => {
    clearEmbeddingEnv();
    vi.stubEnv('EMBEDDING_PROFILE', 'voyage');

    const voyageProviderInfo = getEmbeddingProviderInfo();

    expect(voyageProviderInfo.profile).toBe('voyage');
    expect(voyageProviderInfo.model).toBe('voyage-4-large');
    expect(voyageProviderInfo.dimensions).toBe(1024);
  });

  // Voyage's endpoint is fixed, so unlike openai-compatible the profile must
  // not require or report a base URL — and must not throw when none is set.
  it('needs no EMBEDDING_BASE_URL and reports no baseUrl', () => {
    clearEmbeddingEnv();
    vi.stubEnv('EMBEDDING_PROFILE', 'voyage');

    const voyageProviderInfo = getEmbeddingProviderInfo();

    expect(voyageProviderInfo.profile).toBe('voyage');
    expect(voyageProviderInfo.baseUrl).toBeUndefined();
  });

  // Explicit EMBEDDING_MODEL and EMBEDDING_DIMENSIONS overrides must win over
  // the voyage defaults, mirroring how the openai profile treats them.
  it('honours EMBEDDING_MODEL and EMBEDDING_DIMENSIONS overrides', () => {
    clearEmbeddingEnv();
    vi.stubEnv('EMBEDDING_PROFILE', 'voyage');
    vi.stubEnv('EMBEDDING_MODEL', 'voyage-3.5-lite');
    vi.stubEnv('EMBEDDING_DIMENSIONS', '2048');

    const voyageProviderInfo = getEmbeddingProviderInfo();

    expect(voyageProviderInfo.profile).toBe('voyage');
    expect(voyageProviderInfo.model).toBe('voyage-3.5-lite');
    expect(voyageProviderInfo.dimensions).toBe(2048);
  });
});
