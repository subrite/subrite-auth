import type { TokenSet, User } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import type { OAuthConfig, OAuthUserConfig } from 'next-auth/providers/oauth';

/** The value of `error` when Subrite rejected the refresh token. The user must sign in again. */
export type SubriteTokenError = 'RefreshAccessTokenError';

/** The Subrite tokens kept in the NextAuth JWT. */
export interface SubriteJWT {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, in milliseconds since epoch. Easy to compare with `Date.now()`. */
  accessTokenExpires: number;
  /** Set when the access token could not be refreshed and the user must sign in again. */
  error?: SubriteTokenError;
}

/** Properties to add to the NextAuth session. See the README for how to wire them up. */
export interface SubriteSession {
  accessToken?: string;
  error?: SubriteTokenError;
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

const WELL_KNOWN_PATH = 'api/oidc/.well-known/openid-configuration';
const SIGN_OUT_PATH = 'api/oidc/session/end';
const REFRESH_ERROR: SubriteTokenError = 'RefreshAccessTokenError';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_EXPIRY_MARGIN_SECONDS = 60;
// How long the result of a refresh is reused for other requests holding the same refresh token.
const SUCCESS_REUSE_MS = 30_000;
const PERMANENT_FAILURE_REUSE_MS = 30_000;
// How long to wait before calling Subrite again after a temporary failure (network, 5xx, 429).
const TEMPORARY_FAILURE_BACKOFF_MS = 10_000;
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
    throw new Error('No refresh_token');
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

type RefreshEntry = { outcome: Promise<RefreshOutcome>; reuseUntil: number };

// Refreshes in progress or recently finished in this process, keyed by Subrite URL, client id
// and refresh token.
// Parallel requests share one call to Subrite, so a rotated refresh token is never sent twice.
const refreshes = new Map<string, RefreshEntry>();

/**
 * Gets a new access token from Subrite.
 *
 * Never throws. When Subrite rejects the refresh token, the returned token has
 * `error: 'RefreshAccessTokenError'` and an empty `refreshToken`, and the user must sign in
 * again. Further calls with that token return it as is, without calling Subrite. On a temporary
 * failure (network error, timeout, 5xx, 429) the token is returned unchanged, and the refresh is
 * tried again later.
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
  for (const [key, entry] of refreshes) {
    if (entry.reuseUntil <= now) {
      refreshes.delete(key);
    }
  }
  // One app can talk to several Subrite servers or clients. Never share results between them.
  const key = JSON.stringify([String(params.subriteUrl), params.clientId, refreshToken]);
  const existing = refreshes.get(key);
  if (existing) {
    return existing.outcome;
  }
  const entry: RefreshEntry = {
    outcome: requestRefresh(refreshToken, params),
    // Keep the entry while the request is in progress. Set the real deadline once it finishes.
    reuseUntil: Number.POSITIVE_INFINITY,
  };
  refreshes.set(key, entry);
  entry.outcome.then((outcome) => {
    entry.reuseUntil = Date.now() + reuseTime(outcome);
  });
  return entry.outcome;
}

function reuseTime(outcome: RefreshOutcome): number {
  switch (outcome.kind) {
    case 'success':
      return SUCCESS_REUSE_MS;
    case 'permanent-failure':
      return PERMANENT_FAILURE_REUSE_MS;
    case 'temporary-failure':
      return TEMPORARY_FAILURE_BACKOFF_MS;
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
    const tokenEndpoint = discovery.token_endpoint;
    if (typeof tokenEndpoint !== 'string' || !tokenEndpoint) {
      console.error('Error refreshing access token: no token_endpoint in the OpenID configuration');
      return { kind: 'temporary-failure' };
    }

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

    response = await fetch(tokenEndpoint, { method: 'POST', headers, body: form, signal });
  } catch (error) {
    // Network error, timeout or failed discovery. Worth trying again later.
    console.error('Error refreshing access token:', describeError(error));
    return { kind: 'temporary-failure' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    // Never log the whole body. Only the standard error fields from RFC 6749 section 5.2.
    console.error('Error refreshing access token:', {
      status: response.status,
      error: readString(body, 'error'),
      error_description: readString(body, 'error_description'),
    });
    const temporary = response.status >= 500 || response.status === 429;
    return { kind: temporary ? 'temporary-failure' : 'permanent-failure' };
  }

  const accessToken = readString(body, 'access_token');
  const expiresIn = readNumber(body, 'expires_in');
  if (!accessToken || expiresIn === undefined) {
    // The body holds tokens, so only log which fields are missing.
    console.error('Error refreshing access token: unexpected token response', {
      status: response.status,
      hasAccessToken: Boolean(accessToken),
      hasExpiresIn: expiresIn !== undefined,
    });
    return { kind: 'permanent-failure' };
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

type Discovery = {
  token_endpoint?: unknown;
  token_endpoint_auth_methods_supported?: unknown;
};

const discoveryCache = new Map<string, { document: Promise<Discovery>; expires: number }>();

function discover(subriteUrl: string | URL, signal: AbortSignal): Promise<Discovery> {
  const url = subriteEndpoint(subriteUrl, WELL_KNOWN_PATH);
  const cached = discoveryCache.get(url);
  if (cached && cached.expires > Date.now()) {
    return cached.document;
  }
  const document = fetch(url, { headers: { Accept: 'application/json' }, signal }).then(
    async (response) => {
      if (!response.ok) {
        throw new Error(`OpenID configuration request failed with status ${response.status}`);
      }
      return (await response.json()) as Discovery;
    },
  );
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

function readNumber(body: unknown, key: string): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
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
): string {
  const subriteSignoutUrl = new URL(subriteEndpoint(subriteUrl, SIGN_OUT_PATH));
  // Tell subrite what client we are signing out from
  subriteSignoutUrl.searchParams.append('client_id', clientId);
  // Tell subrite where to send the user agent after signing out
  subriteSignoutUrl.searchParams.append('post_logout_redirect_uri', postLogoutRedirectUri);
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
