/**
 * Spec for createEmbeddingProvider() with EMBEDDING_PROFILE=voyage.
 *
 * Facts fixed by a live spike against the real Voyage API:
 *   - Endpoint: POST https://api.voyageai.com/v1/embeddings with
 *     `Authorization: Bearer <key>` and a JSON body.
 *   - Voyage's body parameters are { model, input, output_dimension }.
 *     It REJECTS OpenAI's names: `dimensions` -> HTTP 400 "not supported",
 *     `encoding_format: 'float'` -> HTTP 400 (only 'base64' accepted).
 *     The voyage branch therefore must use global fetch, NOT the openai SDK.
 *   - Success shape: { object: 'list', data: [{ object: 'embedding',
 *     embedding: number[], index: 0 }], model, usage: { total_tokens } }.
 *
 * RED expectation while unimplemented: 'voyage' normalises to the openai
 * profile, which reads the workspace `.env.local` (no OPENAI_API_KEY there)
 * and throws before fetch is ever called — so every test fails without any
 * network traffic.
 */

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createEmbeddingProvider } from '@/services/embedding/provider';
import {
  openTempEnvLocalWorkspace,
  type TempEnvLocalWorkspace,
} from './helpers/tempEnvLocalWorkspace';

// The Voyage key used across these tests. Voyage keys start with 'pa-'
// (never 'sk-'), so any leftover sk- assumptions would break on it.
const TEST_VOYAGE_API_KEY = 'pa-test-voyage-key-1234567890';

// A 1024-dim vector matching the voyage profile's default dimensions.
const VOYAGE_SIZED_EMBEDDING_VECTOR = Array.from({ length: 1024 }, (_, index) => index / 1024);

// A success payload in the exact shape the live Voyage API returns.
const VOYAGE_SUCCESS_RESPONSE_JSON = {
  object: 'list',
  data: [{ object: 'embedding', embedding: VOYAGE_SIZED_EMBEDDING_VECTOR, index: 0 }],
  model: 'voyage-4-large',
  usage: { total_tokens: 7 },
};

// The workspace whose `.env.local` supplies the Voyage key; cleaned per test.
let workspace: TempEnvLocalWorkspace | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  workspace?.cleanup();
  workspace = undefined;
});

// Configure the voyage profile with defaults and make TEST_VOYAGE_API_KEY
// available BOTH as a process env var and as a `.env.local` line (same value),
// so the tests pin behaviour, not which of the two sources the provider reads.
function stubVoyageProfileWithKey(): void {
  workspace = openTempEnvLocalWorkspace(`VOYAGE_API_KEY=${TEST_VOYAGE_API_KEY}\n`);
  vi.stubEnv('EMBEDDING_PROFILE', 'voyage');
  vi.stubEnv('VOYAGE_API_KEY', TEST_VOYAGE_API_KEY);
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.EMBEDDING_BASE_URL;
}

// Replace global fetch with a stub resolving to the given Response (or
// rejecting with the given Error) and return the mock for call inspection.
function stubGlobalFetch(outcome: Response | Error): Mock {
  const fetchStub = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

// Build a Response carrying the given JSON body and status.
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Pull the single recorded fetch call apart into url / headers / parsed body,
// normalising however the provider chose to pass headers.
function readSingleFetchCall(fetchStub: Mock): {
  requestUrl: string;
  requestHeaders: Headers;
  requestBodyJson: Record<string, unknown>;
} {
  expect(fetchStub).toHaveBeenCalledTimes(1);
  const [rawUrl, rawInit] = fetchStub.mock.calls[0] as [
    string | URL,
    RequestInit | undefined,
  ];
  return {
    requestUrl: String(rawUrl),
    requestHeaders: new Headers(rawInit?.headers),
    requestBodyJson: JSON.parse(String(rawInit?.body)) as Record<string, unknown>,
  };
}

describe('createEmbeddingProvider voyage generateEmbedding', () => {
  // The core contract: a POST to the fixed Voyage endpoint, bearer-authed,
  // with Voyage's own parameter names, input trimmed, and the returned
  // vector handed back unchanged.
  it('POSTs { model, input, output_dimension } to the Voyage endpoint and returns data[0].embedding', async () => {
    stubVoyageProfileWithKey();
    const fetchStub = stubGlobalFetch(jsonResponse(VOYAGE_SUCCESS_RESPONSE_JSON, 200));

    const voyageProvider = createEmbeddingProvider();
    // Padded input proves the provider trims before sending.
    const generatedEmbedding = await voyageProvider.generateEmbedding('  what is credence?  ');

    const { requestUrl, requestHeaders, requestBodyJson } = readSingleFetchCall(fetchStub);

    expect(requestUrl).toBe('https://api.voyageai.com/v1/embeddings');
    expect(requestHeaders.get('authorization')).toBe(`Bearer ${TEST_VOYAGE_API_KEY}`);
    expect(requestBodyJson.model).toBe('voyage-4-large');
    // Voyage accepts a single string or an array of strings; either trimmed
    // form satisfies the spec.
    expect(['what is credence?', ['what is credence?']]).toContainEqual(requestBodyJson.input);
    expect(requestBodyJson.output_dimension).toBe(1024);
    expect(generatedEmbedding).toEqual(VOYAGE_SIZED_EMBEDDING_VECTOR);
  });

  // Voyage rejects OpenAI's parameter names with HTTP 400, so the request
  // body must never contain `dimensions` or `encoding_format`.
  it('never sends the OpenAI parameter names dimensions or encoding_format', async () => {
    stubVoyageProfileWithKey();
    const fetchStub = stubGlobalFetch(jsonResponse(VOYAGE_SUCCESS_RESPONSE_JSON, 200));

    const voyageProvider = createEmbeddingProvider();
    await voyageProvider.generateEmbedding('parameter-name check');

    const { requestBodyJson } = readSingleFetchCall(fetchStub);

    expect('dimensions' in requestBodyJson).toBe(false);
    expect('encoding_format' in requestBodyJson).toBe(false);
  });

  // A non-2xx Voyage response must surface as a thrown Error carrying both
  // the HTTP status and Voyage's `detail` message, so the user sees what
  // Voyage actually complained about.
  it("throws an Error carrying the HTTP status and Voyage's detail on non-2xx", async () => {
    stubVoyageProfileWithKey();
    // Real shape of a Voyage 400 rejection body.
    const voyageRejectionDetail = 'dimensions is not a supported parameter';
    stubGlobalFetch(jsonResponse({ detail: voyageRejectionDetail }, 400));

    const voyageProvider = createEmbeddingProvider();

    await expect(voyageProvider.generateEmbedding('bad request')).rejects.toThrow(/400/);
    await expect(voyageProvider.generateEmbedding('bad request')).rejects.toThrow(
      new RegExp(voyageRejectionDetail)
    );
  });

  // The existing dimension validation must keep guarding the voyage path:
  // a vector of the wrong length is a config error, not data to store.
  it('throws the existing dimension-mismatch error when the vector length is wrong', async () => {
    stubVoyageProfileWithKey();
    // 8 dims against an expected 1024 — clearly wrong length.
    const wrongLengthResponseJson = {
      ...VOYAGE_SUCCESS_RESPONSE_JSON,
      data: [{ object: 'embedding', embedding: [1, 2, 3, 4, 5, 6, 7, 8], index: 0 }],
    };
    stubGlobalFetch(jsonResponse(wrongLengthResponseJson, 200));

    const voyageProvider = createEmbeddingProvider();

    await expect(voyageProvider.generateEmbedding('short vector')).rejects.toThrow(
      /Embedding dimension mismatch/
    );
  });

  // With no key anywhere (no env var, no `.env.local` line) the provider
  // must fail fast with guidance naming VOYAGE_API_KEY and .env.local —
  // mirroring the OpenAI branch's message style — and never hit the network.
  it('throws a VOYAGE_API_KEY / .env.local guidance error when no key is configured, without calling fetch', async () => {
    // Workspace `.env.local` exists but has no Voyage key line.
    workspace = openTempEnvLocalWorkspace('OPENAI_API_KEY=\n');
    vi.stubEnv('EMBEDDING_PROFILE', 'voyage');
    // No process-env key either. An empty/missing value means unconfigured.
    delete process.env.VOYAGE_API_KEY;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIMENSIONS;
    const fetchStub = stubGlobalFetch(jsonResponse(VOYAGE_SUCCESS_RESPONSE_JSON, 200));

    const voyageProvider = createEmbeddingProvider();

    await expect(voyageProvider.generateEmbedding('no key configured')).rejects.toThrow(
      /VOYAGE_API_KEY/
    );
    await expect(voyageProvider.generateEmbedding('no key configured')).rejects.toThrow(
      /\.env\.local/
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('createEmbeddingProvider voyage healthCheck', () => {
  // healthCheck must keep flowing through generateEmbedding: a live-shaped
  // success response yields ok:true with the actual vector length.
  it('reports ok:true with the voyage profile and 1024 dimensions on a live-shaped response', async () => {
    stubVoyageProfileWithKey();
    stubGlobalFetch(jsonResponse(VOYAGE_SUCCESS_RESPONSE_JSON, 200));

    const voyageProvider = createEmbeddingProvider();
    const voyageHealth = await voyageProvider.healthCheck();

    expect(voyageHealth.ok).toBe(true);
    expect(voyageHealth.profile).toBe('voyage');
    expect(voyageHealth.model).toBe('voyage-4-large');
    expect(voyageHealth.dimensions).toBe(1024);
  });

  // A failing request must yield ok:false with the underlying error message
  // surfaced in detail, not a throw.
  it('reports ok:false with the failure detail when the Voyage request fails', async () => {
    stubVoyageProfileWithKey();
    // A transport-level failure (e.g. no network) rejects the fetch promise.
    stubGlobalFetch(new Error('simulated voyage network failure'));

    const voyageProvider = createEmbeddingProvider();
    const voyageHealth = await voyageProvider.healthCheck();

    expect(voyageHealth.ok).toBe(false);
    expect(voyageHealth.profile).toBe('voyage');
    expect(voyageHealth.detail).toMatch(/simulated voyage network failure/);
  });
});
