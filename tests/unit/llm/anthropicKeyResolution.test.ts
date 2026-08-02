/**
 * Spec for getPreferredAnthropicKey() in src/services/storage/apiKeyServer.ts.
 *
 * The reader mirrors getPreferredOpenAiKey / getPreferredVoyageKey: it
 * re-reads `.env.local` from process.cwd() on EVERY call (the settings UI
 * writes keys there at runtime), returns the first ANTHROPIC_API_KEY= value
 * with surrounding quotes stripped, skips comment lines, and treats an empty
 * value, the template placeholder `your-anthropic-api-key-here`, or a
 * missing/unreadable file as "not configured" (undefined). It reads ONLY the
 * file — the process-env fallback belongs to the provider layer.
 *
 * RED expectation while unimplemented: apiKeyServer.ts does not export
 * getPreferredAnthropicKey, so every call below fails with
 * "getPreferredAnthropicKey is not a function" (an import-time failure is
 * equally acceptable red).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPreferredAnthropicKey } from '@/services/storage/apiKeyServer';
import {
  openTempEnvLocalWorkspace,
  type TempEnvLocalWorkspace,
} from '../embedding/helpers/tempEnvLocalWorkspace';

// The Anthropic key used across these tests. Anthropic keys start 'sk-ant-'.
const TEST_ANTHROPIC_API_KEY = 'sk-ant-test-anthropic-key-1234567890';

// A second distinct key for the re-read-per-call test.
const REWRITTEN_ANTHROPIC_API_KEY = 'sk-ant-test-rewritten-key-0987654321';

// The .env.example template value that must never count as a real key.
const ANTHROPIC_KEY_PLACEHOLDER = 'your-anthropic-api-key-here';

// The workspace whose `.env.local` the reader resolves from process.cwd();
// cleaned per test.
let workspace: TempEnvLocalWorkspace | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  workspace?.cleanup();
  workspace = undefined;
});

describe('getPreferredAnthropicKey', () => {
  // The plain happy path: an unquoted ANTHROPIC_API_KEY= line yields its
  // value verbatim.
  it('returns the key from a plain ANTHROPIC_API_KEY line', () => {
    workspace = openTempEnvLocalWorkspace(`ANTHROPIC_API_KEY=${TEST_ANTHROPIC_API_KEY}\n`);

    expect(getPreferredAnthropicKey()).toBe(TEST_ANTHROPIC_API_KEY);
  });

  // Double-quoted values must come back with the quotes stripped.
  it('strips surrounding double quotes from the value', () => {
    workspace = openTempEnvLocalWorkspace(`ANTHROPIC_API_KEY="${TEST_ANTHROPIC_API_KEY}"\n`);

    expect(getPreferredAnthropicKey()).toBe(TEST_ANTHROPIC_API_KEY);
  });

  // Single-quoted values must come back with the quotes stripped too.
  it('strips surrounding single quotes from the value', () => {
    workspace = openTempEnvLocalWorkspace(`ANTHROPIC_API_KEY='${TEST_ANTHROPIC_API_KEY}'\n`);

    expect(getPreferredAnthropicKey()).toBe(TEST_ANTHROPIC_API_KEY);
  });

  // A commented-out key line is not configuration and must be skipped.
  it('skips a commented-out ANTHROPIC_API_KEY line', () => {
    workspace = openTempEnvLocalWorkspace(`# ANTHROPIC_API_KEY=${TEST_ANTHROPIC_API_KEY}\n`);

    expect(getPreferredAnthropicKey()).toBeUndefined();
  });

  // The .env.example placeholder must never be treated as a real key.
  it('rejects the template placeholder your-anthropic-api-key-here', () => {
    workspace = openTempEnvLocalWorkspace(`ANTHROPIC_API_KEY=${ANTHROPIC_KEY_PLACEHOLDER}\n`);

    expect(getPreferredAnthropicKey()).toBeUndefined();
  });

  // An empty value means unconfigured, not an empty-string key.
  it('returns undefined for an empty ANTHROPIC_API_KEY value', () => {
    workspace = openTempEnvLocalWorkspace('ANTHROPIC_API_KEY=\n');

    expect(getPreferredAnthropicKey()).toBeUndefined();
  });

  // A missing `.env.local` means unconfigured, never a throw.
  it('returns undefined when .env.local does not exist', () => {
    // No initial contents: the workspace has no `.env.local` at all.
    workspace = openTempEnvLocalWorkspace();

    expect(getPreferredAnthropicKey()).toBeUndefined();
  });

  // Other providers' key lines must never satisfy the Anthropic reader —
  // each provider's key is its own line, on sight.
  it('is never satisfied by OPENAI_API_KEY or VOYAGE_API_KEY lines', () => {
    workspace = openTempEnvLocalWorkspace(
      'OPENAI_API_KEY=sk-test-openai-key-1234567890\n' +
        'VOYAGE_API_KEY=pa-test-voyage-key-1234567890\n'
    );

    expect(getPreferredAnthropicKey()).toBeUndefined();
  });

  // The reader reads ONLY `.env.local` — a process-env ANTHROPIC_API_KEY
  // must not leak through it; the env fallback is the provider layer's job.
  it('ignores process.env.ANTHROPIC_API_KEY when the file has no key', () => {
    workspace = openTempEnvLocalWorkspace();
    vi.stubEnv('ANTHROPIC_API_KEY', TEST_ANTHROPIC_API_KEY);

    expect(getPreferredAnthropicKey()).toBeUndefined();
  });

  // The settings UI rewrites `.env.local` at runtime, so the reader must
  // re-read the file on every call — a rewrite between calls takes effect.
  it('re-reads .env.local on every call, so a rewritten key takes effect', () => {
    workspace = openTempEnvLocalWorkspace(`ANTHROPIC_API_KEY=${TEST_ANTHROPIC_API_KEY}\n`);

    expect(getPreferredAnthropicKey()).toBe(TEST_ANTHROPIC_API_KEY);

    workspace.writeEnvLocal(`ANTHROPIC_API_KEY=${REWRITTEN_ANTHROPIC_API_KEY}\n`);

    expect(getPreferredAnthropicKey()).toBe(REWRITTEN_ANTHROPIC_API_KEY);
  });
});
