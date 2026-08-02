/**
 * Spec for getUtilityLlmProviderInfo() with LLM_PROFILE=anthropic.
 *
 * Anthropic is a first-class UTILITY LLM profile (the small internal LLM used
 * for node descriptions, edge inference, embedding-prep analysis — not the
 * chat agents). Design principle: profiles are the rare code-defined
 * vocabulary; everything INSIDE a profile — model, key — is config (env).
 * The profile needs no base URL (the official @ai-sdk/anthropic provider
 * knows the endpoint) and defaults to model claude-opus-5.
 *
 * RED expectation while unimplemented: normalizeProfile() collapses
 * 'anthropic' to 'openai', so every profile assertion below fails.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUtilityLlmProviderInfo } from '@/services/llm/provider';

afterEach(() => {
  vi.unstubAllEnvs();
});

// Remove every utility-LLM env override so each test starts from a clean
// slate and only sets what it is specifying.
function clearUtilityLlmEnv(): void {
  delete process.env.LLM_PROFILE;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
}

describe('getUtilityLlmProviderInfo with LLM_PROFILE=anthropic', () => {
  // The anthropic profile must be recognised as its own profile (not
  // collapsed to 'openai') and must default the model to claude-opus-5.
  it('returns the anthropic profile with model claude-opus-5 by default', () => {
    clearUtilityLlmEnv();
    vi.stubEnv('LLM_PROFILE', 'anthropic');

    const anthropicProviderInfo = getUtilityLlmProviderInfo();

    expect(anthropicProviderInfo.profile).toBe('anthropic');
    expect(anthropicProviderInfo.model).toBe('claude-opus-5');
  });

  // The config-only property: the model is env config, never code — an
  // explicit LLM_MODEL must be honoured verbatim over the default.
  it('honours an LLM_MODEL override verbatim (claude-sonnet-5)', () => {
    clearUtilityLlmEnv();
    vi.stubEnv('LLM_PROFILE', 'anthropic');
    vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');

    const anthropicProviderInfo = getUtilityLlmProviderInfo();

    expect(anthropicProviderInfo.profile).toBe('anthropic');
    expect(anthropicProviderInfo.model).toBe('claude-sonnet-5');
  });

  // Anthropic's endpoint is fixed by the official provider, so unlike
  // openai-compatible the profile must not require LLM_BASE_URL — no throw
  // when none is set — and must not report a baseUrl.
  it('needs no LLM_BASE_URL and reports no baseUrl', () => {
    clearUtilityLlmEnv();
    vi.stubEnv('LLM_PROFILE', 'anthropic');

    const anthropicProviderInfo = getUtilityLlmProviderInfo();

    expect(anthropicProviderInfo.profile).toBe('anthropic');
    expect(anthropicProviderInfo.baseUrl).toBeUndefined();
  });
});
