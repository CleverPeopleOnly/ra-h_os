# Local Models

RA-H does not run model weights directly. You run a local OpenAI-compatible model server, then RA-H calls that server over HTTP.

The supported local profile is intentionally narrow:

- Utility LLM: Qwen3 4B or the closest tested Qwen3 4B runtime equivalent
- Embeddings: Qwen3 Embedding 0.6B
- Embedding dimensions: `1024`
- Runtime options behind the same contract: Ollama or llama.cpp

OpenAI remains the default supported path. Local mode is for users who are comfortable installing a model runtime, pulling model weights, starting local server processes, and managing rebuilds when embedding settings change.

## Core Env

Ollama:

```bash
LLM_PROFILE=openai-compatible
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=qwen3:4b

EMBEDDING_PROFILE=openai-compatible
EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
EMBEDDING_MODEL=qwen3-embedding:0.6b
EMBEDDING_DIMENSIONS=1024
```

llama.cpp:

```bash
LLM_PROFILE=openai-compatible
LLM_BASE_URL=http://127.0.0.1:8080/v1
LLM_MODEL=qwen3-4b

EMBEDDING_PROFILE=openai-compatible
EMBEDDING_BASE_URL=http://127.0.0.1:8081/v1
EMBEDDING_MODEL=qwen3-embedding-0.6b
EMBEDDING_DIMENSIONS=1024
```

Run:

```bash
npm run doctor:local-ai
```

If you change embedding provider, model, dimensions, or vector backend after data exists, run:

```bash
npm run rebuild:embeddings
```

## Voyage Embeddings (hosted)

The `voyage` profile uses hosted Voyage AI embeddings instead of a local embedding server. It is embeddings only — Voyage has no chat models, so pair it with any LLM profile (OpenAI or a local OpenAI-compatible server); your `LLM_*` settings are left untouched.

Setup:

```bash
npm run setup:local -- --profile voyage
```

This writes `EMBEDDING_PROFILE=voyage`, `EMBEDDING_MODEL=voyage-4-large`, and `EMBEDDING_DIMENSIONS=1024` — the same 1024 dimensions as the local Qwen profiles, so existing sqlite-vec tables match.

Requires `VOYAGE_API_KEY` in `.env.local` (get one at https://www.voyageai.com).

## Anthropic Utility LLM (hosted)

The `anthropic` profile uses Anthropic's hosted models for the utility LLM instead of a local model server. Set in `.env.local`:

```bash
LLM_PROFILE=anthropic
# Optional — defaults to claude-opus-5:
# LLM_MODEL=claude-opus-5
```

Requires `ANTHROPIC_API_KEY` in `.env.local` (get one at https://platform.claude.com).

It is LLM only — Anthropic has no embeddings API, so pair it with any embedding profile (OpenAI, Voyage, or a local OpenAI-compatible server); your `EMBEDDING_*` settings are left untouched.

## Vector Storage

Qwen3 creates vectors. sqlite-vec or Qdrant stores and searches those vectors.

You do not need Qdrant just because models are local. Use Qdrant when sqlite-vec is unavailable or unreliable on your platform, especially Alpine/musl Docker images, Windows ARM64, or other native-extension-hostile environments.

SQLite remains the source-of-truth database. Qdrant stores only derived vector indexes.
