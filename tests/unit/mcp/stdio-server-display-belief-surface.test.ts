/**
 * The LOCAL MCP door's belief surface after the display-belief slice
 * (apps/mcp-server/stdio-server.js):
 *
 *  - rah_recompute_node_belief is GONE — the recompute surface dies with
 *    this slice, on BOTH app-backed doors, because a recompute that writes
 *    never-assessed would erase the display beliefs samai writes,
 *  - rah_write_display_belief is NOT here — the display write is a
 *    REMOTE-door-only tool (matching the journal tools' precedent: samai
 *    writes through the remote door),
 *  - the fixed-credence tools and the movement read survive unchanged.
 *
 * Seam (same as tests/unit/mcp/stdio-server-belief-tools.test.ts): the
 * spawned proxy is pointed at a local in-process HTTP stub via
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
  // The whole registry statement in one read: recompute gone, display write
  // never arrived (remote-only), and the surviving belief tools intact.
  it('drops rah_recompute_node_belief, gains no display write, and keeps the fixed/movement tools', async () => {
    await withMcpClient(async (client) => {
      const advertisedToolNames = (await client.listTools()).tools.map((tool) => tool.name);

      // The recompute surface dies on this door too.
      expect(advertisedToolNames).not.toContain('rah_recompute_node_belief');
      // The display write is the remote door's alone.
      expect(advertisedToolNames).not.toContain('rah_write_display_belief');
      // The surviving belief tools are untouched by this slice.
      expect(advertisedToolNames).toContain('rah_set_belief_fixed_credence');
      expect(advertisedToolNames).toContain('rah_clear_belief_fixed_credence');
      expect(advertisedToolNames).toContain('rah_get_belief_movements');
    });
  });
});
