/**
 * The remote MCP door's node reads carry the STORED belief_uncertainty after
 * the display-belief slice: rah_get_nodes stands on the app's node read,
 * whose rows now carry the stored column instead of the dead evidence
 * masses, and the shared node-read mapper passes the stored value through.
 *
 * Pins, end to end through the door:
 *  - a graded non-fixed row's stored belief_uncertainty reaches the reply
 *    verbatim, beside a never-assessed sibling's null in the same call,
 *  - a row still carrying stowaway mass keys but no stored column answers
 *    null — the derivation is dead, not dormant.
 *
 * (The fixed-node 0 is unchanged mapper behaviour; its pin lives in the
 * reshaped uncertainty node-read tests.)
 *
 * Seam: tests/unit/mcp/helpers/remoteMcpDoorHarness.ts, with the stubbed app
 * serving GET /api/nodes/[id] rows shaped like the post-slice node read.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  startRemoteMcpDoorHarness,
  type RemoteMcpDoorHarness,
} from './helpers/remoteMcpDoorHarness';

// The live harness for this file.
let remoteMcpDoorHarness: RemoteMcpDoorHarness;

// One node as rah_get_nodes reports it, belief fields included.
interface ReportedNode {
  id: number;
  belief_credence: number | null;
  belief_uncertainty: number | null;
  belief_credence_is_fixed: number;
}

// A graded non-fixed node as the post-slice app serves it: the stored
// belief_uncertainty rides the row, no mass columns exist.
const storedUncertaintyNodeRecord = {
  id: 41,
  title: 'Node whose uncertainty samai stored',
  source: 'Fixture source text.',
  description: null,
  link: null,
  metadata: null,
  created_at: '2026-08-01T08:00:00.000Z',
  updated_at: '2026-08-05T08:00:00.000Z',
  belief_credence: 0.62,
  belief_computed_at: '2026-08-05T10:00:00.000Z',
  belief_credence_is_fixed: 0,
  belief_uncertainty: 0.42,
};

// A node nobody has assessed: every display column null.
const neverAssessedNodeRecord = {
  id: 42,
  title: 'Node nobody has assessed',
  source: null,
  description: null,
  link: null,
  metadata: null,
  created_at: '2026-08-02T08:00:00.000Z',
  updated_at: '2026-08-02T08:00:00.000Z',
  belief_credence: null,
  belief_computed_at: null,
  belief_credence_is_fixed: 0,
  belief_uncertainty: null,
};

// A row still carrying stowaway mass keys (a caller predating the slice, or
// a stale cache) and NO stored column: the dead derivation must not wake up
// and answer 2/(3+1+2) = 0.333... for it.
const stowawayMassNodeRecord = {
  id: 43,
  title: 'Node with stowaway mass keys',
  source: null,
  description: null,
  link: null,
  metadata: null,
  created_at: '2026-08-03T08:00:00.000Z',
  updated_at: '2026-08-03T08:00:00.000Z',
  belief_credence: 0.3333,
  belief_computed_at: '2026-08-03T10:00:00.000Z',
  belief_credence_is_fixed: 0,
  belief_evidence_for_mass: 3,
  belief_evidence_against_mass: 1,
};

// Every node the stubbed app serves, keyed by the id in the URL.
const nodeRecordsTheAppServes: Record<string, Record<string, unknown>> = {
  '41': storedUncertaintyNodeRecord,
  '42': neverAssessedNodeRecord,
  '43': stowawayMassNodeRecord,
};

// Drive rah_get_nodes and hand back the nodes it reported.
async function callGetNodesTool(client: Client, nodeIds: number[]): Promise<ReportedNode[]> {
  const toolResult = await client.callTool({ name: 'rah_get_nodes', arguments: { nodeIds } });
  expect((toolResult as { isError?: boolean }).isError ?? false).toBe(false);
  const structuredContent = toolResult.structuredContent as { nodes?: ReportedNode[] } | undefined;
  return structuredContent?.nodes ?? [];
}

beforeAll(async () => {
  remoteMcpDoorHarness = await startRemoteMcpDoorHarness();
  remoteMcpDoorHarness.respondWith((request) => {
    const nodeIdMatch = /^\/api\/nodes\/(\d+)$/.exec(request.pathname);
    if (request.method === 'GET' && nodeIdMatch) {
      const nodeRecord = nodeRecordsTheAppServes[nodeIdMatch[1]];
      if (!nodeRecord) {
        return undefined;
      }
      return { payload: { success: true, node: nodeRecord } };
    }
    return undefined;
  });
});

afterAll(async () => {
  await remoteMcpDoorHarness.stop();
});

beforeEach(() => {
  remoteMcpDoorHarness.resetRecordedAppRequests();
});

describe('remote MCP door rah_get_nodes carries the stored belief_uncertainty', () => {
  // The stored value verbatim, per node: a graded row's number beside a
  // never-assessed sibling's null in one call — never smeared, never derived.
  it('reports the stored uncertainty of a graded node and null for a never-assessed one', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const reportedNodes = await callGetNodesTool(client, [41, 42]);

      const reportedGradedNode = reportedNodes.find((node) => node.id === 41);
      const reportedNeverAssessedNode = reportedNodes.find((node) => node.id === 42);
      expect(reportedGradedNode?.belief_uncertainty).toBe(0.42);
      expect(reportedGradedNode?.belief_credence).toBe(0.62);
      // Present and explicitly null — never 0, never missing.
      expect(reportedNeverAssessedNode?.belief_uncertainty).toBeNull();
    });
  });

  // The derivation is dead: stowaway mass keys on a row without the stored
  // column answer null, never a mass-derived number.
  it('answers null for a row carrying stowaway mass keys and no stored uncertainty', async () => {
    await remoteMcpDoorHarness.withRemoteMcpClient(async (client) => {
      const reportedNodes = await callGetNodesTool(client, [43]);
      expect(reportedNodes).toHaveLength(1);
      expect(reportedNodes[0].belief_uncertainty).toBeNull();
    });
  });
});
