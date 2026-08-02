/**
 * Spec for loadEnvLocalIntoProcessEnv() in
 * src/services/config/loadEnvLocalIntoProcessEnv.ts (not yet implemented).
 *
 * scripts/rebuild-embeddings.ts runs under plain tsx, so unlike the Next.js
 * app nothing loads `.env.local` — a user whose whole embedding profile lives
 * there silently falls back to the OpenAI defaults. The script will call this
 * function first thing, BEFORE any provider/db decision. Its contract:
 *
 *   - Takes NO arguments and returns void; it resolves `.env.local` from
 *     process.cwd() at call time. That cwd resolution is load-bearing for
 *     this suite: the tempEnvLocalWorkspace helper spies process.cwd(), so an
 *     implementation that resolves the path any other way (e.g. letting
 *     process.loadEnvFile resolve its own default path, which ignores the
 *     spy) will fail these tests and is out of contract.
 *   - A key already present in process.env WINS over the file (Next.js
 *     .env.local semantics — this is what keeps the inline-env workaround
 *     `EMBEDDING_PROFILE=x npm run rebuild:embeddings` working).
 *   - Keys absent from process.env are populated from the file.
 *   - A missing `.env.local` is not an error: the function returns and
 *     process.env is left untouched.
 *   - Comment lines and empty lines in the file are ignored.
 *
 * RED expectation while unimplemented: the module does not exist, so this
 * whole file fails at import time — a valid feature-missing red.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvLocalIntoProcessEnv } from '@/services/config/loadEnvLocalIntoProcessEnv';
import {
  openTempEnvLocalWorkspace,
  type TempEnvLocalWorkspace,
} from '../embedding/helpers/tempEnvLocalWorkspace';

// Test-only env key names, prefixed so they can never collide with a real
// variable in the developer's or CI's environment.
const FILE_ONLY_KEY = 'RAH_TEST_ENVLOCAL_FILE_ONLY_KEY';
const ENV_PRESET_KEY = 'RAH_TEST_ENVLOCAL_ENV_PRESET_KEY';
const SECOND_FILE_KEY = 'RAH_TEST_ENVLOCAL_SECOND_FILE_KEY';
const COMMENTED_OUT_KEY = 'RAH_TEST_ENVLOCAL_COMMENTED_OUT_KEY';

// Every test-only key, deleted from process.env after each test so no test
// leaks state into the next.
const ALL_TEST_ENV_KEYS = [
  FILE_ONLY_KEY,
  ENV_PRESET_KEY,
  SECOND_FILE_KEY,
  COMMENTED_OUT_KEY,
];

// The workspace whose `.env.local` the loader resolves via the process.cwd()
// spy; cleaned per test. (tests/unit/setup.ts restores the cwd spy itself.)
let workspace: TempEnvLocalWorkspace | undefined;

afterEach(() => {
  for (const testEnvKey of ALL_TEST_ENV_KEYS) {
    delete process.env[testEnvKey];
  }
  workspace?.cleanup();
  workspace = undefined;
});

describe('loadEnvLocalIntoProcessEnv', () => {
  // The core fix for the live failure: a key that only exists in .env.local
  // (like the user's EMBEDDING_PROFILE) must land in process.env.
  it('populates a key absent from the environment with the file value', () => {
    workspace = openTempEnvLocalWorkspace(`${FILE_ONLY_KEY}=voyage\n`);
    delete process.env[FILE_ONLY_KEY];

    loadEnvLocalIntoProcessEnv();

    expect(process.env[FILE_ONLY_KEY]).toBe('voyage');
  });

  // Next.js .env.local semantics: the real environment always wins. This is
  // what keeps `EMBEDDING_PROFILE=x npm run rebuild:embeddings` working.
  it('leaves a key already present in the environment untouched', () => {
    workspace = openTempEnvLocalWorkspace(`${ENV_PRESET_KEY}=from-the-file\n`);
    process.env[ENV_PRESET_KEY] = 'from-the-real-environment';

    loadEnvLocalIntoProcessEnv();

    expect(process.env[ENV_PRESET_KEY]).toBe('from-the-real-environment');
  });

  // "Present" means the key exists at all — an empty-string environment
  // value is still a deliberate setting and must not be overwritten.
  it('treats an empty-string environment value as present, so it wins', () => {
    workspace = openTempEnvLocalWorkspace(`${ENV_PRESET_KEY}=from-the-file\n`);
    process.env[ENV_PRESET_KEY] = '';

    loadEnvLocalIntoProcessEnv();

    expect(process.env[ENV_PRESET_KEY]).toBe('');
  });

  // A machine with no .env.local at all (e.g. everything in the real env)
  // must run exactly as before: no crash, no env mutation.
  it('proceeds without throwing when .env.local does not exist', () => {
    workspace = openTempEnvLocalWorkspace();
    workspace.removeEnvLocal();
    delete process.env[FILE_ONLY_KEY];

    expect(() => loadEnvLocalIntoProcessEnv()).not.toThrow();
    expect(process.env[FILE_ONLY_KEY]).toBeUndefined();
  });

  // Comment lines are documentation, not settings: a commented-out pair must
  // not become an env var, while real pairs around it still load.
  it('ignores comment lines while still loading the real pairs', () => {
    workspace = openTempEnvLocalWorkspace(
      [
        '# The line below is deliberately commented out',
        `# ${COMMENTED_OUT_KEY}=must-not-load`,
        `${FILE_ONLY_KEY}=loaded-despite-comments`,
        '',
      ].join('\n')
    );
    delete process.env[COMMENTED_OUT_KEY];
    delete process.env[FILE_ONLY_KEY];

    loadEnvLocalIntoProcessEnv();

    expect(process.env[COMMENTED_OUT_KEY]).toBeUndefined();
    expect(process.env[FILE_ONLY_KEY]).toBe('loaded-despite-comments');
  });

  // Blank lines are formatting, not data: pairs on either side of them must
  // all load in a single call.
  it('ignores empty lines and loads every pair around them', () => {
    workspace = openTempEnvLocalWorkspace(
      [
        '',
        `${FILE_ONLY_KEY}=first-value`,
        '',
        '',
        `${SECOND_FILE_KEY}=second-value`,
        '',
      ].join('\n')
    );
    delete process.env[FILE_ONLY_KEY];
    delete process.env[SECOND_FILE_KEY];

    loadEnvLocalIntoProcessEnv();

    expect(process.env[FILE_ONLY_KEY]).toBe('first-value');
    expect(process.env[SECOND_FILE_KEY]).toBe('second-value');
  });
});
