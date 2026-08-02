import OpenAI from 'openai';
import { getPreferredOpenAiKey, getPreferredVoyageKey } from '@/services/storage/apiKeyServer';

export type EmbeddingProfile = 'openai' | 'openai-compatible' | 'custom' | 'voyage';

export interface EmbeddingProviderInfo {
  profile: EmbeddingProfile;
  model: string;
  dimensions: number;
  baseUrl?: string;
}

export interface EmbeddingHealth {
  ok: boolean;
  profile: EmbeddingProfile;
  model: string;
  dimensions: number;
  detail?: string;
}

export interface EmbeddingProvider {
  info(): EmbeddingProviderInfo;
  generateEmbedding(text: string): Promise<number[]>;
  healthCheck(): Promise<EmbeddingHealth>;
}

const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_OPENAI_EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_LOCAL_EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_VOYAGE_EMBEDDING_MODEL = 'voyage-4-large';
// 1024 dims so voyage drops straight into the existing 1024-dim sqlite-vec tables.
const DEFAULT_VOYAGE_EMBEDDING_DIMENSIONS = 1024;
// Voyage's endpoint is fixed — the profile needs no EMBEDDING_BASE_URL.
const VOYAGE_EMBEDDINGS_ENDPOINT_URL = 'https://api.voyageai.com/v1/embeddings';

function normalizeProfile(raw: string | undefined): EmbeddingProfile {
  if (raw === 'openai-compatible' || raw === 'custom' || raw === 'voyage') return raw;
  return 'openai';
}

function parseDimensions(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid EMBEDDING_DIMENSIONS="${raw}". Use a positive integer.`);
  }
  return parsed;
}

export function getEmbeddingProviderInfo(): EmbeddingProviderInfo {
  const profile = normalizeProfile(process.env.EMBEDDING_PROFILE);
  if (profile === 'openai') {
    return {
      profile,
      model: process.env.EMBEDDING_MODEL || DEFAULT_OPENAI_EMBEDDING_MODEL,
      dimensions: parseDimensions(process.env.EMBEDDING_DIMENSIONS, DEFAULT_OPENAI_EMBEDDING_DIMENSIONS),
    };
  }

  if (profile === 'voyage') {
    return {
      profile,
      model: process.env.EMBEDDING_MODEL || DEFAULT_VOYAGE_EMBEDDING_MODEL,
      dimensions: parseDimensions(process.env.EMBEDDING_DIMENSIONS, DEFAULT_VOYAGE_EMBEDDING_DIMENSIONS),
    };
  }

  const model = process.env.EMBEDDING_MODEL;
  const baseUrl = process.env.EMBEDDING_BASE_URL || process.env.LLM_BASE_URL;

  if (!model) {
    throw new Error('EMBEDDING_MODEL is required when EMBEDDING_PROFILE=openai-compatible.');
  }
  if (!baseUrl) {
    throw new Error('EMBEDDING_BASE_URL is required when EMBEDDING_PROFILE=openai-compatible.');
  }

  return {
    profile,
    model,
    dimensions: parseDimensions(process.env.EMBEDDING_DIMENSIONS, DEFAULT_LOCAL_EMBEDDING_DIMENSIONS),
    baseUrl,
  };
}

function createOpenAiClient(info: EmbeddingProviderInfo): OpenAI {
  if (info.profile === 'openai') {
    const apiKey = getPreferredOpenAiKey();
    if (!apiKey) {
      throw new Error('OpenAI API key not configured. Add OPENAI_API_KEY to your .env.local file.');
    }
    return new OpenAI({ apiKey });
  }

  return new OpenAI({
    apiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || 'local',
    baseURL: info.baseUrl,
  });
}

// Call the Voyage embeddings API directly with global fetch. Voyage rejects
// OpenAI's parameter names (`dimensions`, `encoding_format`) with HTTP 400,
// so its own body shape { model, input, output_dimension } is required and
// the OpenAI SDK client cannot be reused here.
async function fetchVoyageEmbedding(info: EmbeddingProviderInfo, text: string): Promise<number[] | undefined> {
  // .env.local (settings UI) wins over the process env, matching the OpenAI key path.
  const voyageApiKey = getPreferredVoyageKey() || process.env.VOYAGE_API_KEY;
  if (!voyageApiKey) {
    throw new Error('Voyage API key not configured. Add VOYAGE_API_KEY to your .env.local file.');
  }

  const voyageResponse = await fetch(VOYAGE_EMBEDDINGS_ENDPOINT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${voyageApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: info.model,
      input: text.trim(),
      output_dimension: info.dimensions,
    }),
  });

  if (!voyageResponse.ok) {
    // Voyage rejections carry the reason in a `detail` string. Read it from a
    // clone so the original response body is never consumed here.
    const voyageRejectionBody = (await voyageResponse.clone().json().catch(() => undefined)) as
      | { detail?: string }
      | undefined;
    throw new Error(
      `Voyage embeddings request failed with HTTP ${voyageResponse.status}: ${voyageRejectionBody?.detail ?? 'no detail provided'}`
    );
  }

  const voyageSuccessBody = (await voyageResponse.json()) as { data?: Array<{ embedding?: number[] }> };
  return voyageSuccessBody.data?.[0]?.embedding;
}

export function validateEmbeddingDimensions(embedding: number[], expectedDimensions = getEmbeddingProviderInfo().dimensions): boolean {
  return Array.isArray(embedding) && embedding.length === expectedDimensions;
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const info = getEmbeddingProviderInfo();

  return {
    info: () => info,
    async generateEmbedding(text: string): Promise<number[]> {
      let embedding: number[] | undefined;
      if (info.profile === 'voyage') {
        embedding = await fetchVoyageEmbedding(info, text);
      } else {
        const client = createOpenAiClient(info);
        const response = await client.embeddings.create({
          model: info.model,
          input: text.trim(),
          encoding_format: 'float',
          dimensions: info.dimensions,
        });
        embedding = response.data?.[0]?.embedding;
      }
      if (!embedding) {
        throw new Error(`No embedding returned from ${info.profile} provider.`);
      }
      if (!validateEmbeddingDimensions(embedding, info.dimensions)) {
        throw new Error(
          `Embedding dimension mismatch: expected ${info.dimensions}, got ${embedding.length}. ` +
          'Run the local AI doctor and rebuild embeddings after changing providers.'
        );
      }
      return embedding;
    },
    async healthCheck(): Promise<EmbeddingHealth> {
      try {
        const embedding = await this.generateEmbedding('RA-H embedding health check');
        return {
          ok: true,
          profile: info.profile,
          model: info.model,
          dimensions: embedding.length,
          detail: info.baseUrl ? `Connected to ${info.baseUrl}` : 'OpenAI embedding provider ready',
        };
      } catch (error) {
        return {
          ok: false,
          profile: info.profile,
          model: info.model,
          dimensions: info.dimensions,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
