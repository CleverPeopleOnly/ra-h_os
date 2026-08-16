/**
 * The LOCAL MCP door's belief surface after the display-belief slice
 * (apps/mcp-server/stdio-server.js):
 *
 *  - rah_recompute_node_belief is GONE — the recompute surface died with
 *    that slice, on BOTH app-backed doors, because a recompute that writes
 *    never-assessed would erase the display beliefs samai writes,
 *  - rah_write_display_belief is NOT here — the display write is a
 *    REMOTE-door-only tool (matching the journal tools' precedent: samai
 *    writes through the remote door).
 *
 * deleted in the engine-leaves-the-fork slice: the pins that the
 * fixed-credence tools and the movement read survive — those tools left both
 * app doors with the engine (their absence is pinned in
 * stdio-server-belief-surface-reduced-to-node-reads.test.ts).
 *
 * Seam: the spawned proxy is pointed at a local in-process HTTP stub via
 * RAH_MCP_TARGET_URL; no tool is called, so the stub serves nothing. The
 * spawned process is always terminated in the finally block.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The in-process HTTP stub standing in for the running RA-H app. It serves
// nothing: this file only asks the door to describe itself.
let apiStubServer: http.Server;
// Base URL the spawned proxy is pointed at via RAH_MCP_TARGET_URL.
let apiStubBaseUrl = '';

// Spawn the proxy against the stub, run the callback with a connected MCP
// client, then ALWAYS close the transport (terminating the proxy process).
async function withMcpClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), 'apps', 'mcp-server', 'stdio-server.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAH_MCP_TARGET_URL: apiStubBaseUrl,
    } as Record<string, string>,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'ra-h-stdio-display-belief-surface-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

beforeAll(async () => {
  apiStubServer = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'This file calls no tool.' }));
  });
  await new Promise<void>((resolve) => {
    apiStubServer.listen(0, '127.0.0.1', () => resolve());
  });
  apiStubBaseUrl = `http://127.0.0.1:${(apiStubServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    apiStubServer.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('local MCP door belief surface after the display-belief slice', () => {
  // The whole registry statement in one read: recompute gone and the display
  // write never arrived (remote-only) — with an ordinary graph tool present
  // so the listing is demonstrably live rather than empty.
  it('drops rah_recompute_node_belief and gains no display write', async () => {
    await withMcpClient(async (client) => {
      const advertisedToolNames = (await client.listTools()).tools.map((tool) => tool.name);

      // The recompute surface died on this door too.
      expect(advertisedToolNames).not.toContain('rah_recompute_node_belief');
      // The display write is the remote door's alone.
      expect(advertisedToolNames).not.toContain('rah_write_display_belief');
      // And so is the fixed-credence pair the belief-storage split added:
      // samai asserts and clears a hand-decreed credence through the remote
      // door only, so the local door gains neither tool.
      expect(advertisedToolNames).not.toContain('rah_assert_fixed_credence');
      expect(advertisedToolNames).not.toContain('rah_clear_fixed_credence');
      // Sanity survivor: the plain node read keeps the absences honest.
      expect(advertisedToolNames).toContain('rah_get_nodes');
    });
  });
});
