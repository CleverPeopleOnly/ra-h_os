/**
 * THE TWO APP-BACKED MCP DOORS DELIBERATELY DIVERGE ON BEARER AUTH, AND THE
 * DIVERGENCE IS STATED, NOT ACCIDENTAL.
 *
 * The remote door (app/api/mcp/route.ts) crosses a network, so it carries the
 * bearer lock: RAH_MCP_DOOR_TOKEN, fail-closed when unconfigured. The local
 * door (apps/mcp-server/stdio-server.js) is spawned by the client it serves
 * and speaks over its own stdio — no socket, no network, nothing for a bearer
 * token to protect — so it is exempt. An exemption that lives only in
 * someone's head is indistinguishable from a door that was forgotten; this
 * file pins that each side of the divergence says so in its own artifact.
 *
 * Seam: source text. The doors' behaviour is pinned elsewhere
 * (remote-mcp-route-bearer-auth.test.ts, remote-mcp-route-fail-closed.test.ts);
 * what THIS file guards is the recorded statement of the split — in the local
 * door's header, in .env.example, and in docs/8_mcp.md — so the exemption and
 * the operator's setup path cannot silently fall out of the repo.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Repo root, resolved from this test file's location so the pins survive
// being run from any working directory.
const repoRoot = path.resolve(__dirname, '../../..');

// Read one repo artifact as text for source pinning.
function readRepoArtifact(repoRelativePath: string): string {
  return readFileSync(path.join(repoRoot, repoRelativePath), 'utf8');
}

describe('the two app-backed doors diverge on bearer auth, and say so', () => {
  // The remote door carries the lock. Pinned by the guard's name and the env
  // var — if the guard is ever renamed or removed, this fails and the
  // divergence statement must be revisited rather than left stale.
  it('remote door: the bearer lock is present and keyed on RAH_MCP_DOOR_TOKEN', () => {
    const remoteDoorSource = readRepoArtifact('app/api/mcp/route.ts');
    expect(remoteDoorSource).toContain('RAH_MCP_DOOR_TOKEN');
    expect(remoteDoorSource).toContain('refuseUnlessDoorConfiguredAndBearerValid');
  });

  // The local door's exemption is stated in its own header: it must name the
  // env var it deliberately does not read, and say why it is exempt (it
  // serves only the process that spawned it — local-only, no network).
  it('local door: the header states its local-only exemption from the bearer lock', () => {
    const localDoorSource = readRepoArtifact('apps/mcp-server/stdio-server.js');
    expect(
      localDoorSource,
      'the local door must name RAH_MCP_DOOR_TOKEN as the lock it is exempt from'
    ).toContain('RAH_MCP_DOOR_TOKEN');
    expect(
      localDoorSource,
      'the exemption must be stated as local-only, not left implicit'
    ).toMatch(/local-only/i);
  });

  // The operator's setup path: .env.example documents the variable, so a
  // fresh deploy learns about the fail-closed door before hitting the 503.
  it('.env.example documents RAH_MCP_DOOR_TOKEN and the fail-closed behaviour', () => {
    const envExample = readRepoArtifact('.env.example');
    expect(envExample).toContain('RAH_MCP_DOOR_TOKEN');
    expect(
      envExample,
      'the fail-closed consequence of leaving the token unset must be stated'
    ).toMatch(/fail(s)?[ -]closed/i);
  });

  // The MCP doc records the whole split in one place: the lock, the
  // fail-closed default, and the local door's exemption.
  it('docs/8_mcp.md records the bearer lock and the local-only exemption', () => {
    const mcpDoc = readRepoArtifact('docs/8_mcp.md');
    expect(mcpDoc).toContain('RAH_MCP_DOOR_TOKEN');
    expect(mcpDoc).toMatch(/fail(s)?[ -]closed/i);
    expect(
      mcpDoc,
      'the doc must state the local door is exempt, not merely omit it'
    ).toMatch(/exempt/i);
  });
});
