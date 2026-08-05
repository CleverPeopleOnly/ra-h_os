/**
 * Tests for the remote MCP door FAILING CLOSED when it has no token configured
 * (app/api/mcp/route.ts).
 *
 * The door is the HTTP face of a PRIVATE knowledge store. Its bearer lock is
 * keyed on the env var RAH_MCP_DOOR_TOKEN — and today, when that variable is
 * unset or empty, the door serves UNAUTHENTICATED: the worst possible failure
 * mode, because one missing env var on a deploy silently publishes the whole
 * store. This file pins the replacement behaviour: a door with no token
 * configured refuses to serve entirely.
 *
 * The refusal vocabulary matters and is pinned deliberately:
 *  - An unconfigured door is a SERVER misconfiguration, not a credential
 *    failure, so the refusal is HTTP 503 (the service is not in a state to
 *    serve), never 401.
 *  - No `WWW-Authenticate` challenge rides the 503: a challenge invites the
 *    caller to retry with a credential, and there is no credential that can
 *    open an unconfigured door.
 *  - The refusal message names RAH_MCP_DOOR_TOKEN, so the OPERATOR reading it
 *    can tell "the server is misconfigured" apart from "my credential is
 *    wrong" at a glance.
 *  - A request carrying a bearer credential is refused with the IDENTICAL
 *    message as one carrying none — there is no token to be right against,
 *    and the responses must teach a caller nothing about server state beyond
 *    "unconfigured".
 *  - The refusal is also logged server-side via console.error, naming
 *    RAH_MCP_DOOR_TOKEN, so the misconfiguration is visible in the deploy's
 *    logs and not only to whoever happens to call the door.
 *  - OPTIONS stays open even unconfigured: a preflight reveals nothing about
 *    the store, and breaking it would only mask the real refusal behind a
 *    CORS error.
 *
 * Seam: the route's exported POST/GET/OPTIONS handlers are driven directly
 * with plain `new Request(...)` objects — the same seam as
 * remote-mcp-route-bearer-auth.test.ts, and for the same reason: the refusal
 * happens before any MCP handshake, and this file must inspect the raw
 * status, headers, and body. No real app, no socket, and no database is
 * involved.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { GET, OPTIONS, POST } from '../../../app/api/mcp/route';

// A syntactically fine Bearer credential. With no door token configured there
// is nothing for it to match — the door must refuse it exactly like a request
// carrying no credential at all.
const someBearerCredential = 'Bearer some-credential-the-door-cannot-check';

// The RAH_MCP_DOOR_TOKEN value present before this file ran, restored exactly
// after — absent stays absent.
let doorTokenBeforeThisSuite: string | undefined;

// The RAH_MCP_TARGET_URL value present before this file ran, restored exactly
// after. It is set to a dummy so the GET handler's getBaseUrl never
// dereferences request.nextUrl on the plain Request objects this file builds;
// nothing in this file ever performs a network call to it.
let targetUrlBeforeThisSuite: string | undefined;

// The JSON-RPC error body shape a transport-level refusal must carry.
type JsonRpcErrorBody = {
  jsonrpc: string;
  error: { code: number; message: string };
};

// Build a minimal JSON-RPC `initialize` POST aimed at the door, optionally
// carrying an Authorization header. Initialize is used because it is the very
// first message any client sends — exactly what an unconfigured door must
// refuse before any handshake begins.
function buildInitializePostRequest(authorizationHeader?: string): NextRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (authorizationHeader !== undefined) {
    headers.Authorization = authorizationHeader;
  }
  return new Request('http://127.0.0.1/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'ra-h-remote-mcp-fail-closed-test', version: '1.0.0' },
      },
    }),
  }) as unknown as NextRequest;
}

// Build a GET aimed at the door's discovery listing. No Authorization variant
// is needed here: an unconfigured door refuses the listing regardless.
function buildDiscoveryGetRequest(): NextRequest {
  return new Request('http://127.0.0.1/api/mcp', {
    method: 'GET',
  }) as unknown as NextRequest;
}

// Assert one response IS the unconfigured-door refusal — HTTP 503, NO
// WWW-Authenticate challenge (this is misconfiguration, not a credential
// challenge), a JSON-RPC error body naming RAH_MCP_DOOR_TOKEN, and no
// `result` key (the marker that would mean an MCP payload was served) — and
// return the refusal message so callers can compare messages across cases.
async function expectUnconfiguredDoorRefusalAndReadMessage(response: Response): Promise<string> {
  expect(
    response.status,
    'a door with no token configured must refuse to serve with HTTP 503'
  ).toBe(503);
  expect(
    response.headers.get('www-authenticate'),
    'an unconfigured door is misconfiguration, not a credential challenge — no WWW-Authenticate header'
  ).toBeNull();

  const refusalBody = (await response.json()) as JsonRpcErrorBody & { result?: unknown };
  expect(refusalBody.jsonrpc, 'the refusal body must be JSON-RPC framed').toBe('2.0');
  expect(typeof refusalBody.error?.code, 'the refusal must carry an error code').toBe('number');
  expect(typeof refusalBody.error?.message, 'the refusal must carry an error message').toBe(
    'string'
  );
  expect(
    refusalBody.error.message,
    'the refusal message must name RAH_MCP_DOOR_TOKEN so the operator can tell configuration failure from credential failure'
  ).toContain('RAH_MCP_DOOR_TOKEN');
  expect(
    refusalBody.result,
    'an unconfigured door must never serve an MCP result'
  ).toBeUndefined();

  return refusalBody.error.message;
}

beforeAll(() => {
  doorTokenBeforeThisSuite = process.env.RAH_MCP_DOOR_TOKEN;

  targetUrlBeforeThisSuite = process.env.RAH_MCP_TARGET_URL;
  process.env.RAH_MCP_TARGET_URL = 'http://127.0.0.1:1';
});

// Every test in this file exercises the UNCONFIGURED door, so the token is
// deleted before each test; the one empty-string case sets '' itself.
beforeEach(() => {
  delete process.env.RAH_MCP_DOOR_TOKEN;
});

// Any console.error spy a test installed is torn down here, so no test
// silences the logs of the next.
afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (doorTokenBeforeThisSuite === undefined) {
    delete process.env.RAH_MCP_DOOR_TOKEN;
  } else {
    process.env.RAH_MCP_DOOR_TOKEN = doorTokenBeforeThisSuite;
  }

  if (targetUrlBeforeThisSuite === undefined) {
    delete process.env.RAH_MCP_TARGET_URL;
  } else {
    process.env.RAH_MCP_TARGET_URL = targetUrlBeforeThisSuite;
  }
});

describe('remote MCP door fails closed when RAH_MCP_DOOR_TOKEN is not configured', () => {
  // The core of fail-closed: with the token unset, a POST that today would be
  // served unauthenticated must instead be refused entirely — 503, a JSON-RPC
  // error naming the missing variable, before any MCP handshake happens.
  it('refuses a POST with a 503 naming RAH_MCP_DOOR_TOKEN when the token is unset', async () => {
    const response = await POST(buildInitializePostRequest());
    await expectUnconfiguredDoorRefusalAndReadMessage(response);
  });

  // The discovery listing is metadata about a private store — an unconfigured
  // door must not serve even that. Same 503 shape as the POST refusal.
  it('refuses a GET of the discovery listing with the same 503 when the token is unset', async () => {
    const response = await GET(buildDiscoveryGetRequest());
    await expectUnconfiguredDoorRefusalAndReadMessage(response);
  });

  // An EMPTY-string token is the same misconfiguration as an unset one — an
  // empty secret is no secret — and must behave identically: same 503 on POST
  // and GET, same message as the unset case.
  it('treats an empty-string RAH_MCP_DOOR_TOKEN exactly like an unset one', async () => {
    // Read the unset-case message first, so the empty-string refusal can be
    // pinned as IDENTICAL and not merely same-shaped.
    const unsetTokenMessage = await expectUnconfiguredDoorRefusalAndReadMessage(
      await POST(buildInitializePostRequest())
    );

    process.env.RAH_MCP_DOOR_TOKEN = '';

    const emptyTokenPostMessage = await expectUnconfiguredDoorRefusalAndReadMessage(
      await POST(buildInitializePostRequest())
    );
    expect(
      emptyTokenPostMessage,
      'an empty-string token must refuse with exactly the unset-case message'
    ).toBe(unsetTokenMessage);

    const emptyTokenGetMessage = await expectUnconfiguredDoorRefusalAndReadMessage(
      await GET(buildDiscoveryGetRequest())
    );
    expect(
      emptyTokenGetMessage,
      'the GET refusal under an empty-string token must read exactly like the POST refusal'
    ).toBe(unsetTokenMessage);
  });

  // No oracle: a request that CARRIES a bearer credential is still refused
  // with the identical 503 and message — there is no token for the credential
  // to be right against, and the door must teach the caller nothing about
  // server state beyond "unconfigured".
  it('refuses a POST carrying a bearer credential with the identical 503 refusal', async () => {
    const credentialFreeMessage = await expectUnconfiguredDoorRefusalAndReadMessage(
      await POST(buildInitializePostRequest())
    );
    const credentialBearingMessage = await expectUnconfiguredDoorRefusalAndReadMessage(
      await POST(buildInitializePostRequest(someBearerCredential))
    );

    expect(
      credentialBearingMessage,
      'carrying a credential must change nothing — same refusal message as carrying none'
    ).toBe(credentialFreeMessage);
  });

  // The misconfiguration must be visible in the SERVER logs, not only to the
  // refused caller: at least one console.error line naming RAH_MCP_DOOR_TOKEN
  // per refused request, so the operator finds the cause without replaying
  // traffic.
  it('logs a server-side console.error naming RAH_MCP_DOOR_TOKEN on each refusal', async () => {
    // Spy on console.error, silenced so the expected refusal line does not
    // pollute the test run's own output.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(buildInitializePostRequest());
    await expectUnconfiguredDoorRefusalAndReadMessage(response);

    // At least one logged line must name the missing variable. Every call's
    // arguments are stringified and searched, so the assertion holds whether
    // the name rides the format string or a later argument.
    const someLoggedLineNamesTheVariable = consoleErrorSpy.mock.calls.some((callArguments) =>
      callArguments.map((argument) => String(argument)).join(' ').includes('RAH_MCP_DOOR_TOKEN')
    );
    expect(
      someLoggedLineNamesTheVariable,
      'the refusal must log one clear console.error line naming RAH_MCP_DOOR_TOKEN'
    ).toBe(true);
  });

  // Preflights reveal nothing about the store, so OPTIONS stays open even on
  // an unconfigured door: 204, no refusal. (Born green against today's door —
  // the guard that fail-closed never breaks preflight.)
  it('leaves the OPTIONS preflight open at 204 even with no token configured', async () => {
    const response = await OPTIONS();
    expect(
      response.status,
      'a preflight must stay open — it reveals nothing an unconfigured door needs to hide'
    ).toBe(204);
  });
});
