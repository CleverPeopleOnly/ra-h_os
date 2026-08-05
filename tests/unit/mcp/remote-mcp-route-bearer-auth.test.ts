/**
 * Tests for the remote MCP door's bearer-token lock (app/api/mcp/route.ts).
 *
 * The door is the HTTP face of a PRIVATE knowledge store, and today it has no
 * authentication at all: anyone who can reach the URL can drive every tool and
 * read the discovery listing. This file pins the lock being added: a bearer
 * token, keyed on the env var RAH_MCP_DOOR_TOKEN, checked at the TRANSPORT
 * level before any MCP handshake begins.
 *
 * The refusal vocabulary matters and is pinned deliberately:
 *  - A credential failure is an HTTP 401 with a JSON-RPC error body and a
 *    `WWW-Authenticate: Bearer` header — a transport-level rejection. It must
 *    NEVER be the 200-plus-isError shape, which is reserved for in-protocol
 *    tool refusals (e.g. an unconfirmed edge write).
 *  - Missing, wrong, and malformed credentials must all read IDENTICALLY, so
 *    the door gives an attacker no oracle separating "unknown token" from
 *    "bad scheme".
 *  - OPTIONS stays open: CORS preflights carry no credentials by design, so
 *    demanding one there would only break preflight without protecting
 *    anything.
 *
 * Seam: the route's exported POST/GET/OPTIONS handlers are driven directly
 * with plain `new Request(...)` objects — the same shape the shared harness's
 * custom fetch feeds them. No MCP client is used, deliberately: an auth
 * rejection happens before any handshake, and the SDK client would only
 * surface it as an opaque connect error instead of the status, header, and
 * body this file must inspect. No real app, no socket, and no database is
 * involved.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';

import { GET, OPTIONS, POST } from '../../../app/api/mcp/route';

// The known token this suite installs as RAH_MCP_DOOR_TOKEN. An arbitrary
// value; only equality with the Authorization header matters.
const doorTokenForThisSuite = 'test-only-door-token-3f9a';

// A syntactically fine Bearer credential whose token is simply not the door's.
const wrongBearerCredential = 'Bearer not-the-door-token';

// An Authorization header using the wrong SCHEME entirely. Must be refused
// exactly like a wrong token — same status, same message.
const basicSchemeCredential = 'Basic dXNlcjpwYXNz';

// The door's token sent BARE, without the "Bearer " scheme prefix. Also a
// malformed credential: the scheme is part of the contract.
const bareTokenCredential = doorTokenForThisSuite;

// The RAH_MCP_DOOR_TOKEN value present before this file ran, restored after —
// absent stays absent.
let doorTokenBeforeThisSuite: string | undefined;

// The RAH_MCP_TARGET_URL value present before this file ran, restored after.
// It is set to a dummy so the GET handler's getBaseUrl never dereferences
// request.nextUrl on the plain Request objects this file builds; nothing in
// this file ever performs a network call to it.
let targetUrlBeforeThisSuite: string | undefined;

// The JSON-RPC error body shape a transport-level refusal must carry.
type JsonRpcErrorBody = {
  jsonrpc: string;
  error: { code: number; message: string };
};

// Build a minimal JSON-RPC `initialize` POST aimed at the door, optionally
// carrying an Authorization header. Initialize is used because it is the very
// first message any client sends, so it is exactly what the lock must stop —
// and, when the bearer is correct, exactly what must still get through.
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
        clientInfo: { name: 'ra-h-remote-mcp-bearer-auth-test', version: '1.0.0' },
      },
    }),
  }) as unknown as NextRequest;
}

// Build a GET aimed at the door's discovery listing, optionally carrying an
// Authorization header.
function buildDiscoveryGetRequest(authorizationHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authorizationHeader !== undefined) {
    headers.Authorization = authorizationHeader;
  }
  return new Request('http://127.0.0.1/api/mcp', {
    method: 'GET',
    headers,
  }) as unknown as NextRequest;
}

// Assert one response IS the transport-level bearer refusal — 401, the
// WWW-Authenticate challenge, a JSON-RPC error body, and no `result` key
// (the marker that would mean an MCP payload slipped past the lock) — and
// return the refusal message so callers can compare messages across cases.
async function expectBearerRefusalAndReadMessage(response: Response): Promise<string> {
  expect(response.status, 'a credential failure must be HTTP 401').toBe(401);
  expect(
    response.headers.get('www-authenticate'),
    'a 401 must carry a WWW-Authenticate: Bearer challenge'
  ).toMatch(/^Bearer/);

  const refusalBody = (await response.json()) as JsonRpcErrorBody & { result?: unknown };
  expect(refusalBody.jsonrpc, 'the refusal body must be JSON-RPC framed').toBe('2.0');
  expect(typeof refusalBody.error?.code, 'the refusal must carry an error code').toBe('number');
  expect(typeof refusalBody.error?.message, 'the refusal must carry an error message').toBe(
    'string'
  );
  expect(
    refusalBody.result,
    'a transport refusal must never carry an MCP result — that shape is reserved for in-protocol tool refusals'
  ).toBeUndefined();

  return refusalBody.error.message;
}

beforeAll(() => {
  doorTokenBeforeThisSuite = process.env.RAH_MCP_DOOR_TOKEN;
  process.env.RAH_MCP_DOOR_TOKEN = doorTokenForThisSuite;

  targetUrlBeforeThisSuite = process.env.RAH_MCP_TARGET_URL;
  process.env.RAH_MCP_TARGET_URL = 'http://127.0.0.1:1';
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

describe('remote MCP door bearer-token lock', () => {
  // The core of the lock: with no credential at all, the door must refuse at
  // the transport level — 401, the Bearer challenge, a JSON-RPC error body —
  // before any MCP handshake happens. Today the door has no lock and answers
  // the initialize with a 200 result.
  it('refuses a POST carrying no Authorization header with a 401 transport rejection', async () => {
    const response = await POST(buildInitializePostRequest());
    await expectBearerRefusalAndReadMessage(response);
  });

  // The lock must not lock everyone out: the correct bearer gets the same 200
  // initialize answer the door gives today. (Born green against today's
  // unlocked door — it is the guard proving the lock, once added, still lets
  // the keyholder in.)
  it('answers 200 to a POST initialize carrying the correct bearer token', async () => {
    const response = await POST(
      buildInitializePostRequest(`Bearer ${doorTokenForThisSuite}`)
    );
    expect(response.status, 'the correct bearer must not be refused').toBe(200);
  });

  // A syntactically valid Bearer credential with the wrong token gets exactly
  // the same refusal as no credential at all.
  it('refuses a POST carrying a wrong bearer token with the same 401 shape', async () => {
    const response = await POST(buildInitializePostRequest(wrongBearerCredential));
    await expectBearerRefusalAndReadMessage(response);
  });

  // A credential in the wrong SCHEME — Basic auth, or the right token sent
  // bare without "Bearer " — is malformed and gets the same 401. The bare-token
  // case matters most: the door must not accept its own token outside the
  // scheme, or the scheme stops being part of the contract.
  it('refuses a POST whose Authorization header is not a Bearer credential', async () => {
    const basicSchemeResponse = await POST(buildInitializePostRequest(basicSchemeCredential));
    await expectBearerRefusalAndReadMessage(basicSchemeResponse);

    const bareTokenResponse = await POST(buildInitializePostRequest(bareTokenCredential));
    await expectBearerRefusalAndReadMessage(bareTokenResponse);
  });

  // No oracle: missing, wrong, and malformed credentials must all carry the
  // IDENTICAL refusal message, so the responses never teach an attacker the
  // difference between "unknown token" and "bad scheme".
  it('gives an identical refusal message for missing, wrong, and malformed credentials', async () => {
    const missingCredentialMessage = await expectBearerRefusalAndReadMessage(
      await POST(buildInitializePostRequest())
    );
    const wrongTokenMessage = await expectBearerRefusalAndReadMessage(
      await POST(buildInitializePostRequest(wrongBearerCredential))
    );
    const malformedSchemeMessage = await expectBearerRefusalAndReadMessage(
      await POST(buildInitializePostRequest(basicSchemeCredential))
    );

    expect(wrongTokenMessage, 'wrong token must read exactly like a missing credential').toBe(
      missingCredentialMessage
    );
    expect(
      malformedSchemeMessage,
      'a malformed scheme must read exactly like a missing credential'
    ).toBe(missingCredentialMessage);
  });

  // The discovery listing is metadata about a private store — which tools it
  // offers is nobody's business without the bearer. Today the GET answers 200
  // to anyone.
  it('refuses a GET of the discovery listing without the bearer', async () => {
    const response = await GET(buildDiscoveryGetRequest());
    await expectBearerRefusalAndReadMessage(response);
  });

  // With the correct bearer the discovery listing keeps working exactly as
  // today: 200, the server's name, and a populated tool-name listing. (Born
  // green against today's unlocked door — the guard that the lock does not
  // break discovery for the keyholder. The full advertised tool set is pinned
  // in remote-mcp-route-responds.test.ts; repeating it here would just be a
  // second copy to drift.)
  it('serves the discovery listing to a GET carrying the correct bearer', async () => {
    const response = await GET(buildDiscoveryGetRequest(`Bearer ${doorTokenForThisSuite}`));
    expect(response.status, 'the correct bearer must reach the listing').toBe(200);

    const discoveryListing = (await response.json()) as { name: string; tools: string[] };
    expect(discoveryListing.name).toBe('ra-h-mcp');
    expect(discoveryListing.tools.length).toBeGreaterThan(0);
    expect(discoveryListing.tools).toContain('rah_search_nodes');
  });

  // Preflights carry no credentials by design, so OPTIONS must stay open:
  // 204 and the CORS headers, no auth demanded. (Born green against today's
  // door — the guard that adding the lock never breaks preflight.)
  it('leaves the OPTIONS preflight open — 204 with CORS headers and no auth demanded', async () => {
    const response = await OPTIONS();

    expect(response.status, 'a preflight must not be refused for lacking a credential').toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')).toBeTruthy();
  });
});
