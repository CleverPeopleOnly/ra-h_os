/**
 * Spec for generateUtilityText() / healthCheck() with LLM_PROFILE=anthropic.
 *
 * The anthropic profile must run on the OFFICIAL Vercel AI SDK provider —
 * createAnthropic from '@ai-sdk/anthropic' — never createOpenAI and never a
 * base-URL shim. Key resolution is getPreferredAnthropicKey() (the .env.local
 * reader) falling back to process.env.ANTHROPIC_API_KEY; a missing key throws
 * an Error naming ANTHROPIC_API_KEY and .env.local BEFORE any model call.
 *
 * Both '@ai-sdk/anthropic' and 'ai' are mocked, so no test touches the
 * network. The mocked anthropic provider callable mints one identifiable
 * sentinel object per model name, so "the model was resolved through the
 * anthropic provider" is observable as sentinel identity on the model that
 * generateText received.
 *
 * RED expectation while unimplemented: 'anthropic' normalises to the openai
 * profile, whose createProvider reads the workspace `.env.local` (which has
 * no OPENAI_API_KEY) and throws the OpenAI guidance error before any mock is
 * reached — so every anthropic-path test fails without network traffic.
 * EXCEPTION: the final branch-isolation test ('openai-compatible never
 * touches @ai-sdk/anthropic') is a deliberate regression guard on the
 * untouched branch and is expected to be GREEN before implementation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUtilityLlmProvider, generateUtilityText } from '@/services/llm/provider';
import {
  openTempEnvLocalWorkspace,
  type TempEnvLocalWorkspace,
} from '../embedding/helpers/tempEnvLocalWorkspace';

// Hoisted so the vi.mock factories below can close over them.
const {
  createAnthropicSpy,
  anthropicProviderModelSentinelFor,
  generateTextSpy,
  MOCKED_ANTHROPIC_UTILITY_TEXT,
} = vi.hoisted(() => {
  // The exact text the mocked generateText resolves with; tests assert it
  // comes back through generateUtilityText unchanged.
  const MOCKED_ANTHROPIC_UTILITY_TEXT = 'mocked anthropic utility completion';

  // One stable sentinel object per model name. Only the mocked anthropic
  // provider callable can mint these, so seeing a sentinel as generateText's
  // `model` proves the model was resolved through the anthropic provider.
  const mintedModelSentinels = new Map<string, { anthropicSentinelModelName: string }>();
  const anthropicProviderModelSentinelFor = (
    modelName: string
  ): { anthropicSentinelModelName: string } => {
    let modelSentinel = mintedModelSentinels.get(modelName);
    if (!modelSentinel) {
      modelSentinel = { anthropicSentinelModelName: modelName };
      mintedModelSentinels.set(modelName, modelSentinel);
    }
    return modelSentinel;
  };

  // Stand-in for the provider that createAnthropic returns: callable as
  // provider(modelName), with languageModel() as an equivalent seam, both
  // minting the same per-model sentinel.
  const anthropicProviderCallableStub = Object.assign(
    (modelName: string) => anthropicProviderModelSentinelFor(modelName),
    { languageModel: (modelName: string) => anthropicProviderModelSentinelFor(modelName) }
  );

  // Spy standing in for '@ai-sdk/anthropic'.createAnthropic — records the
  // options (notably apiKey) the provider was created with.
  const createAnthropicSpy = vi.fn(() => anthropicProviderCallableStub);

  // Spy standing in for 'ai'.generateText — records the model/prompt it was
  // handed and resolves with the mocked completion text.
  const generateTextSpy = vi.fn(
    async (_generateTextOptions: {
      model: unknown;
      prompt: string;
      maxOutputTokens?: number;
      temperature?: number;
    }) => ({ text: MOCKED_ANTHROPIC_UTILITY_TEXT })
  );

  return {
    createAnthropicSpy,
    anthropicProviderModelSentinelFor,
    generateTextSpy,
    MOCKED_ANTHROPIC_UTILITY_TEXT,
  };
});

// The anthropic profile must use the official provider package — this mock is
// the only source of the model sentinels asserted on below.
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: createAnthropicSpy,
}));

// Keep every profile off the network: provider.ts only imports generateText
// from 'ai', so that is all the mock needs to supply.
vi.mock('ai', () => ({
  generateText: generateTextSpy,
}));

// The Anthropic key used across these tests. Anthropic keys start 'sk-ant-'.
const TEST_ANTHROPIC_API_KEY = 'sk-ant-test-anthropic-key-1234567890';

// The workspace whose `.env.local` the key reader resolves from process.cwd();
// cleaned per test.
let workspace: TempEnvLocalWorkspace | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  workspace?.cleanup();
  workspace = undefined;
  // Hoisted module-level spies persist across tests; clear their recorded
  // calls so each test asserts only its own traffic.
  createAnthropicSpy.mockClear();
  generateTextSpy.mockClear();
});

// Configure the anthropic profile with defaults: no model/base-url/api-key
// env overrides beyond what each test sets explicitly.
function stubAnthropicProfile(): void {
  vi.stubEnv('LLM_PROFILE', 'anthropic');
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
}

// Make TEST_ANTHROPIC_API_KEY available BOTH as a process env var and as a
// `.env.local` line (same value), so tests pin behaviour, not which of the
// two sources the provider reads.
function stubAnthropicKeyInBothSources(): void {
  workspace = openTempEnvLocalWorkspace(`ANTHROPIC_API_KEY=${TEST_ANTHROPIC_API_KEY}\n`);
  vi.stubEnv('ANTHROPIC_API_KEY', TEST_ANTHROPIC_API_KEY);
}

describe('generateUtilityText with LLM_PROFILE=anthropic', () => {
  // The core contract: createAnthropic receives the configured key, the
  // default model claude-opus-5 is resolved through the anthropic provider
  // (sentinel identity), and the provider's text comes back unchanged.
  it('creates the anthropic provider with the key, resolves claude-opus-5 through it, and returns the text', async () => {
    stubAnthropicProfile();
    stubAnthropicKeyInBothSources();

    const generatedUtilityText = await generateUtilityText({
      prompt: 'Describe this node.',
      task: 'description',
    });

    expect(generatedUtilityText).toBe(MOCKED_ANTHROPIC_UTILITY_TEXT);
    expect(createAnthropicSpy).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: TEST_ANTHROPIC_API_KEY })
    );
    expect(generateTextSpy).toHaveBeenCalledTimes(1);
    // The recorded generateText options — the model must be the exact
    // sentinel the anthropic provider mints for the default model name.
    const generateTextCallOptions = generateTextSpy.mock.calls[0]?.[0];
    expect(generateTextCallOptions?.model).toBe(
      anthropicProviderModelSentinelFor('claude-opus-5')
    );
    expect(generateTextCallOptions?.prompt).toBe('Describe this node.');
  });

  // The config-only property end to end: an LLM_MODEL override must flow
  // verbatim into the anthropic provider — no code change, only env.
  it('resolves an LLM_MODEL override through the anthropic provider verbatim', async () => {
    stubAnthropicProfile();
    stubAnthropicKeyInBothSources();
    vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');

    await generateUtilityText({ prompt: 'Infer the edge.', task: 'edge_inference' });

    expect(generateTextSpy).toHaveBeenCalledTimes(1);
    expect(generateTextSpy.mock.calls[0]?.[0].model).toBe(
      anthropicProviderModelSentinelFor('claude-sonnet-5')
    );
  });

  // Key layering, file side: a `.env.local` ANTHROPIC_API_KEY line alone
  // (no process env var) must reach createAnthropic — pinning that
  // getPreferredAnthropicKey is actually wired in.
  it('uses the .env.local ANTHROPIC_API_KEY when no env var is set', async () => {
    stubAnthropicProfile();
    workspace = openTempEnvLocalWorkspace(`ANTHROPIC_API_KEY=${TEST_ANTHROPIC_API_KEY}\n`);
    // stubEnv with undefined unsets the var for this test and restores any
    // real value on the developer's machine afterwards.
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);

    const generatedUtilityText = await generateUtilityText({
      prompt: 'Analyse for embedding prep.',
      task: 'embedding_prep_analysis',
    });

    expect(generatedUtilityText).toBe(MOCKED_ANTHROPIC_UTILITY_TEXT);
    expect(createAnthropicSpy).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: TEST_ANTHROPIC_API_KEY })
    );
  });

  // Key layering, env side: with no `.env.local` line, the
  // process.env.ANTHROPIC_API_KEY fallback must reach createAnthropic —
  // pinning the `getPreferredAnthropicKey() || process.env.ANTHROPIC_API_KEY`
  // resolution order's second leg.
  it('falls back to process.env.ANTHROPIC_API_KEY when .env.local has no key line', async () => {
    stubAnthropicProfile();
    // Workspace `.env.local` exists but carries no Anthropic key line.
    workspace = openTempEnvLocalWorkspace('OPENAI_API_KEY=\n');
    vi.stubEnv('ANTHROPIC_API_KEY', TEST_ANTHROPIC_API_KEY);

    const generatedUtilityText = await generateUtilityText({
      prompt: 'Summarise the transcript.',
      task: 'transcript_summary',
    });

    expect(generatedUtilityText).toBe(MOCKED_ANTHROPIC_UTILITY_TEXT);
    expect(createAnthropicSpy).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: TEST_ANTHROPIC_API_KEY })
    );
  });

  // With no key anywhere (no env var, no `.env.local` line) the provider
  // must fail fast with guidance naming ANTHROPIC_API_KEY and .env.local —
  // mirroring the OpenAI branch's message style — thrown BEFORE any model
  // call: neither createAnthropic nor generateText may ever run.
  it('throws an ANTHROPIC_API_KEY / .env.local guidance error when no key is configured, before any model call', async () => {
    stubAnthropicProfile();
    // Workspace `.env.local` exists but has no Anthropic key line.
    workspace = openTempEnvLocalWorkspace('OPENAI_API_KEY=\n');
    // No process-env key either.
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);

    await expect(
      generateUtilityText({ prompt: 'no key configured', task: 'description' })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(
      generateUtilityText({ prompt: 'no key configured', task: 'description' })
    ).rejects.toThrow(/\.env\.local/);
    expect(createAnthropicSpy).not.toHaveBeenCalled();
    expect(generateTextSpy).not.toHaveBeenCalled();
  });
});

describe('healthCheck with LLM_PROFILE=anthropic', () => {
  // healthCheck must keep flowing through the same generateText path: a
  // successful mocked completion yields ok:true under the anthropic profile
  // with the default model.
  it('reports ok:true with the anthropic profile and claude-opus-5 on a successful completion', async () => {
    stubAnthropicProfile();
    stubAnthropicKeyInBothSources();

    const anthropicUtilityProvider = createUtilityLlmProvider();
    const anthropicHealth = await anthropicUtilityProvider.healthCheck();

    expect(anthropicHealth.ok).toBe(true);
    expect(anthropicHealth.profile).toBe('anthropic');
    expect(anthropicHealth.model).toBe('claude-opus-5');
  });

  // A missing key must surface through healthCheck as ok:false carrying the
  // ANTHROPIC_API_KEY guidance in detail, not as a throw.
  it('reports ok:false with the ANTHROPIC_API_KEY guidance in detail when no key is configured', async () => {
    stubAnthropicProfile();
    // Workspace `.env.local` exists but has no Anthropic key line, and no
    // process-env key either.
    workspace = openTempEnvLocalWorkspace('OPENAI_API_KEY=\n');
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);

    const anthropicUtilityProvider = createUtilityLlmProvider();
    const anthropicHealth = await anthropicUtilityProvider.healthCheck();

    expect(anthropicHealth.ok).toBe(false);
    expect(anthropicHealth.profile).toBe('anthropic');
    expect(anthropicHealth.detail).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe('branch isolation from the anthropic profile', () => {
  // Regression guard (deliberately GREEN before implementation): the
  // openai-compatible branch must never touch '@ai-sdk/anthropic' — adding
  // the anthropic profile may not leak into the existing branches.
  it('never calls createAnthropic when LLM_PROFILE=openai-compatible', async () => {
    // Workspace `.env.local` with no keys at all; the openai-compatible
    // branch tolerates a keyless local endpoint.
    workspace = openTempEnvLocalWorkspace('');
    vi.stubEnv('LLM_PROFILE', 'openai-compatible');
    vi.stubEnv('LLM_MODEL', 'llama-3.1-8b-instruct');
    vi.stubEnv('LLM_BASE_URL', 'http://localhost:11434/v1');

    const generatedUtilityText = await generateUtilityText({
      prompt: 'local model prompt',
      task: 'description',
    });

    expect(generatedUtilityText).toBe(MOCKED_ANTHROPIC_UTILITY_TEXT);
    expect(createAnthropicSpy).not.toHaveBeenCalled();
  });
});
