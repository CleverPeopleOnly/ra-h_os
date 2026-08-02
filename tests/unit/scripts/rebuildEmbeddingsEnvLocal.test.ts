/**
 * Integration spec: `scripts/rebuild-embeddings.ts` must load `.env.local`
 * from its working directory before any provider decision.
 *
 * The script runs under plain tsx, so today nothing loads `.env.local` — a
 * user whose whole profile lives there (EMBEDDING_PROFILE=voyage, no real
 * env vars) silently gets the default OpenAI embedding profile. This test
 * reproduces that user's machine in a throwaway workspace and asserts the
 * script's failure output proves the VOYAGE profile was picked up from
 * `.env.local`.
 *
 * How the run deterministically reaches the embedding-provider stage,
 * verified empirically against the current script:
 *   1. `bootstrap-local.mjs --profile voyage` builds the workspace: a real
 *      schema at SQLITE_DB_PATH and a `.env.local` with
 *      EMBEDDING_PROFILE=voyage and NO API key (`.env.example`'s key lines
 *      are empty, and empty values are "not configured").
 *   2. One node is inserted so the embed loop has work to do.
 *   3. The rebuild run gets SQLITE_VEC_EXTENSION_PATH pointed at the repo's
 *      real sqlite-vec extension: without a loadable extension the
 *      sqlite-client module crashes at import ("no such module: vec0")
 *      before the provider stage, so the extension is a hard prerequisite —
 *      hence the runIf guard below on platforms with no vendored build.
 *   4. Missing API keys fail BEFORE any network call in both providers, so
 *      the run is offline-deterministic: the embed step logs the provider's
 *      key error to stderr.
 *
 * RED expectation while unimplemented (verified by running the sequence):
 * the stripped child env has no EMBEDDING_PROFILE, `.env.local` is never
 * read, and stderr says "OpenAI API key not configured. Add OPENAI_API_KEY
 * to your .env.local file." with no Voyage mention.
 *
 * GREEN expectation (verified by simulating the loaded profile via the
 * child env): stderr says "Voyage API key not configured. Add
 * VOYAGE_API_KEY to your .env.local file." — and the embedding-provider
 * OpenAI message disappears. (The unrelated, non-fatal AI-analysis step
 * emits a DIFFERENT OpenAI message, "Add your key in Settings or
 * .env.local.", in both states — the assertions below are exact so it can
 * never satisfy or break them.)
 */

import { spawnSync } from 'node:child_process';
import BetterSqlite3Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

// Repo root, resolved from this test file's location (tests/unit/scripts/).
const repoRootDir = path.resolve(__dirname, '..', '..', '..');

// The bootstrap script that builds the workspace's schema and .env.local.
const bootstrapLocalScriptPath = path.join(repoRootDir, 'scripts', 'dev', 'bootstrap-local.mjs');

// The script under test.
const rebuildEmbeddingsScriptPath = path.join(repoRootDir, 'scripts', 'rebuild-embeddings.ts');

// tsx's CLI entry, invoked directly (instead of `npx tsx`) so the run uses
// the repo's pinned tsx regardless of PATH.
const tsxCliPath = path.join(repoRootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// The repo tsconfig, passed to tsx explicitly: with cwd inside the temp
// workspace, tsx would otherwise not find the `@/*` path aliases the
// rebuild script's imports need.
const repoTsconfigPath = path.join(repoRootDir, 'tsconfig.json');

// The repo's vendored sqlite-vec extension for this platform, mirroring the
// script's own per-platform filename resolution.
const platformVecExtensionFileName =
  process.platform === 'darwin' ? 'vec0.dylib' : process.platform === 'win32' ? 'vec0.dll' : 'vec0.so';
const repoVecExtensionPath = path.join(
  repoRootDir,
  'vendor',
  'sqlite-extensions',
  platformVecExtensionFileName
);

// Without a loadable sqlite-vec extension the rebuild script crashes at
// sqlite-client import, long before the provider stage this spec is about —
// so on platforms with no vendored extension (e.g. linux CI) the test skips.
const vecExtensionAvailableOnThisPlatform = fs.existsSync(repoVecExtensionPath);

// Per-test throwaway workspace directories, deleted after each test.
const workspaceDirsToCleanUp: string[] = [];

afterEach(() => {
  for (const workspaceDir of workspaceDirsToCleanUp.splice(0)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// Create a throwaway workspace holding a copy of the repo's .env.example
// (the bootstrap script's ensureEnvFile requires it).
function createRebuildTestWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-rebuild-envlocal-test-'));
  workspaceDirsToCleanUp.push(workspaceDir);
  fs.copyFileSync(path.join(repoRootDir, '.env.example'), path.join(workspaceDir, '.env.example'));
  return workspaceDir;
}

// Build the child env every run in this file uses: the parent env with every
// embedding/LLM/API-key/vector/sqlite variable stripped (the developer's
// shell carries real keys — the test must control both config sources), plus
// the workspace db path and the repo's vec extension.
function buildStrippedChildEnv(workspaceDir: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const envKeyToClear of Object.keys(childEnv)) {
    if (envKeyToClear.startsWith('EMBEDDING_') || envKeyToClear.startsWith('LLM_')) {
      delete childEnv[envKeyToClear];
    }
  }
  delete childEnv.VECTOR_BACKEND;
  delete childEnv.VOYAGE_API_KEY;
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.SQLITE_DB_PATH;
  delete childEnv.SQLITE_VEC_EXTENSION_PATH;
  childEnv.SQLITE_DB_PATH = path.join(workspaceDir, 'rah-rebuild-envlocal-test.sqlite');
  childEnv.SQLITE_VEC_EXTENSION_PATH = repoVecExtensionPath;
  return childEnv;
}

describe('rebuild-embeddings loads .env.local from its working directory', () => {
  // The whole feature in one user-shaped scenario: profile only in
  // .env.local, nothing in the real env — the script must fail asking for
  // the VOYAGE key, not the OpenAI one.
  it.runIf(vecExtensionAvailableOnThisPlatform)(
    'fails asking for VOYAGE_API_KEY when .env.local selects the voyage profile',
    () => {
      const workspaceDir = createRebuildTestWorkspace();
      const childEnv = buildStrippedChildEnv(workspaceDir);

      // Step 1: real schema + voyage .env.local (no API key) via bootstrap.
      const bootstrapRun = spawnSync(
        process.execPath,
        [bootstrapLocalScriptPath, '--profile', 'voyage'],
        { cwd: workspaceDir, env: childEnv, encoding: 'utf8' }
      );
      expect(bootstrapRun.status, `bootstrap stderr: ${bootstrapRun.stderr}`).toBe(0);

      // Step 2: one node so the embed loop calls the embedding provider.
      const workspaceDb = new BetterSqlite3Database(childEnv.SQLITE_DB_PATH as string);
      workspaceDb
        .prepare('INSERT INTO nodes (title) VALUES (?)')
        .run('node that forces one embedding-provider call');
      workspaceDb.close();

      // Step 3: the rebuild run under test, cwd'd into the workspace whose
      // .env.local holds the whole profile.
      const rebuildRun = spawnSync(
        process.execPath,
        [tsxCliPath, '--tsconfig', repoTsconfigPath, rebuildEmbeddingsScriptPath],
        { cwd: workspaceDir, env: childEnv, encoding: 'utf8' }
      );
      const rebuildOutput = `${rebuildRun.stdout}\n${rebuildRun.stderr}`;

      // The voyage profile was read from .env.local: the embedding step
      // failed reaching for the (absent) Voyage key.
      expect(rebuildOutput).toMatch(
        /Voyage API key not configured\. Add VOYAGE_API_KEY to your \.env\.local file\./
      );
      // Today's failure mode is gone: the embedding step no longer falls
      // back to the OpenAI profile. (Exact embedding-provider wording — the
      // non-fatal AI-analysis step's OpenAI message reads differently and
      // stays out of this assertion's reach.)
      expect(rebuildOutput).not.toContain('Add OPENAI_API_KEY to your .env.local file.');
    },
    90000
  );
});
