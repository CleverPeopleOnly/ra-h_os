/**
 * Temp-workspace harness for the voyage embedding tests.
 *
 * The API-key readers in src/services/storage/openaiKeyServer.ts resolve
 * `.env.local` from process.cwd() on EVERY call (the settings UI writes keys
 * there at runtime). These tests must therefore control what that file
 * contains without ever touching the repo's real `.env.local`. This helper
 * creates a throwaway directory, optionally seeds a `.env.local` inside it,
 * and points process.cwd() at it via a spy. The global test setup
 * (tests/unit/setup.ts) restores the spy after each test.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';

// Everything a voyage test needs to drive one throwaway working directory
// whose `.env.local` the code under test will read.
export interface TempEnvLocalWorkspace {
  // Absolute path of the throwaway directory standing in for process.cwd().
  workspaceDir: string;
  // Absolute path of the workspace's `.env.local` (may not exist yet).
  envLocalPath: string;
  // Overwrite the workspace `.env.local` with the given contents.
  writeEnvLocal(contents: string): void;
  // Delete the workspace `.env.local`, simulating a missing file.
  removeEnvLocal(): void;
  // Delete the whole throwaway directory.
  cleanup(): void;
}

// Create the throwaway directory, seed `.env.local` when contents are given,
// and spy process.cwd() so `.env.local` resolution lands in the workspace.
export function openTempEnvLocalWorkspace(
  initialEnvLocalContents?: string
): TempEnvLocalWorkspace {
  // Fresh per-test directory under the OS tmpdir; never the real repo dir.
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rah-voyage-env-test-'));
  const envLocalPath = path.join(workspaceDir, '.env.local');

  if (initialEnvLocalContents !== undefined) {
    fs.writeFileSync(envLocalPath, initialEnvLocalContents);
  }

  // Every process.cwd() call during the test now answers with the workspace,
  // so key readers read the test-owned `.env.local`, not the repo's.
  vi.spyOn(process, 'cwd').mockReturnValue(workspaceDir);

  return {
    workspaceDir,
    envLocalPath,
    writeEnvLocal(contents: string) {
      fs.writeFileSync(envLocalPath, contents);
    },
    removeEnvLocal() {
      fs.rmSync(envLocalPath, { force: true });
    },
    cleanup() {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}
