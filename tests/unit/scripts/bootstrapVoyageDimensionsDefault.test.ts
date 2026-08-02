/**
 * Spec for getEmbeddingDimensions() in scripts/dev/bootstrap-local.mjs:
 * a hand-written `EMBEDDING_PROFILE=voyage` with no EMBEDDING_DIMENSIONS
 * must default to 1024, because the voyage provider emits 1024-wide vectors
 * (src/services/embedding/provider.ts DEFAULT_VOYAGE_EMBEDDING_DIMENSIONS).
 *
 * Today the script defaults to 1536 unless the profile is
 * 'openai-compatible'/'custom', so that hand-written voyage profile creates
 * 1536-wide sqlite-vec tables the provider's vectors can never fit.
 *
 * Setup deliberately writes `.env.local` BY HAND rather than running
 * `--profile voyage`: the setup profile always writes
 * EMBEDDING_DIMENSIONS=1024 explicitly, which would mask the default under
 * test. The run needs a real loadable sqlite-vec extension (otherwise the
 * script logs-and-continues WITHOUT creating the vec tables and there is no
 * DDL to inspect), so SQLITE_VEC_EXTENSION_PATH points at the repo's
 * vendored build and the tests skip on platforms without one (e.g. linux
 * CI). The resulting declaration SQL is read from sqlite_master with plain
 * better-sqlite3 — readable without loading the extension.
 *
 * RED expectation while unimplemented (verified by running the sequence):
 * the voyage test finds `embedding FLOAT[1536]` where 1024 is expected. The
 * openai companion test passes today and after the change — it pins the
 * 1536 default so the fix cannot overshoot.
 */

import { spawnSync } from 'node:child_process';
import BetterSqlite3Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

// Repo root, resolved from this test file's location (tests/unit/scripts/).
const repoRootDir = path.resolve(__dirname, '..', '..', '..');

// The script under test.
const bootstrapLocalScriptPath = path.join(repoRootDir, 'scripts', 'dev', 'bootstrap-local.mjs');

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

// Without a loadable extension the script creates no vec tables at all, so
// there is nothing to assert on — skip on platforms with no vendored build.
const vecExtensionAvailableOnThisPlatform = fs.existsSync(repoVecExtensionPath);

// Per-test throwaway workspace directories, deleted after each test.
const workspaceDirsToCleanUp: string[] = [];

afterEach(() => {
  for (const workspaceDir of workspaceDirsToCleanUp.splice(0)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// Create a throwaway workspace holding a copy of the repo's .env.example
// (ensureEnvFile requires it) and a HAND-WRITTEN .env.local containing only
// the given embedding profile — deliberately no EMBEDDING_DIMENSIONS, so the
// script's dimension default is what shapes the vec tables.
function createWorkspaceWithHandWrittenProfile(embeddingProfile: string): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-bootstrap-dims-test-'));
  workspaceDirsToCleanUp.push(workspaceDir);
  fs.copyFileSync(path.join(repoRootDir, '.env.example'), path.join(workspaceDir, '.env.example'));
  fs.writeFileSync(
    path.join(workspaceDir, '.env.local'),
    `EMBEDDING_PROFILE=${embeddingProfile}\n`
  );
  return workspaceDir;
}

// Run the bootstrap script (no CLI args — the profile comes from the
// hand-written .env.local) and capture status/stderr. The child env strips
// every embedding/LLM/vector key the parent might carry, pins SQLITE_DB_PATH
// inside the workspace, and points SQLITE_VEC_EXTENSION_PATH at the repo's
// real extension so the vec tables actually get created.
function runBootstrapAgainstHandWrittenProfile(workspaceDir: string): {
  status: number | null;
  stderr: string;
  workspaceDbPath: string;
} {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const envKeyToClear of Object.keys(childEnv)) {
    if (envKeyToClear.startsWith('EMBEDDING_') || envKeyToClear.startsWith('LLM_')) {
      delete childEnv[envKeyToClear];
    }
  }
  delete childEnv.VECTOR_BACKEND;
  delete childEnv.SQLITE_DB_PATH;
  delete childEnv.SQLITE_VEC_EXTENSION_PATH;
  const workspaceDbPath = path.join(workspaceDir, 'rah-bootstrap-dims-test.sqlite');
  childEnv.SQLITE_DB_PATH = workspaceDbPath;
  childEnv.SQLITE_VEC_EXTENSION_PATH = repoVecExtensionPath;

  const scriptRun = spawnSync(process.execPath, [bootstrapLocalScriptPath], {
    cwd: workspaceDir,
    env: childEnv,
    encoding: 'utf8',
  });
  return { status: scriptRun.status, stderr: scriptRun.stderr, workspaceDbPath };
}

// Read vec_nodes' CREATE VIRTUAL TABLE declaration from sqlite_master. The
// declaration text is stored as plain schema SQL, so a read-only
// better-sqlite3 connection needs no vec extension to see it.
function readVecNodesTableDeclarationSql(workspaceDbPath: string): string {
  const workspaceDb = new BetterSqlite3Database(workspaceDbPath, { readonly: true });
  try {
    const vecNodesRow = workspaceDb
      .prepare("SELECT sql FROM sqlite_master WHERE name='vec_nodes'")
      .get() as { sql?: string } | undefined;
    return vecNodesRow?.sql ?? '';
  } finally {
    workspaceDb.close();
  }
}

describe('bootstrap-local dimension default per embedding profile', () => {
  // The fix under test: voyage joins the 1024-default group, so the vec
  // tables match the 1024-wide vectors the voyage provider emits.
  it.runIf(vecExtensionAvailableOnThisPlatform)(
    'creates FLOAT[1024] vec tables for a hand-written voyage profile with no dimensions',
    () => {
      const workspaceDir = createWorkspaceWithHandWrittenProfile('voyage');

      const scriptRun = runBootstrapAgainstHandWrittenProfile(workspaceDir);

      expect(scriptRun.status, `stderr: ${scriptRun.stderr}`).toBe(0);
      const vecNodesDeclarationSql = readVecNodesTableDeclarationSql(scriptRun.workspaceDbPath);
      expect(vecNodesDeclarationSql).toMatch(/FLOAT\[1024\]/);
    },
    30000
  );

  // Companion regression pin (passes today): the openai profile's 1536
  // default must survive the voyage fix untouched.
  it.runIf(vecExtensionAvailableOnThisPlatform)(
    'still creates FLOAT[1536] vec tables for a hand-written openai profile with no dimensions',
    () => {
      const workspaceDir = createWorkspaceWithHandWrittenProfile('openai');

      const scriptRun = runBootstrapAgainstHandWrittenProfile(workspaceDir);

      expect(scriptRun.status, `stderr: ${scriptRun.stderr}`).toBe(0);
      const vecNodesDeclarationSql = readVecNodesTableDeclarationSql(scriptRun.workspaceDbPath);
      expect(vecNodesDeclarationSql).toMatch(/FLOAT\[1536\]/);
    },
    30000
  );
});
