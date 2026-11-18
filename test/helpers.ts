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

// A fake Subrite server. Every call gets its own URL so the module caches don't leak between tests.
export function fakeSubrite(options: {
  token: TokenHandler;
  discovery?: Record<string, unknown>;
  discoveryStatus?: number;
}) {
  const subriteUrl = `https://${unique('subrite')}.example.com`;
  const tokenEndpoint = `${subriteUrl}/api/oidc/token`;
  const calls = { discovery: 0, token: [] as TokenRequest[] };
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${subriteUrl}/api/oidc/.well-known/openid-configuration`) {
      calls.discovery += 1;
      if (options.discoveryStatus) {
        return new Response('nope', { status: options.discoveryStatus });
      }
      return Response.json({
        issuer: `${subriteUrl}/api/oidc`,
        token_endpoint: tokenEndpoint,
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        ...options.discovery,
      });
    }
    if (url === tokenEndpoint) {
      const request: TokenRequest = {
        headers: new Headers(init?.headers),
        form: new URLSearchParams(String(init?.body)),
        signal: init?.signal,
      };
      calls.token.push(request);
      return options.token(request);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
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

/**
 * Silences console.error in every test of the file and restores all mocks after each test.
 * Returns a function that gives what console.error would have printed.
 */
export function captureConsole(): () => string {
  let consoleError: ReturnType<typeof mock.method> | undefined;
  beforeEach(() => {
    consoleError = mock.method(console, 'error', () => {});
  });
  afterEach(() => {
    mock.restoreAll();
  });
  return () =>
    (consoleError?.mock.calls ?? [])
      .map((call) => call.arguments.map((arg) => inspect(arg, { depth: 10 })).join(' '))
      .join('\n');
}
