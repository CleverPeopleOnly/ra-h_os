/**
 * Spec for getPreferredVoyageKey() in src/services/storage/openaiKeyServer.ts.
 *
 * The existing getPreferredOpenAiKey() re-reads `.env.local` from
 * process.cwd() on every call because the settings UI writes keys there at
 * runtime. The Voyage key reader must behave identically for
 * `VOYAGE_API_KEY=` lines: same quote-stripping, comment-skipping and
 * placeholder-rejecting semantics, with a missing/unreadable file resolving
 * to undefined. Voyage keys start with 'pa-', never 'sk-', so nothing here
 * may assume an sk- prefix.
 *
 * RED expectation while unimplemented: the named export
 * getPreferredVoyageKey does not exist yet, so this whole file fails at
 * import time — the correct red for a missing function.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getPreferredVoyageKey } from '@/services/storage/apiKeyServer';
import {
  openTempEnvLocalWorkspace,
  type TempEnvLocalWorkspace,
} from './helpers/tempEnvLocalWorkspace';

// The workspace whose `.env.local` the reader resolves; cleaned per test.
let workspace: TempEnvLocalWorkspace | undefined;

afterEach(() => {
  workspace?.cleanup();
  workspace = undefined;
});

describe('getPreferredVoyageKey', () => {
  // The plain case: an unquoted VOYAGE_API_KEY line yields its value.
  // The 'pa-' prefix is Voyage's real key shape — an sk- filter would drop it.
  it('returns the key from a plain VOYAGE_API_KEY line', () => {
    workspace = openTempEnvLocalWorkspace('VOYAGE_API_KEY=pa-plain-key-1234567890\n');

    expect(getPreferredVoyageKey()).toBe('pa-plain-key-1234567890');
  });

  // Values wrapped in double quotes must come back unwrapped, matching the
  // OpenAI reader's quote-stripping.
  it('strips double quotes around the value', () => {
    workspace = openTempEnvLocalWorkspace('VOYAGE_API_KEY="pa-double-quoted-key-123"\n');

    expect(getPreferredVoyageKey()).toBe('pa-double-quoted-key-123');
  });

  // Values wrapped in single quotes must come back unwrapped too.
  it('strips single quotes around the value', () => {
    workspace = openTempEnvLocalWorkspace("VOYAGE_API_KEY='pa-single-quoted-key-123'\n");

    expect(getPreferredVoyageKey()).toBe('pa-single-quoted-key-123');
  });

  // A commented-out key line is not configuration; it must be skipped.
  it('ignores commented-out VOYAGE_API_KEY lines', () => {
    workspace = openTempEnvLocalWorkspace('# VOYAGE_API_KEY=pa-commented-out-key-123\n');

    expect(getPreferredVoyageKey()).toBeUndefined();
  });

  // The template placeholder is not a real key and must be rejected, matching
  // the OpenAI reader's placeholder handling.
  it('rejects the placeholder value', () => {
    workspace = openTempEnvLocalWorkspace('VOYAGE_API_KEY=your-voyage-api-key-here\n');

    expect(getPreferredVoyageKey()).toBeUndefined();
  });

  // An empty value after the equals sign means unconfigured.
  it('treats an empty value as unconfigured', () => {
    workspace = openTempEnvLocalWorkspace('VOYAGE_API_KEY=\n');

    expect(getPreferredVoyageKey()).toBeUndefined();
  });

  // A missing `.env.local` is normal in local mode and must resolve to
  // undefined, never throw.
  it('returns undefined when .env.local does not exist', () => {
    workspace = openTempEnvLocalWorkspace();

    expect(getPreferredVoyageKey()).toBeUndefined();
  });

  // An OPENAI_API_KEY line must never satisfy the Voyage reader — the two
  // providers' keys are distinct configuration.
  it('does not return an OPENAI_API_KEY value as a Voyage key', () => {
    workspace = openTempEnvLocalWorkspace('OPENAI_API_KEY=sk-openai-only-key-1234567890\n');

    expect(getPreferredVoyageKey()).toBeUndefined();
  });

  // The reader must re-read the file on EVERY call: the settings UI rewrites
  // `.env.local` at runtime and the new key must take effect immediately.
  it('re-reads .env.local on every call so a rewritten key takes effect immediately', () => {
    workspace = openTempEnvLocalWorkspace('VOYAGE_API_KEY=pa-first-key-1234567890\n');

    expect(getPreferredVoyageKey()).toBe('pa-first-key-1234567890');

    // Simulate the settings UI replacing the key between two calls.
    workspace.writeEnvLocal('VOYAGE_API_KEY=pa-second-key-0987654321\n');

    expect(getPreferredVoyageKey()).toBe('pa-second-key-0987654321');
  });
});
