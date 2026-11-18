import { afterEach, beforeEach, mock } from 'node:test';
import { inspect } from 'node:util';
import type { RefreshParams, SubriteJWT } from '../src/index.ts';

let counter = 0;
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export type TokenRequest = { headers: Headers; form: URLSearchParams; signal?: AbortSignal | null };
type TokenHandler = (request: TokenRequest) => Response | Promise<Response>;

type FakeServer = (url: string, init?: RequestInit) => Promise<Response> | undefined;
// Every fake server of the current test. One fetch mock routes each request to the right one.
const servers: FakeServer[] = [];
// Requests that no fake server knows. A test can check that nothing went elsewhere.
const unexpected: string[] = [];
let dispatcherInstalled = false;

function installDispatcher(): void {
  if (dispatcherInstalled) return;
  dispatcherInstalled = true;
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    for (const server of servers) {
      const response = server(url, init);
      if (response) return response;
    }
    unexpected.push(url);
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function readRequest(init?: RequestInit): TokenRequest {
  return {
    headers: new Headers(init?.headers),
    form: new URLSearchParams(String(init?.body)),
    signal: init?.signal,
  };
}

// A fake Subrite server. Every call gets its own URL so the module caches don't leak between tests.
export function fakeSubrite(options: {
  token: TokenHandler;
  revocation?: TokenHandler;
  discovery?: Record<string, unknown>;
  discoveryStatus?: number;
}) {
  const subriteUrl = `https://${unique('subrite')}.example.com`;
  const discoveryUrl = `${subriteUrl}/api/oidc/.well-known/openid-configuration`;
  const tokenEndpoint = `${subriteUrl}/api/oidc/token`;
  const revocationEndpoint = `${subriteUrl}/api/oidc/token/revocation`;
  const calls = {
    discovery: 0,
    token: [] as TokenRequest[],
    revocation: [] as TokenRequest[],
    redirects: [] as unknown[],
    unexpected,
  };
  servers.push((url, init) => {
    if (![discoveryUrl, tokenEndpoint, revocationEndpoint].includes(url)) return undefined;
    calls.redirects.push(init?.redirect);
    if (url === discoveryUrl) {
      calls.discovery += 1;
      if (options.discoveryStatus) {
        return Promise.resolve(new Response('nope', { status: options.discoveryStatus }));
      }
      return Promise.resolve(
        Response.json({
          issuer: `${subriteUrl}/api/oidc`,
          token_endpoint: tokenEndpoint,
          revocation_endpoint: revocationEndpoint,
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          ...options.discovery,
        }),
      );
    }
    const request = readRequest(init);
    if (url === tokenEndpoint) {
      calls.token.push(request);
      return Promise.resolve().then(() => options.token(request));
    }
    calls.revocation.push(request);
    const revocation = options.revocation ?? (() => new Response(null, { status: 200 }));
    return Promise.resolve().then(() => revocation(request));
  });
  installDispatcher();
  const params: RefreshParams = { subriteUrl, clientId: 'client id', clientSecret: 's3cret:+' };
  return { subriteUrl, calls, params };
}

export function sessionToken(overrides: Partial<SubriteJWT> = {}) {
  return {
    sub: 'user-1',
    name: 'Ada',
    accessToken: unique('old-access'),
    refreshToken: unique('old-refresh'),
    accessTokenExpires: Date.now() - 1000,
    ...overrides,
  };
}

export const ok = (body: Record<string, unknown>) => Response.json(body);

// The library keeps its caches on globalThis under these keys (see processWide in src/index.ts).
type LibraryState = {
  refreshes: Map<unknown, unknown>;
  clients: Map<unknown, unknown>;
  lastPrune: number;
};
const store = globalThis as unknown as Record<symbol, unknown>;
export function libraryState(): LibraryState {
  return store[Symbol.for('@subrite/next-auth-provider/v1/state')] as LibraryState;
}

/** Starts every test from empty caches, so no test depends on another. */
export function resetLibraryState(): void {
  const state = libraryState();
  if (state) {
    state.refreshes.clear();
    state.clients.clear();
    state.lastPrune = 0;
  }
  (store[Symbol.for('@subrite/next-auth-provider/v1/discovery')] as Map<unknown, unknown>)?.clear();
}

/**
 * Silences console.error and console.warn in every test of the file, resets the library's
 * caches, and restores all mocks after each test. Returns a function that gives what the
 * console would have printed.
 */
export function captureConsole(): () => string {
  const spies: Array<ReturnType<typeof mock.method>> = [];
  beforeEach(() => {
    resetLibraryState();
    servers.length = 0;
    unexpected.length = 0;
    dispatcherInstalled = false;
    spies.length = 0;
    spies.push(
      mock.method(console, 'error', () => {}),
      mock.method(console, 'warn', () => {}),
    );
  });
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });
  return () =>
    spies
      .flatMap((spy) => spy.mock.calls)
      .map((call) => call.arguments.map((arg) => inspect(arg, { depth: 10 })).join(' '))
      .join('\n');
}
