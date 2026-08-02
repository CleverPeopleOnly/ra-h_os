/**
 * MOVEMENT reads through the app: GET /api/belief/movements
 * (app/api/belief/movements/route.ts — new, this is the red).
 *
 * A movement is the log of a node's credence changing. Both app-backed MCP
 * doors are HTTP proxies with no database of their own, so the new
 * rah_get_belief_movements tool needs this app endpoint to forward to. The
 * contract pinned here:
 *
 *  - ?node_id=N answers { count, movements } with each movement carrying the
 *    belief_movements columns by their EXACT names — id, node_id,
 *    from_credence, to_credence, trigger, occurred_at — newest first,
 *  - from_credence NULL (the node was previously ungraded) survives the read
 *    as null, never 0 — those are different histories,
 *  - only the asked-for node's movements are returned,
 *  - ?limit=N caps the page at the N NEWEST movements; an omitted limit
 *    applies a reasonable default that never exceeds the 1..100 cap,
 *  - a node with no movements answers an EMPTY list with 200 — a credence
 *    that has never changed is a success state, not an error,
 *  - a missing/non-numeric node_id and an out-of-range limit are refused
 *    with 400 rather than silently ignored.
 *
 * Seam: tests/unit/belief/helpers/tempBeliefDatabase.ts, with the route
 * module imported dynamically AFTER the temp database opens. The import path
 * names a module this MR must create, so today the import itself fails — a
 * feature-missing red, not a broken assertion.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';

import {
  openTempBeliefDatabase,
  type TempBeliefDatabase,
} from '../belief/helpers/tempBeliefDatabase';

// One movement entry as the route must report it: the belief_movements
// columns by their exact names.
interface BeliefMovementReadEntry {
  id: number;
  node_id: number;
  from_credence: number | null;
  to_credence: number;
  trigger: string;
  occurred_at: string;
}

// The reply envelope the route must answer with.
interface BeliefMovementsReadReply {
  count: number;
  movements: BeliefMovementReadEntry[];
}

// The live temp-database context for the current test.
let tempBeliefDb: TempBeliefDatabase;

// Import the route module under test, bound to THIS temp-database generation.
async function importBeliefMovementsRoute() {
  return import('../../../app/api/belief/movements/route');
}

// Drive the route's GET handler with a query string, as a door would call it.
async function getBeliefMovements(queryString: string): Promise<Response> {
  const { GET } = await importBeliefMovementsRoute();
  const movementsReadRequest = new Request(
    `http://127.0.0.1/api/belief/movements${queryString}`,
    { method: 'GET' }
  ) as unknown as NextRequest;
  return GET(movementsReadRequest);
}

// Seed one belief_movements row directly (the write paths have their own
// tests; this file is about the READ) and return its row id.
function seedBeliefMovementRow(options: {
  nodeId: number;
  fromCredence: number | null;
  toCredence: number;
  trigger: string;
  occurredAt: string;
}): number {
  const insertResult = tempBeliefDb.sqlite
    .prepare(
      `INSERT INTO belief_movements (node_id, from_credence, to_credence, "trigger", occurred_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      options.nodeId,
      options.fromCredence,
      options.toCredence,
      options.trigger,
      options.occurredAt
    );
  return Number(insertResult.lastInsertRowid);
}

// Seed a node plus a three-movement history (ungraded -> 0.3 -> 0.6 -> 0.4),
// returning the node id and the movement row ids oldest first.
function seedNodeWithThreeMovementHistory(): { nodeId: number; movementIdsOldestFirst: number[] } {
  const nodeId = tempBeliefDb.insertNodeFixture({ title: 'Node with a movement history' });
  const movementIdsOldestFirst = [
    seedBeliefMovementRow({
      nodeId,
      fromCredence: null,
      toCredence: 0.3,
      trigger: 'belief-recompute',
      occurredAt: '2026-07-01T10:00:00.000Z',
    }),
    seedBeliefMovementRow({
      nodeId,
      fromCredence: 0.3,
      toCredence: 0.6,
      trigger: 'belief-recompute',
      occurredAt: '2026-07-02T10:00:00.000Z',
    }),
    seedBeliefMovementRow({
      nodeId,
      fromCredence: 0.6,
      toCredence: 0.4,
      trigger: 'belief-fixed-credence-set',
      occurredAt: '2026-07-03T10:00:00.000Z',
    }),
  ];
  return { nodeId, movementIdsOldestFirst };
}

beforeEach(async () => {
  tempBeliefDb = await openTempBeliefDatabase();
});

afterEach(() => {
  tempBeliefDb.close();
});

describe('GET /api/belief/movements', () => {
  // The core read: every column by its exact name, newest movement first.
  it('answers the node movement log newest first, under the exact column names', async () => {
    const { nodeId, movementIdsOldestFirst } = seedNodeWithThreeMovementHistory();

    const movementsResponse = await getBeliefMovements(`?node_id=${nodeId}`);
    expect(movementsResponse.status).toBe(200);
    const movementsReply = (await movementsResponse.json()) as BeliefMovementsReadReply;

    expect(movementsReply.count).toBe(3);
    // Newest first: the seeded order reversed.
    expect(movementsReply.movements.map((movement) => movement.id)).toEqual(
      [...movementIdsOldestFirst].reverse()
    );
    // The newest movement, column for column.
    expect(movementsReply.movements[0]).toEqual({
      id: movementIdsOldestFirst[2],
      node_id: nodeId,
      from_credence: 0.6,
      to_credence: 0.4,
      trigger: 'belief-fixed-credence-set',
      occurred_at: '2026-07-03T10:00:00.000Z',
    });
    // Exactly the six columns — no extras, nothing renamed.
    expect(Object.keys(movementsReply.movements[0]).sort()).toEqual([
      'from_credence',
      'id',
      'node_id',
      'occurred_at',
      'to_credence',
      'trigger',
    ]);
  });

  // A null from_credence records "the node was previously ungraded". 0 would
  // instead claim it had been assessed and believed neither way.
  it('keeps a null from_credence as null, never 0', async () => {
    const { nodeId } = seedNodeWithThreeMovementHistory();

    const movementsResponse = await getBeliefMovements(`?node_id=${nodeId}`);
    const movementsReply = (await movementsResponse.json()) as BeliefMovementsReadReply;

    // The oldest movement is the one from ungraded, reported last.
    const movementFromUngraded = movementsReply.movements[2];
    expect(movementFromUngraded.from_credence).toBeNull();
    expect(movementFromUngraded.from_credence).not.toBe(0);
  });

  // Movements belong to their node: another node's history must not bleed in.
  it('returns only the asked-for node movements', async () => {
    const { nodeId } = seedNodeWithThreeMovementHistory();
    // A second node with its own single movement, which must stay invisible.
    const otherNodeId = tempBeliefDb.insertNodeFixture({ title: 'Unrelated node' });
    seedBeliefMovementRow({
      nodeId: otherNodeId,
      fromCredence: null,
      toCredence: 0.9,
      trigger: 'belief-recompute',
      occurredAt: '2026-07-04T10:00:00.000Z',
    });

    const movementsResponse = await getBeliefMovements(`?node_id=${nodeId}`);
    const movementsReply = (await movementsResponse.json()) as BeliefMovementsReadReply;

    expect(movementsReply.count).toBe(3);
    for (const reportedMovement of movementsReply.movements) {
      expect(reportedMovement.node_id).toBe(nodeId);
    }
  });

  // The page cap keeps the NEWEST movements — a truncated log must lose its
  // oldest entries, not its most recent ones.
  it('caps the page at the limit, keeping the newest movements', async () => {
    const { nodeId, movementIdsOldestFirst } = seedNodeWithThreeMovementHistory();

    const limitedResponse = await getBeliefMovements(`?node_id=${nodeId}&limit=2`);
    expect(limitedResponse.status).toBe(200);
    const limitedReply = (await limitedResponse.json()) as BeliefMovementsReadReply;

    expect(limitedReply.count).toBe(2);
    expect(limitedReply.movements.map((movement) => movement.id)).toEqual([
      movementIdsOldestFirst[2],
      movementIdsOldestFirst[1],
    ]);
  });

  // An omitted limit applies a reasonable default that never exceeds the
  // 1..100 cap: a long-lived node must not flood a caller with its whole log.
  it('never answers more than 100 movements when the limit is omitted', async () => {
    // A node whose credence has moved more times than the cap allows.
    const longLivedNodeId = tempBeliefDb.insertNodeFixture({ title: 'Long-lived node' });
    for (let movementIndex = 0; movementIndex < 105; movementIndex += 1) {
      seedBeliefMovementRow({
        nodeId: longLivedNodeId,
        fromCredence: movementIndex === 0 ? null : 0.1,
        toCredence: 0.1 + (movementIndex % 5) * 0.1,
        trigger: 'belief-recompute',
        occurredAt: `2026-07-01T10:${String(movementIndex % 60).padStart(2, '0')}:00.000Z`,
      });
    }

    const defaultLimitResponse = await getBeliefMovements(`?node_id=${longLivedNodeId}`);
    expect(defaultLimitResponse.status).toBe(200);
    const defaultLimitReply = (await defaultLimitResponse.json()) as BeliefMovementsReadReply;

    expect(defaultLimitReply.movements.length).toBeGreaterThan(0);
    expect(defaultLimitReply.movements.length).toBeLessThanOrEqual(100);
    expect(defaultLimitReply.count).toBe(defaultLimitReply.movements.length);
  });

  // No movements is a real, successful answer: the node's credence has simply
  // never changed. An error here would make "quiet" indistinguishable from
  // "broken".
  it('answers an empty list with 200 for a node with no movements', async () => {
    const quietNodeId = tempBeliefDb.insertNodeFixture({
      title: 'Node whose credence has never changed',
    });

    const emptyLogResponse = await getBeliefMovements(`?node_id=${quietNodeId}`);
    expect(emptyLogResponse.status).toBe(200);
    const emptyLogReply = (await emptyLogResponse.json()) as BeliefMovementsReadReply;

    expect(emptyLogReply.count).toBe(0);
    expect(emptyLogReply.movements).toEqual([]);
  });

  // A read that cannot name its node, or asks for an impossible page, is
  // refused rather than silently reinterpreted.
  it('refuses a missing or non-numeric node_id and an out-of-range limit with 400', async () => {
    const { nodeId } = seedNodeWithThreeMovementHistory();

    // Each malformed query string alongside why it must be refused.
    const malformedMovementQueries: Array<[string, string]> = [
      ['', 'a read without node_id names no node'],
      ['?node_id=abc', 'a non-numeric node_id names no node'],
      [`?node_id=${nodeId}&limit=0`, 'a page of zero movements is not a page'],
      [`?node_id=${nodeId}&limit=101`, 'the limit cap is 100'],
      [`?node_id=${nodeId}&limit=-5`, 'a negative limit is not a page size'],
    ];

    for (const [malformedQuery, refusalReason] of malformedMovementQueries) {
      const malformedResponse = await getBeliefMovements(malformedQuery);
      expect(malformedResponse.status, refusalReason).toBe(400);
    }
  });
});
