/**
 * Spec for the Voyage `input_type` request parameter on
 * EmbeddingProvider.generateEmbedding (provider level).
 *
 * Facts fixed by a live spike against the real Voyage API:
 *   - `input_type` is an OPTIONAL body parameter taking 'query' or 'document'.
 *   - Sending 'query' vs 'document' genuinely changes the returned vector, so
 *     the value must reach the wire exactly as the caller intended.
 *   - Omitting the parameter is valid and keeps Voyage's untyped behaviour,
 *     so an absent inputType argument must produce a body with NO input_type
 *     key at all (not input_type: undefined / null).
 *
 * The planned contract under test (not yet implemented):
 *   - provider.ts exports `EmbeddingInputType = 'query' | 'document'`.
 *   - generateEmbedding(text, inputType?) forwards inputType to the Voyage
 *     body as `input_type` when given, omits it when not.
 *   - The OpenAI branch ignores the argument entirely — the OpenAI SDK call
 *     shape is byte-for-byte what it is today (OpenAI has no such parameter).
 *   - healthCheck() keeps calling generateEmbedding WITHOUT an inputType.
 *
 * RED expectation while unimplemented: generateEmbedding has no second
 * parameter and EmbeddingInputType is not exported, so `npm run type-check`
 * rejects this file; at runtime the voyage body never carries input_type, so
 * the two "sends input_type" tests also fail on the missing body key.
 */

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  createEmbeddingProvider,
  type EmbeddingInputType,
} from '@/services/embedding/provider';
import {
  openTempEnvLocalWorkspace,
  type TempEnvLocalWorkspace,
} from './helpers/tempEnvLocalWorkspace';

// Spy standing in for the OpenAI SDK's client.embeddings.create, hoisted so
// the vi.mock('openai') factory below can close over it. Each test that uses
// it programs its resolved value and inspects its recorded call arguments.
const { openAiEmbeddingsCreateSpy } = vi.hoisted(() => ({
  openAiEmbeddingsCreateSpy: vi.fn(),
}));

// Replace the whole OpenAI SDK with a class whose embeddings.create is the
// spy above. provider.ts does `new OpenAI({...}).embeddings.create(body)`, so
// this is the exact seam that records the SDK request body — letting the
// tests pin that the openai branch's call shape never gains an input type.
vi.mock('openai', () => ({
  default: class MockOpenAiSdkClient {
    embeddings = { create: openAiEmbeddingsCreateSpy };
  },
}));

// The Voyage key used across these tests. Voyage keys start with 'pa-'.
const TEST_VOYAGE_API_KEY = 'pa-test-voyage-key-1234567890';

// The OpenAI key used by the openai-branch test; 'sk-' prefixed like a real one.
const TEST_OPENAI_API_KEY = 'sk-test-openai-key-1234567890';

// A 1024-dim vector matching the voyage profile's default dimensions.
const VOYAGE_SIZED_EMBEDDING_VECTOR = Array.from({ length: 1024 }, (_, index) => index / 1024);

// A 1536-dim vector matching the openai profile's default dimensions.
const OPENAI_SIZED_EMBEDDING_VECTOR = Array.from({ length: 1536 }, (_, index) => index / 1536);

// A success payload in the exact shape the live Voyage API returns.
const VOYAGE_SUCCESS_RESPONSE_JSON = {
  object: 'list',
  data: [{ object: 'embedding', embedding: VOYAGE_SIZED_EMBEDDING_VECTOR, index: 0 }],
  model: 'voyage-4-large',
  usage: { total_tokens: 7 },
};

// The workspace whose `.env.local` supplies the API key; cleaned per test.
let workspace: TempEnvLocalWorkspace | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  openAiEmbeddingsCreateSpy.mockReset();
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

// Configure the openai profile with defaults. The OpenAI key reader only
// reads `.env.local` (never process.env), so the key goes in the workspace.
function stubOpenAiProfileWithKey(): void {
  workspace = openTempEnvLocalWorkspace(`OPENAI_API_KEY=${TEST_OPENAI_API_KEY}\n`);
  vi.stubEnv('EMBEDDING_PROFILE', 'openai');
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.EMBEDDING_BASE_URL;
}

// Replace global fetch with a stub resolving to the given Response and
// return the mock for call inspection.
function stubGlobalFetch(successResponse: Response): Mock {
  const fetchStub = vi.fn(async () => successResponse);
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

// Pull the single recorded fetch call's JSON request body.
function readSingleFetchCallBody(fetchStub: Mock): Record<string, unknown> {
  expect(fetchStub).toHaveBeenCalledTimes(1);
  const [, rawInit] = fetchStub.mock.calls[0] as [string | URL, RequestInit | undefined];
  return JSON.parse(String(rawInit?.body)) as Record<string, unknown>;
}

describe('EmbeddingInputType export', () => {
  // The provider module must export the two-role union so call sites can name
  // the storing/searching distinction without string literals of their own.
  it("exports EmbeddingInputType covering exactly the roles 'query' and 'document'", () => {
    // These annotations are the assertion: they compile only once the union
    // type exists with exactly these members.
    const searchingRole: EmbeddingInputType = 'query';
    const storingRole: EmbeddingInputType = 'document';
    expect([searchingRole, storingRole]).toEqual(['query', 'document']);
  });
});

describe('voyage generateEmbedding input_type forwarding', () => {
  // Searching direction: an explicit 'query' argument must land in the Voyage
  // body as input_type: 'query', with the rest of the body unchanged.
  it("sends input_type: 'query' in the Voyage body when generateEmbedding is called with 'query'", async () => {
    stubVoyageProfileWithKey();
    const fetchStub = stubGlobalFetch(jsonResponse(VOYAGE_SUCCESS_RESPONSE_JSON, 200));

    const voyageProvider = createEmbeddingProvider();
    const generatedEmbedding = await voyageProvider.generateEmbedding('what is credence?', 'query');

    const voyageRequestBody = readSingleFetchCallBody(fetchStub);
    expect(voyageRequestBody.input_type).toBe('query');
    // The existing body contract must survive the new parameter.
    expect(voyageRequestBody.model).toBe('voyage-4-large');
    expect(voyageRequestBody.output_dimension).toBe(1024);
    expect(generatedEmbedding).toEqual(VOYAGE_SIZED_EMBEDDING_VECTOR);
  });

  // Storing direction: an explicit 'document' argument must land in the
  // Voyage body as input_type: 'document'.
  it("sends input_type: 'document' in the Voyage body when generateEmbedding is called with 'document'", async () => {
    stubVoyageProfileWithKey();
    const fetchStub = stubGlobalFetch(jsonResponse(VOYAGE_SUCCESS_RESPONSE_JSON, 200));

    const voyageProvider = createEmbeddingProvider();
    await voyageProvider.generateEmbedding('a note kept for later retrieval', 'document');

    const voyageRequestBody = readSingleFetchCallBody(fetchStub);
    expect(voyageRequestBody.input_type).toBe('document');
  });

  // Omission direction: with no inputType argument the body must carry NO
  // input_type key at all — not input_type: undefined and not null — because
  // absence is Voyage's documented untyped mode.
  it('omits the input_type key entirely when generateEmbedding is called without an inputType', async () => {
    stubVoyageProfileWithKey();
    const fetchStub = stubGlobalFetch(jsonResponse(VOYAGE_SUCCESS_RESPONSE_JSON, 200));

    const voyageProvider = createEmbeddingProvider();
    await voyageProvider.generateEmbedding('untyped embedding request');

    const voyageRequestBody = readSingleFetchCallBody(fetchStub);
    expect('input_type' in voyageRequestBody).toBe(false);
  });
});

describe('openai generateEmbedding ignores inputType', () => {
  // OpenAI's embeddings API has no input-type parameter, so even when a
  // caller passes 'query', the SDK request must be byte-for-byte today's
  // shape — nothing new appears in the call.
  it("keeps the OpenAI SDK request body unchanged when generateEmbedding is called with 'query'", async () => {
    stubOpenAiProfileWithKey();
    // Guard: the openai branch must go through the SDK, never global fetch.
    const fetchStub = stubGlobalFetch(jsonResponse(VOYAGE_SUCCESS_RESPONSE_JSON, 200));
    openAiEmbeddingsCreateSpy.mockResolvedValue({
      data: [{ embedding: OPENAI_SIZED_EMBEDDING_VECTOR }],
    });

    const openAiProvider = createEmbeddingProvider();
    const generatedEmbedding = await openAiProvider.generateEmbedding('openai text', 'query');

    expect(openAiEmbeddingsCreateSpy).toHaveBeenCalledTimes(1);
    const [openAiSdkRequestBody] = openAiEmbeddingsCreateSpy.mock.calls[0] as [
      Record<string, unknown>,
    ];
    // toEqual pins the EXACT key set: any new key (input_type, inputType, …)
    // added to the openai branch makes this fail.
    expect(openAiSdkRequestBody).toEqual({
      model: 'text-embedding-3-small',
      input: 'openai text',
      encoding_format: 'float',
      dimensions: 1536,
    });
    expect(generatedEmbedding).toEqual(OPENAI_SIZED_EMBEDDING_VECTOR);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('voyage healthCheck stays untyped', () => {
  // healthCheck's probe embedding is neither a stored document nor a user
  // query, so it must keep calling generateEmbedding WITHOUT an inputType —
  // observable as a Voyage body with no input_type key.
  it('sends no input_type key in the Voyage body during healthCheck', async () => {
    stubVoyageProfileWithKey();
    const fetchStub = stubGlobalFetch(jsonResponse(VOYAGE_SUCCESS_RESPONSE_JSON, 200));

    const voyageProvider = createEmbeddingProvider();
    const voyageHealth = await voyageProvider.healthCheck();

    expect(voyageHealth.ok).toBe(true);
    const voyageRequestBody = readSingleFetchCallBody(fetchStub);
    expect('input_type' in voyageRequestBody).toBe(false);
  });
});
