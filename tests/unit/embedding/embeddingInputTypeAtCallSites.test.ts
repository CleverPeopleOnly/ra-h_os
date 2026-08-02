/**
 * Spec for the Voyage `input_type` value each EMBEDDING CALL SITE passes.
 *
 * Voyage distinguishes vectors made for SEARCHING with a question
 * (input_type: 'query') from vectors made for STORING text
 * (input_type: 'document'), and retrieval improves when each side declares
 * its role. The call-site contract under test (not yet implemented):
 *
 *   - EmbeddingService.generateQueryEmbedding embeds a SEARCH question, so it
 *     must pass 'query'.
 *   - NodeEmbedder and UniversalEmbedder embed text for STORAGE (node
 *     metadata and source chunks respectively), so their internal
 *     generateEmbedding calls must pass 'document'.
 *
 * Every test runs the voyage profile with global fetch stubbed, so the value
 * each call site chose is observable as `input_type` in the recorded Voyage
 * request body. The embedder classes open a real (temp-file) better-sqlite3
 * database themselves — see helpers/tempEmbedderSqliteDatabase.ts — and only
 * two module boundaries are mocked: the vector backend (no vector work) and
 * the LLM utility (must never be reached).
 *
 * RED expectation while unimplemented: every call site invokes
 * generateEmbedding with no inputType, so each recorded Voyage body lacks the
 * input_type key and all three tests fail on `expected undefined to be ...`.
 */

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EmbeddingService } from '@/services/embeddings';
import { NodeEmbedder } from '@/services/typescript/embed-nodes';
import { UniversalEmbedder } from '@/services/typescript/embed-universal';
import {
  openTempEnvLocalWorkspace,
  type TempEnvLocalWorkspace,
} from './helpers/tempEnvLocalWorkspace';
import {
  openTempEmbedderSqliteDatabase,
  type TempEmbedderSqliteDatabase,
} from './helpers/tempEmbedderSqliteDatabase';

// No-op stand-in for the vector backend, hoisted so the vi.mock factory can
// close over it. The embedders tolerate vector-backend failures anyway; the
// stub keeps the tests off the sqlite-vec extension entirely.
const { noOpVectorBackendStub } = vi.hoisted(() => ({
  noOpVectorBackendStub: {
    upsertNode: vi.fn(async () => undefined),
    upsertChunk: vi.fn(async () => undefined),
    deleteChunksByNode: vi.fn(async () => undefined),
  },
}));

// Replace the vector backend factory so no test touches vec0/Qdrant: the
// assertions live on the embedding HTTP body, not on vector storage.
vi.mock('@/services/vectorBackend/factory', () => ({
  getVectorBackend: vi.fn(async () => noOpVectorBackendStub),
}));

// Replace the LLM utility with a loud failure: NodeEmbedder only analyses
// nodes whose source is non-empty, and these fixtures keep source empty, so
// any call here means the test drifted onto the LLM path by accident.
vi.mock('@/services/llm/provider', () => ({
  generateUtilityText: vi.fn(async () => {
    throw new Error('generateUtilityText must not be reached by the input_type call-site tests');
  }),
}));

// The Voyage key used across these tests. Voyage keys start with 'pa-'.
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

// The temp-file database an embedder class under test opens; cleaned per test.
let embedderDatabase: TempEmbedderSqliteDatabase | undefined;

// The embedder instance under test, held so afterEach always closes its own
// database connection even when an assertion throws mid-test.
let embedderUnderTest: { close(): void } | undefined;

afterEach(() => {
  embedderUnderTest?.close();
  embedderUnderTest = undefined;
  embedderDatabase?.cleanup();
  embedderDatabase = undefined;
  workspace?.cleanup();
  workspace = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

// Replace global fetch with a stub that answers every call with a fresh
// live-shaped Voyage success Response, and return the mock for inspection.
function stubGlobalFetchWithVoyageSuccess(): Mock {
  const fetchStub = vi.fn(
    async () =>
      new Response(JSON.stringify(VOYAGE_SUCCESS_RESPONSE_JSON), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

// Pull the single recorded fetch call's JSON request body.
function readSingleFetchCallBody(fetchStub: Mock): Record<string, unknown> {
  expect(fetchStub).toHaveBeenCalledTimes(1);
  const [, rawInit] = fetchStub.mock.calls[0] as [string | URL, RequestInit | undefined];
  return JSON.parse(String(rawInit?.body)) as Record<string, unknown>;
}

describe('EmbeddingService.generateQueryEmbedding input_type', () => {
  // A query embedding is made for SEARCHING, so the service must declare the
  // 'query' role to Voyage on the caller's behalf.
  it("produces a Voyage request body with input_type: 'query'", async () => {
    stubVoyageProfileWithKey();
    const fetchStub = stubGlobalFetchWithVoyageSuccess();

    const queryEmbedding = await EmbeddingService.generateQueryEmbedding('what is credence?');

    const voyageRequestBody = readSingleFetchCallBody(fetchStub);
    expect(voyageRequestBody.input_type).toBe('query');
    expect(queryEmbedding).toEqual(VOYAGE_SIZED_EMBEDDING_VECTOR);
  });
});

describe('NodeEmbedder input_type', () => {
  // Node-metadata embeddings are STORED for later retrieval, so the embed
  // call must declare the 'document' role. The fixture node has an empty
  // source so the run stays off the LLM-analysis branch and makes exactly
  // one embedding call.
  it("embeds node metadata with a Voyage request body carrying input_type: 'document'", async () => {
    stubVoyageProfileWithKey();
    embedderDatabase = openTempEmbedderSqliteDatabase();
    const storedNodeId = embedderDatabase.insertNodeFixture({
      title: 'stored belief note',
      source: '',
      description: 'node metadata embedded for storage',
    });
    const fetchStub = stubGlobalFetchWithVoyageSuccess();

    const nodeEmbedder = new NodeEmbedder();
    embedderUnderTest = nodeEmbedder;
    const embedRunResult = await nodeEmbedder.embedNodes({ nodeId: storedNodeId });

    // The run itself must have embedded the one node cleanly — a silent
    // failure would otherwise surface here as a confusing zero-call fetch.
    expect(embedRunResult).toEqual({ processed: 1, failed: 0 });
    const voyageRequestBody = readSingleFetchCallBody(fetchStub);
    expect(voyageRequestBody.input_type).toBe('document');
  });
});

describe('UniversalEmbedder input_type', () => {
  // Chunk embeddings are STORED for later retrieval, so each chunk's embed
  // call must declare the 'document' role. The fixture source is well under
  // the 1000-character chunk size, so it yields exactly one chunk and
  // therefore exactly one embedding call.
  it("embeds a source chunk with a Voyage request body carrying input_type: 'document'", async () => {
    stubVoyageProfileWithKey();
    embedderDatabase = openTempEmbedderSqliteDatabase();
    const chunkedNodeId = embedderDatabase.insertNodeFixture({
      title: 'chunked source note',
      source: 'A short paragraph of source content, stored as a single chunk for retrieval.',
    });
    const fetchStub = stubGlobalFetchWithVoyageSuccess();

    const universalEmbedder = new UniversalEmbedder();
    embedderUnderTest = universalEmbedder;
    const chunkRunResult = await universalEmbedder.processNode({ nodeId: chunkedNodeId });

    // Exactly one chunk proves the single recorded fetch call IS the chunk
    // embedding, not some other request.
    expect(chunkRunResult).toEqual({ chunks: 1 });
    const voyageRequestBody = readSingleFetchCallBody(fetchStub);
    expect(voyageRequestBody.input_type).toBe('document');
  });
});
