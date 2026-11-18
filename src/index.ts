import type { TokenSet, User } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import type { OAuthConfig, OAuthUserConfig } from 'next-auth/providers/oauth';

/** The value of `error` when Subrite rejected the refresh token. The user must sign in again. */
export type SubriteTokenError = 'RefreshAccessTokenError';

/** The Subrite tokens kept in the NextAuth JWT. */
export interface SubriteJWT {
  accessToken: string;
  /** Empty once Subrite has rejected it. */
  refreshToken: string;
  /** When the access token expires, in milliseconds since epoch. Easy to compare with `Date.now()`. */
  accessTokenExpires: number;
  /** Set when the access token could not be refreshed and the user must sign in again. */
  error?: SubriteTokenError;
}

/** Properties to add to the NextAuth session. See the README for how to wire them up. */
export interface SubriteSession {
  accessToken?: string | undefined;
  error?: SubriteTokenError | undefined;
}

/** The claims Subrite returns about the signed in user. */
export interface SubriteProfile {
  sub: string;
  name?: string;
  email?: string;
  /** The standard OpenID Connect claim for the profile picture. */
  picture?: string;
  /** Non standard name for the profile picture. Used when `picture` is missing. */
  image?: string;
}

export type SubriteConfig = OAuthUserConfig<SubriteProfile> & {
  subriteUrl: string | URL;
};

export type RefreshParams = {
  subriteUrl: string | URL;
  clientId: string;
  clientSecret: string;
  /**
   * Only `token_endpoint_auth_method` is used. Set it if you also set it in the provider config,
   * so the refresh request authenticates the same way as the sign in.
   */
  client?: { token_endpoint_auth_method?: string };
  /** How long to wait for Subrite before giving up. Defaults to 10 seconds. */
  timeoutMs?: number;
};

export type SignOutOptions = {
  /**
   * Subrite sends this back to `postLogoutRedirectUri`. Check it there before signing the user
   * out of the app, so other sites can't sign your users out by linking to that page.
   */
  state?: string;
  /** The ID token from the sign in, if you keep it. Lets Subrite skip asking the user to confirm. */
  idTokenHint?: string;
};

const WELL_KNOWN_PATH = 'api/oidc/.well-known/openid-configuration';
const SIGN_OUT_PATH = 'api/oidc/session/end';
const REFRESH_ERROR: SubriteTokenError = 'RefreshAccessTokenError';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_EXPIRY_MARGIN_SECONDS = 60;
// A successful refresh is shared with later requests that still carry the old refresh token (an
// old cookie) for at least this long, and until the new access token is about to expire.
const MIN_SUCCESS_REUSE_MS = 30_000;
// A rejected refresh token is answered from memory for this long, without asking Subrite again.
const PERMANENT_FAILURE_REUSE_MS = 60 * 60 * 1000;
// After a temporary failure, wait before trying the same refresh token again. The wait doubles
// with every failure in a row, up to the maximum.
const BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
// How long failures in a row are remembered for the back off.
const FAILURE_MEMORY_MS = 15 * 60 * 1000;
// Used when Subrite leaves out expires_in. Short, so a real expiry is missed by little.
const FALLBACK_EXPIRES_IN_SECONDS = 300;
// Bounds the memory used by the refresh cache in one process.
const MAX_REFRESH_ENTRIES = 10_000;
const PRUNE_INTERVAL_MS = 10_000;
const DISCOVERY_CACHE_MS = 60 * 60 * 1000;

export default function Subrite(config: SubriteConfig): OAuthConfig<SubriteProfile> {
  return {
    id: 'subrite',
    name: 'Subrite',
    type: 'oauth',
    version: '2.0',
    wellKnown: subriteEndpoint(config.subriteUrl, WELL_KNOWN_PATH),
    // NextAuth turns this on for any `wellKnown` OpenID configuration. Set explicitly for clarity:
    // the ID token is validated and the profile is read from its claims.
    idToken: true,
    checks: ['pkce', 'state'],
    authorization: {
      params: {
        scope: 'openid offline_access',
      },
    },
    profile(profile): User {
      return {
        id: profile.sub,
        name: profile.name ?? null,
        email: profile.email ?? null,
        image: profile.picture ?? profile.image ?? null,
      };
    },
    options: config,
  };
}

/** Picks the Subrite tokens out of the `account` NextAuth passes to the `jwt` callback on sign in. */
export function toSubriteJWT(
  tokens: Pick<TokenSet, 'access_token' | 'refresh_token' | 'expires_at'>,
): SubriteJWT {
  const { access_token, refresh_token, expires_at } = tokens;
  if (!access_token) {
    throw new Error('No access_token');
  }
  if (!refresh_token) {
    throw new Error(
      'No refresh_token. Subrite must allow this client the refresh_token grant and the ' +
        'offline_access scope.',
    );
  }
  if (!expires_at) {
    throw new Error('No expires_at');
  }
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    // expires_at is in seconds since epoch
    accessTokenExpires: expires_at * 1000,
  };
}

/**
 * True when the access token has expired, or expires within `marginSeconds` (default 60).
 * Refreshing a little early means the token doesn't run out in the middle of a request.
 */
export function isAccessTokenExpired(
  token: Partial<Pick<SubriteJWT, 'accessTokenExpires'>>,
  marginSeconds = DEFAULT_EXPIRY_MARGIN_SECONDS,
): boolean {
  const expires = token.accessTokenExpires;
  if (typeof expires !== 'number' || !Number.isFinite(expires)) {
    return true;
  }
  return Date.now() >= expires - marginSeconds * 1000;
}

type RefreshOutcome =
  | { kind: 'success'; accessToken: string; refreshToken: string; accessTokenExpires: number }
  | { kind: 'permanent-failure' }
  | { kind: 'temporary-failure' };

type RefreshEntry = {
  outcome: Promise<RefreshOutcome>;
  /** Until when other requests with the same refresh token get this outcome. */
  reuseUntil: number;
  /** Until when the entry is kept, to count temporary failures in a row. */
  keepUntil: number;
  /** Temporary failures in a row for this refresh token. */
  failures: number;
};

// Next.js can load several copies of this module into one process, for example one for the
// Pages Router and one per App Router layer. Keep the caches on globalThis so all copies share
// them. Bump the version in the key if the shape of what is stored changes.
function processWide<T>(name: string, create: () => T): T {
  const key = Symbol.for(`@subrite/next-auth-provider/v1/${name}`);
  const store = globalThis as unknown as Record<symbol, T | undefined>;
  return (store[key] ??= create());
}

// Refreshes in progress or recently finished in this process, keyed by Subrite URL, client id
// and refresh token. Requests with the same refresh token share one call to Subrite, and a
// request that still carries an already used refresh token gets the result instead of sending
// it again.
const refreshes = processWide('refreshes', () => new Map<string, RefreshEntry>());
let lastPrune = 0;

/**
 * Gets a new access token from Subrite.
 *
 * Never throws. When Subrite rejects the refresh token, the returned token has
 * `error: 'RefreshAccessTokenError'` and an empty `refreshToken`, and the user must sign in
 * again. Further calls with that token return it as is, without calling Subrite. On a temporary
 * failure (network error, timeout, 5xx, 429, or a client error without an OAuth error code) the
 * token is returned unchanged, and the refresh is tried again later, waiting longer each time.
 */
export async function refreshAccessToken(
  token: JWT & SubriteJWT,
  params: RefreshParams,
): Promise<JWT & SubriteJWT> {
  const { refreshToken } = token;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    // Already flagged: the user must sign in again, and there is nothing to send to Subrite.
    if (token.error === REFRESH_ERROR) {
      return token;
    }
    console.error('Error refreshing access token: the token has no refresh token');
    return { ...token, refreshToken: '', error: REFRESH_ERROR };
  }
  // A token can still carry `error` with a working refresh token. Version 0.2.1 set it on any
  // failure, including a network blip, and never cleared it. Try the refresh: on success the
  // error is removed.

  const outcome = await sharedRefresh(refreshToken, params);
  switch (outcome.kind) {
    case 'success': {
      const refreshed: JWT & SubriteJWT = {
        ...token,
        accessToken: outcome.accessToken,
        refreshToken: outcome.refreshToken,
        accessTokenExpires: outcome.accessTokenExpires,
      };
      delete refreshed.error;
      return refreshed;
    }
    case 'permanent-failure':
      // Drop the rejected refresh token, so it is never sent to Subrite again.
      return { ...token, refreshToken: '', error: REFRESH_ERROR };
    case 'temporary-failure':
      return token;
  }
}

function sharedRefresh(refreshToken: string, params: RefreshParams): Promise<RefreshOutcome> {
  const now = Date.now();
  pruneRefreshes(now);
  // One app can talk to several Subrite servers or clients. Never share results between them.
  const key = JSON.stringify([String(params.subriteUrl), params.clientId, refreshToken]);
  const existing = refreshes.get(key);
  if (existing && existing.reuseUntil > now) {
    return existing.outcome;
  }
  const entry: RefreshEntry = {
    outcome: requestRefresh(refreshToken, params),
    // Keep the entry while the request is in progress. Set the real deadlines once it finishes.
    reuseUntil: Number.POSITIVE_INFINITY,
    keepUntil: Number.POSITIVE_INFINITY,
    failures: existing?.failures ?? 0,
  };
  // Delete first, so the Map's insertion order stays oldest first for pruning.
  refreshes.delete(key);
  refreshes.set(key, entry);
  entry.outcome.then((outcome) => settle(entry, outcome));
  return entry.outcome;
}

function settle(entry: RefreshEntry, outcome: RefreshOutcome): void {
  const now = Date.now();
  switch (outcome.kind) {
    case 'success': {
      const nearExpiry = outcome.accessTokenExpires - DEFAULT_EXPIRY_MARGIN_SECONDS * 1000;
      entry.failures = 0;
      entry.reuseUntil = Math.max(now + MIN_SUCCESS_REUSE_MS, nearExpiry);
      entry.keepUntil = entry.reuseUntil;
      return;
    }
    case 'permanent-failure':
      entry.reuseUntil = now + PERMANENT_FAILURE_REUSE_MS;
      entry.keepUntil = entry.reuseUntil;
      return;
    case 'temporary-failure':
      entry.failures += 1;
      entry.reuseUntil = now + Math.min(BACKOFF_MS * 2 ** (entry.failures - 1), MAX_BACKOFF_MS);
      entry.keepUntil = Math.max(entry.reuseUntil, now + FAILURE_MEMORY_MS);
      return;
  }
}

function pruneRefreshes(now: number): void {
  if (now - lastPrune >= PRUNE_INTERVAL_MS) {
    lastPrune = now;
    for (const [key, entry] of refreshes) {
      if (entry.keepUntil <= now) {
        refreshes.delete(key);
      }
    }
  }
  // The Map keeps insertion order, so the first entries are the oldest.
  for (const key of refreshes.keys()) {
    if (refreshes.size <= MAX_REFRESH_ENTRIES) {
      break;
    }
    refreshes.delete(key);
  }
}

async function requestRefresh(
  refreshToken: string,
  params: RefreshParams,
): Promise<RefreshOutcome> {
  try {
    return await callTokenEndpoint(refreshToken, params);
  } catch (error) {
    console.error('Error refreshing access token:', describeError(error));
    return { kind: 'temporary-failure' };
  }
}

async function callTokenEndpoint(
  refreshToken: string,
  params: RefreshParams,
): Promise<RefreshOutcome> {
  const { subriteUrl, clientId, clientSecret, timeoutMs = DEFAULT_TIMEOUT_MS } = params;

  let response: Response;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const discovery = await discover(subriteUrl, signal);

    const authMethod = params.client?.token_endpoint_auth_method ?? defaultAuthMethod(discovery);
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    const form = new URLSearchParams();
    form.append('grant_type', 'refresh_token');
    form.append('refresh_token', refreshToken);
    if (authMethod === 'client_secret_basic') {
      headers.Authorization = basicAuth(clientId, clientSecret);
    } else if (authMethod === 'client_secret_post') {
      form.append('client_id', clientId);
      form.append('client_secret', clientSecret);
    } else {
      console.error(
        `Error refreshing access token: token_endpoint_auth_method ${authMethod} is not supported`,
      );
      return { kind: 'permanent-failure' };
    }

    // Never follow a redirect: it would send the refresh token (and maybe the client secret) to
    // another address. openid-client refuses redirects on sign in too.
    response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers,
      body: form,
      signal,
      redirect: 'error',
    });
  } catch (error) {
    // Network error, timeout, redirect or failed discovery. Worth trying again later.
    console.error('Error refreshing access token:', describeError(error));
    return { kind: 'temporary-failure' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (response.ok) {
      // The connection broke or timed out while reading the new tokens. Subrite may not have
      // used the refresh token up, so try again later rather than signing the user out.
      console.error(
        'Error refreshing access token: could not read the token response:',
        describeError(error),
      );
      return { kind: 'temporary-failure' };
    }
    body = undefined;
  }

  if (!response.ok) {
    const error = readString(body, 'error');
    // Never log the whole body. Only the standard error fields from RFC 6749 section 5.2.
    console.error('Error refreshing access token:', {
      status: response.status,
      error,
      error_description: readString(body, 'error_description'),
    });
    if (error === 'invalid_client') {
      console.error(
        'Subrite did not accept the client id or secret. Check the configuration. Sessions are ' +
          'kept and refreshed again once it is fixed.',
      );
    }
    return {
      kind: isRejection(response.status, error) ? 'permanent-failure' : 'temporary-failure',
    };
  }

  const accessToken = readString(body, 'access_token');
  if (!accessToken) {
    // The body may hold tokens, so only log which field is missing.
    console.error('Error refreshing access token: the token response has no access_token', {
      status: response.status,
    });
    return { kind: 'permanent-failure' };
  }
  let expiresIn = readExpiresIn(body);
  if (expiresIn === undefined) {
    // Keep the new tokens: Subrite may already have replaced the old refresh token.
    console.error(
      `Subrite sent no valid expires_in. Assuming the access token lasts ${FALLBACK_EXPIRES_IN_SECONDS} seconds.`,
    );
    expiresIn = FALLBACK_EXPIRES_IN_SECONDS;
  }

  return {
    kind: 'success',
    accessToken,
    // Subrite may keep the same refresh token. Then it is left out of the response.
    refreshToken: readString(body, 'refresh_token') ?? refreshToken,
    // The OAuth spec specifies expires_in in seconds.
    accessTokenExpires: Date.now() + expiresIn * 1000,
  };
}

// Only a client error that Subrite explains with an OAuth error code (RFC 6749 section 5.2), such
// as invalid_grant, means the refresh token is rejected. invalid_client is a configuration
// problem and says nothing about the user's token. A client error without an error code comes
// from something in between, like a firewall, CDN or load balancer.
function isRejection(status: number, error: string | undefined): boolean {
  if (status < 400 || status >= 500 || status === 408 || status === 425 || status === 429) {
    return false;
  }
  return error !== undefined && error !== 'invalid_client';
}

type Discovery = {
  token_endpoint: string;
  token_endpoint_auth_methods_supported?: unknown;
};

const discoveryCache = processWide(
  'discovery',
  () => new Map<string, { document: Promise<Discovery>; expires: number }>(),
);

function discover(subriteUrl: string | URL, signal: AbortSignal): Promise<Discovery> {
  const url = subriteEndpoint(subriteUrl, WELL_KNOWN_PATH);
  const cached = discoveryCache.get(url);
  if (cached && cached.expires > Date.now()) {
    return cached.document;
  }
  const document = fetch(url, {
    headers: { Accept: 'application/json' },
    signal,
    redirect: 'error',
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`OpenID configuration request failed with status ${response.status}`);
    }
    const json: unknown = await response.json();
    if (!readString(json, 'token_endpoint')) {
      throw new Error('The OpenID configuration has no token_endpoint');
    }
    return json as Discovery;
  });
  discoveryCache.set(url, { document, expires: Date.now() + DISCOVERY_CACHE_MS });
  // Don't keep failures around. The next refresh tries again.
  document.catch(() => {
    if (discoveryCache.get(url)?.document === document) {
      discoveryCache.delete(url);
    }
  });
  return document;
}

// Same choice as openid-client, which NextAuth uses for the sign in: HTTP Basic unless Subrite
// says it only supports client_secret_post.
function defaultAuthMethod(discovery: Discovery): string {
  const supported = discovery.token_endpoint_auth_methods_supported;
  if (
    Array.isArray(supported) &&
    !supported.includes('client_secret_basic') &&
    supported.includes('client_secret_post')
  ) {
    return 'client_secret_post';
  }
  return 'client_secret_basic';
}

// RFC 6749 section 2.3.1: form encode the client id and secret before base64.
function basicAuth(clientId: string, clientSecret: string): string {
  const formEncode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');
  return `Basic ${btoa(`${formEncode(clientId)}:${formEncode(clientSecret)}`)}`;
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : undefined;
}

// A positive number of seconds. Accepts a numeric string too, like openid-client does.
function readExpiresIn(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const raw = (body as Record<string, unknown>).expires_in;
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/** The URL that signs the user out of Subrite and then sends them to `postLogoutRedirectUri`. */
export function generatePostSignOutUrl(
  subriteUrl: string | URL,
  clientId: string,
  postLogoutRedirectUri: string,
  options: SignOutOptions = {},
): string {
  const subriteSignoutUrl = new URL(subriteEndpoint(subriteUrl, SIGN_OUT_PATH));
  // Tell subrite what client we are signing out from
  subriteSignoutUrl.searchParams.append('client_id', clientId);
  // Tell subrite where to send the user agent after signing out
  subriteSignoutUrl.searchParams.append('post_logout_redirect_uri', postLogoutRedirectUri);
  if (options.state) {
    subriteSignoutUrl.searchParams.append('state', options.state);
  }
  if (options.idTokenHint) {
    subriteSignoutUrl.searchParams.append('id_token_hint', options.idTokenHint);
  }
  return subriteSignoutUrl.toString();
}

// Joins a path onto the Subrite URL, keeping any path the Subrite URL already has.
function subriteEndpoint(subriteUrl: string | URL, path: string): string {
  const base = new URL(subriteUrl);
  if (!base.pathname.endsWith('/')) {
    base.pathname += '/';
  }
  return new URL(path, base).href;
}
