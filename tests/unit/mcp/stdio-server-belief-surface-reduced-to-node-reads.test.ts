/**
 * FAILING-FIRST red set for slice 9 — THE ENGINE AND BELIEF SERVICES LEAVE
 * THE FORK: the LOCAL MCP door's belief tool surface shrinks to nothing but
 * node reads (apps/mcp-server/stdio-server.js).
 *
 * samai owns the belief engine, so the stdio door's three belief tools die
 * with it:
 *  - rah_set_belief_fixed_credence,
 *  - rah_clear_belief_fixed_credence,
 *  - rah_get_belief_movements (its table is dropped in the same slice).
 * What the local door keeps of belief is the read-only presentation carried
 * on its node-read tools' answers — no belief tool remains registered.
 *
 * Seam (same as tests/unit/mcp/stdio-server-display-belief-surface.test.ts):
 * the spawned proxy is pointed at a local in-process HTTP stub via
 * RAH_MCP_TARGET_URL; no tool is called, so the stub serves nothing. The
 * spawned process is always terminated in the finally block.
 */

import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The three belief tools deleted from the local door with the engine.
const deletedStdioBeliefToolNames = [
  'rah_set_belief_fixed_credence',
  'rah_clear_belief_fixed_credence',
  'rah_get_belief_movements',
];

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

  const client = new Client({
    name: 'ra-h-stdio-belief-surface-reduction-test',
    version: '1.0.0',
  });
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

describe('local MCP door belief surface after the engine leaves the fork', () => {
  // The whole registry statement in one read: none of the three engine-era
  // belief tools is advertised any more, while an ordinary graph tool still
  // is — so the door is demonstrably alive and the absences are real.
  it('registers none of the fixed-credence tools nor the movements read', async () => {
    await withMcpClient(async (client) => {
      const advertisedToolNames = (await client.listTools()).tools.map((tool) => tool.name);

      for (const deletedStdioBeliefToolName of deletedStdioBeliefToolNames) {
        expect(
          advertisedToolNames,
          `${deletedStdioBeliefToolName} must leave the local door with the engine`
        ).not.toContain(deletedStdioBeliefToolName);
      }

      // Sanity survivor: the plain node read is untouched by this slice, so
      // an empty or broken listing cannot fake the absences above.
      expect(advertisedToolNames).toContain('rah_get_nodes');
    });
  });
});
