/**
 * Spec for `scripts/dev/bootstrap-local.mjs --profile voyage`.
 *
 * The voyage setup profile must:
 *   - be a supported --profile value,
 *   - write EMBEDDING_PROFILE=voyage, EMBEDDING_MODEL=voyage-4-large,
 *     EMBEDDING_DIMENSIONS=1024, VECTOR_BACKEND=sqlite-vec to .env.local,
 *   - leave every LLM_* key untouched (Voyage has no chat models, so the
 *     user's existing LLM configuration must survive), and
 *   - be offered by both the unsupported-profile error and the
 *     choose-a-profile guidance text.
 *
 * The script runs end-to-end in a child process against a throwaway
 * workspace directory holding a copy of .env.example, with SQLITE_DB_PATH
 * pointed at a temp sqlite file. The script logs-and-continues when the
 * sqlite-vec extension is absent in that cwd, so running it there is safe.
 *
 * RED expectation while unimplemented: --profile voyage exits 1 as an
 * unsupported profile, and neither error text mentions voyage.
 */

import { spawnSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

// Repo root, resolved from this test file's location (tests/unit/scripts/).
const repoRootDir = path.resolve(__dirname, '..', '..', '..');

// The script under test, always addressed absolutely so node resolves its
// better-sqlite3 import from the repo's node_modules.
const bootstrapLocalScriptPath = path.join(repoRootDir, 'scripts', 'dev', 'bootstrap-local.mjs');

// Per-test throwaway workspace directories, deleted after each test.
const workspaceDirsToCleanUp: string[] = [];

afterEach(() => {
  for (const workspaceDir of workspaceDirsToCleanUp.splice(0)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// Create a throwaway workspace holding a copy of the repo's .env.example
// (ensureEnvFile requires it) and, when given, a pre-seeded .env.local.
function createBootstrapWorkspace(preSeededEnvLocalContents?: string): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-bootstrap-voyage-test-'));
  workspaceDirsToCleanUp.push(workspaceDir);
  fs.copyFileSync(path.join(repoRootDir, '.env.example'), path.join(workspaceDir, '.env.example'));
  if (preSeededEnvLocalContents !== undefined) {
    fs.writeFileSync(path.join(workspaceDir, '.env.local'), preSeededEnvLocalContents);
  }
  return workspaceDir;
}

// Run the bootstrap script in the workspace and capture status/stdout/stderr.
// The child env strips every embedding/LLM key the parent might carry (the
// script merges process.env over .env.local, and the test must control both
// sources) and pins SQLITE_DB_PATH inside the workspace.
function runBootstrapLocalScript(
  workspaceDir: string,
  cliArgs: string[]
): { status: number | null; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const envKeyToClear of Object.keys(childEnv)) {
    if (envKeyToClear.startsWith('EMBEDDING_') || envKeyToClear.startsWith('LLM_')) {
      delete childEnv[envKeyToClear];
    }
  }
  delete childEnv.VECTOR_BACKEND;
  childEnv.SQLITE_DB_PATH = path.join(workspaceDir, 'rah-bootstrap-voyage-test.sqlite');

  const scriptRun = spawnSync(process.execPath, [bootstrapLocalScriptPath, ...cliArgs], {
    cwd: workspaceDir,
    env: childEnv,
    encoding: 'utf8',
  });
  return { status: scriptRun.status, stdout: scriptRun.stdout, stderr: scriptRun.stderr };
}

// Parse the workspace's resulting .env.local into key/value pairs so tests
// can assert exactly what the script wrote.
function parseWorkspaceEnvLocal(workspaceDir: string): Record<string, string> {
  const envLocalContents = fs.readFileSync(path.join(workspaceDir, '.env.local'), 'utf8');
  const parsedEnvEntries: Record<string, string> = {};
  for (const line of envLocalContents.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;
    const equalsIndex = trimmedLine.indexOf('=');
    if (equalsIndex === -1) continue;
    parsedEnvEntries[trimmedLine.slice(0, equalsIndex).trim()] = trimmedLine
      .slice(equalsIndex + 1)
      .trim();
  }
  return parsedEnvEntries;
}

// The pre-seeded LLM configuration a voyage setup must leave untouched.
const PRE_SEEDED_LLM_ENV_LOCAL_LINES = [
  'LLM_PROFILE=openai-compatible',
  'LLM_BASE_URL=http://127.0.0.1:11434/v1',
  'LLM_MODEL=qwen3:4b',
  '',
].join('\n');

describe('bootstrap-local --profile voyage', () => {
  // The core contract: voyage is a supported profile and writes the four
  // embedding settings that match the 1024-dim sqlite-vec tables.
  it(
    'exits cleanly and writes the voyage embedding settings to .env.local',
    () => {
      const workspaceDir = createBootstrapWorkspace(PRE_SEEDED_LLM_ENV_LOCAL_LINES);

      const scriptRun = runBootstrapLocalScript(workspaceDir, ['--profile', 'voyage']);

      expect(scriptRun.status, `stderr: ${scriptRun.stderr}`).toBe(0);
      const writtenEnvLocal = parseWorkspaceEnvLocal(workspaceDir);
      expect(writtenEnvLocal.EMBEDDING_PROFILE).toBe('voyage');
      expect(writtenEnvLocal.EMBEDDING_MODEL).toBe('voyage-4-large');
      expect(writtenEnvLocal.EMBEDDING_DIMENSIONS).toBe('1024');
      expect(writtenEnvLocal.VECTOR_BACKEND).toBe('sqlite-vec');
    },
    30000
  );

  // Voyage has no chat models, so the voyage profile must not set or alter
  // any LLM_* key — the user's existing LLM configuration must survive.
  it(
    'leaves the pre-existing LLM_* configuration untouched',
    () => {
      const workspaceDir = createBootstrapWorkspace(PRE_SEEDED_LLM_ENV_LOCAL_LINES);

      const scriptRun = runBootstrapLocalScript(workspaceDir, ['--profile', 'voyage']);

      // Status must be asserted here too: a failed run that never rewrites
      // .env.local would otherwise pass the untouched-LLM assertions vacuously.
      expect(scriptRun.status, `stderr: ${scriptRun.stderr}`).toBe(0);
      const writtenEnvLocal = parseWorkspaceEnvLocal(workspaceDir);
      expect(writtenEnvLocal.LLM_PROFILE).toBe('openai-compatible');
      expect(writtenEnvLocal.LLM_BASE_URL).toBe('http://127.0.0.1:11434/v1');
      expect(writtenEnvLocal.LLM_MODEL).toBe('qwen3:4b');
      // No LLM_ key beyond the three pre-seeded ones may appear.
      const llmKeysAfterRun = Object.keys(writtenEnvLocal).filter(envKey =>
        envKey.startsWith('LLM_')
      );
      expect(llmKeysAfterRun.sort()).toEqual(['LLM_BASE_URL', 'LLM_MODEL', 'LLM_PROFILE']);
    },
    30000
  );

  // A user who typos a profile must be offered voyage among the valid options.
  it(
    'lists voyage among the options in the unsupported-profile error',
    () => {
      const workspaceDir = createBootstrapWorkspace();

      const scriptRun = runBootstrapLocalScript(workspaceDir, [
        '--profile',
        'not-a-real-profile',
      ]);

      expect(scriptRun.status).toBe(1);
      expect(scriptRun.stderr).toMatch(/voyage/);
    },
    30000
  );

  // A user who runs setup with no profile at all gets the choose-a-profile
  // guidance; that guidance must offer the voyage option too.
  it(
    'mentions the voyage option in the choose-an-embedding-profile guidance',
    () => {
      // No pre-seeded .env.local and no EMBEDDING_PROFILE anywhere, so the
      // script must stop at assertEmbeddingProfileSelected.
      const workspaceDir = createBootstrapWorkspace();

      const scriptRun = runBootstrapLocalScript(workspaceDir, []);

      expect(scriptRun.status).toBe(1);
      expect(scriptRun.stderr).toMatch(/--profile voyage/);
    },
    30000
  );
});
