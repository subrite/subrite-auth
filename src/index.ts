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
  /**
   * When Subrite replaces the refresh token, how long a request that still carries the old one
   * (an old cookie) gets the new tokens from memory instead of sending the old token again.
   *
   * Defaults to the lifetime of the new access token (minus one minute). That is what App
   * Router Server Components need, because they can't save the refreshed cookie. If your app
   * always saves refreshed cookies right away, set it low (30 is the minimum): an old cookie used
   * later is then sent to Subrite, whose reuse detection can end the stolen session. It can only
   * shorten the default. Longer values have no effect.
   */
  oldCookieGraceSeconds?: number;
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
const SUPPORTED_AUTH_METHODS = ['client_secret_basic', 'client_secret_post'];

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_EXPIRY_MARGIN_SECONDS = 60;
// Requests that arrive together share one refresh. A result is reused at least this long.
const MIN_SUCCESS_REUSE_MS = 30_000;
// A rejected refresh token is answered from memory for this long, without asking Subrite again.
const PERMANENT_FAILURE_REUSE_MS = 60 * 60 * 1000;
// After a failure that isn't about the token (network, timeout, 5xx, 429, configuration),
// refreshes for that Subrite client pause, then one request tries again. The pause doubles with
// every failure in a row, up to the maximum, unless Subrite says how long with Retry-After.
const BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
// Failures further apart than this don't count as in a row.
const FAILURE_MEMORY_MS = 15 * 60 * 1000;
// Used when Subrite leaves out expires_in. Short, so a real expiry is missed by little.
const FALLBACK_EXPIRES_IN_SECONDS = 300;
// Bounds the memory used by the refresh cache in one process.
const MAX_REFRESH_ENTRIES = 10_000;
const PRUNE_INTERVAL_MS = 10_000;
const DISCOVERY_CACHE_MS = 60 * 60 * 1000;

export default function Subrite(config: SubriteConfig): OAuthConfig<SubriteProfile> {
  const authMethod = config.client?.token_endpoint_auth_method;
  if (authMethod !== undefined && !SUPPORTED_AUTH_METHODS.includes(authMethod)) {
    console.error(
      `Subrite: token_endpoint_auth_method ${authMethod} works for sign in, but ` +
        'refreshAccessToken only supports client_secret_basic and client_secret_post.',
    );
  }
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
  | { kind: 'temporary-failure'; retryAfterMs?: number };

const TEMPORARY: RefreshOutcome = { kind: 'temporary-failure' };
const PERMANENT: RefreshOutcome = { kind: 'permanent-failure' };

type RefreshEntry = {
  outcome: Promise<RefreshOutcome>;
  /** Set once the request has finished. */
  settled?: RefreshOutcome;
  settledAt?: number;
  startedAt: number;
  /** The refresh token this entry sent to Subrite. */
  sentRefreshToken: string;
  /** Until when other requests with the same refresh token get this outcome. */
  reuseUntil: number;
  /** Until when the entry is kept. Longer than reuseUntil after a failure, to count failures. */
  keepUntil: number;
  /** Temporary failures in a row for this refresh token. */
  failures: number;
  /** This request checks whether Subrite is back after a pause. */
  probe: boolean;
  /** Whether a late reuse of this entry has been logged. */
  warned?: boolean;
};

/** How Subrite has been answering for one Subrite URL and client id. */
type ClientHealth = {
  /** Outage steps in a row. Each one doubles the pause. */
  failures: number;
  /** When the latest step began. Requests that started before it belong to the same step. */
  lastStep: number;
  /** No new refreshes for this client from pausedFrom until pausedUntil. */
  pausedFrom: number;
  pausedUntil: number;
  /** A refresh is checking whether Subrite is back. Others wait for it. */
  probing: boolean;
};

type State = {
  refreshes: Map<string, RefreshEntry>;
  clients: Map<string, ClientHealth>;
  lastPrune: number;
};

// Next.js can load several copies of this module into one process, for example one for the
// Pages Router and one per App Router layer. Keep the state on globalThis so all copies share
// it. Bump the version in the key if the shape of what is stored changes.
function processWide<T>(name: string, create: () => T): T {
  const key = Symbol.for(`@subrite/next-auth-provider/v1/${name}`);
  const store = globalThis as unknown as Record<symbol, T | undefined>;
  return (store[key] ??= create());
}

// Refreshes in progress or recently finished, keyed by Subrite URL, client id and refresh
// token. Requests with the same refresh token share one call to Subrite, and a request that
// still carries a refresh token Subrite has replaced gets the result instead of sending it again.
const state = processWide<State>('state', () => ({
  refreshes: new Map(),
  clients: new Map(),
  lastPrune: 0,
}));

/**
 * Gets a new access token from Subrite.
 *
 * Never throws. When Subrite rejects the refresh token (`invalid_grant`), the returned token
 * has `error: 'RefreshAccessTokenError'` and an empty `refreshToken`, and the user must sign in
 * again. Further calls with that token return it as is, without calling Subrite. Any other
 * failure leaves the token unchanged, and the refresh is tried again later. A refresh token
 * that keeps failing waits longer each time without holding up other users.
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

/**
 * Asks Subrite to revoke the refresh token, for example when the user signs out of the app.
 * Refresh tokens for offline access keep working after the user signs out of Subrite, so revoke
 * them yourself. Requests with an old cookie that holds this token are not answered from memory
 * afterwards.
 *
 * Never throws. Returns true when Subrite confirmed the revocation.
 */
export async function revokeRefreshToken(
  token: Partial<Pick<SubriteJWT, 'refreshToken'>>,
  params: RefreshParams,
): Promise<boolean> {
  const { refreshToken } = token;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    return false;
  }
  forgetRefreshToken(refreshToken, params);
  try {
    const signal = AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const discovery = await discover(params, signal);
    const endpoint = readString(discovery, 'revocation_endpoint');
    if (!endpoint) {
      console.error('Error revoking refresh token: Subrite has no revocation_endpoint');
      return false;
    }
    const request = authenticatedForm(discovery, params);
    if (!request) {
      return false;
    }
    request.form.append('token', refreshToken);
    request.form.append('token_type_hint', 'refresh_token');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: request.headers,
      body: request.form,
      signal,
      redirect: 'manual',
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      console.error('Error revoking refresh token:', {
        status: response.status,
        error: readString(body, 'error'),
        error_description: readString(body, 'error_description'),
      });
      return false;
    }
    await response.body?.cancel();
    return true;
  } catch (error) {
    console.error('Error revoking refresh token:', describeError(error));
    return false;
  }
}

function sharedRefresh(refreshToken: string, params: RefreshParams): Promise<RefreshOutcome> {
  const now = Date.now();
  pruneRefreshes(now);
  const clientKey = clientKeyOf(params);
  const key = refreshKeyOf(params, refreshToken);
  const existing = state.refreshes.get(key);
  if (existing && existing.reuseUntil > now) {
    warnOnLateReuse(existing, now);
    return existing.outcome;
  }
  // Failures in a row for this refresh token, if its last attempt failed recently.
  const tokenFailures =
    existing?.settled?.kind === 'temporary-failure' && existing.keepUntil > now
      ? existing.failures
      : 0;

  const health = clientHealth(clientKey, now);
  if (health.pausedUntil > now || health.probing) {
    // Subrite is having trouble. Keep the token and don't add to the load.
    return Promise.resolve(TEMPORARY);
  }
  // After a pause, this request checks whether Subrite is back. Other requests wait for it.
  const probe = health.failures > 0;
  if (probe) {
    health.probing = true;
  }

  const entry: RefreshEntry = {
    outcome: requestRefresh(refreshToken, params),
    startedAt: now,
    sentRefreshToken: refreshToken,
    // Keep the entry while the request is in progress. Set the real deadlines once it finishes.
    reuseUntil: Number.POSITIVE_INFINITY,
    keepUntil: Number.POSITIVE_INFINITY,
    failures: tokenFailures,
    probe,
  };
  // Delete first, so the Map's insertion order stays oldest first for pruning.
  state.refreshes.delete(key);
  state.refreshes.set(key, entry);
  entry.outcome.then((outcome) => settle(entry, clientKey, outcome, params));
  return entry.outcome;
}

function clientHealth(clientKey: string, now: number): ClientHealth {
  let health = state.clients.get(clientKey);
  if (!health) {
    health = { failures: 0, lastStep: 0, pausedFrom: 0, pausedUntil: 0, probing: false };
    state.clients.set(clientKey, health);
  }
  // A clock that went backwards (for example an NTP correction) would stretch a pause by the
  // size of the step. End the pause instead: only one probe goes through anyway.
  if (now < health.pausedFrom) {
    health.pausedUntil = now;
  }
  health.lastStep = Math.min(health.lastStep, now);
  // An outage that ended long ago doesn't count any more.
  if (health.failures > 0 && !health.probing && now - health.lastStep > FAILURE_MEMORY_MS) {
    health.failures = 0;
    health.pausedUntil = 0;
  }
  return health;
}

function settle(
  entry: RefreshEntry,
  clientKey: string,
  outcome: RefreshOutcome,
  params: RefreshParams,
): void {
  const now = Date.now();
  // Revoked while the request was in progress: the revocation wins.
  const revoked = entry.settled !== undefined;
  if (!revoked) {
    entry.settled = outcome;
    entry.settledAt = now;
  }
  const health = clientHealth(clientKey, now);
  if (entry.probe) {
    health.probing = false;
  }

  if (outcome.kind !== 'temporary-failure') {
    // Subrite answered, so it is up.
    health.failures = 0;
    health.pausedUntil = 0;
    if (revoked) return;
    entry.failures = 0;
    entry.reuseUntil =
      outcome.kind === 'success'
        ? successReuseUntil(entry, outcome, params, now)
        : now + PERMANENT_FAILURE_REUSE_MS;
    entry.keepUntil = entry.reuseUntil;
    return;
  }

  const firstFailureOfToken = entry.failures === 0;
  if (!revoked) {
    // This refresh token waits on its own, longer after each failure in a row.
    entry.failures += 1;
    entry.reuseUntil = now + pauseLength(entry.failures, outcome.retryAfterMs);
    entry.keepUntil = Math.max(entry.reuseUntil, now + FAILURE_MEMORY_MS);
  }
  // A refresh token that keeps failing may be the problem itself (bad data for one account),
  // so it never pauses other users. A token that failed for the first time says Subrite may be
  // in trouble: pause the client.
  if (!firstFailureOfToken) {
    return;
  }
  // Requests already on their way when an outage began are part of the same step, so one blip
  // with many requests in flight counts once.
  if (health.failures === 0 || entry.startedAt > health.lastStep) {
    health.failures += 1;
    health.lastStep = now;
  }
  health.pausedUntil = Math.max(
    health.pausedUntil,
    now + pauseLength(health.failures, outcome.retryAfterMs),
  );
  health.pausedFrom = now;
}

// 10 s doubling to 5 min, or what Subrite asked for with Retry-After, within the same bounds.
function pauseLength(failures: number, retryAfterMs: number | undefined): number {
  const wanted = retryAfterMs ?? BACKOFF_MS * 2 ** Math.min(failures - 1, 10);
  return Math.min(Math.max(wanted, BACKOFF_MS), MAX_BACKOFF_MS);
}

let warnedAboutGrace = false;

function successReuseUntil(
  entry: RefreshEntry,
  outcome: Extract<RefreshOutcome, { kind: 'success' }>,
  params: RefreshParams,
  now: number,
): number {
  const expires = outcome.accessTokenExpires;
  if (outcome.refreshToken === entry.sentRefreshToken) {
    // Subrite kept the refresh token, so sending it again is fine. Only share the result with
    // requests that arrive together.
    return Math.min(now + MIN_SUCCESS_REUSE_MS, expires);
  }
  // Subrite replaced the refresh token. Sending the old one again would be a reuse, which
  // Subrite may answer by revoking the whole sign in. Answer old cookies from memory.
  let until = Math.max(now + MIN_SUCCESS_REUSE_MS, expires - DEFAULT_EXPIRY_MARGIN_SECONDS * 1000);
  const grace = params.oldCookieGraceSeconds;
  if (grace !== undefined) {
    if (Number.isFinite(grace)) {
      // The setting can only shorten the window, and never below 30 s.
      until = Math.min(until, now + Math.max(grace * 1000, MIN_SUCCESS_REUSE_MS));
    } else if (!warnedAboutGrace) {
      warnedAboutGrace = true;
      console.error(
        'Subrite: oldCookieGraceSeconds must be a number of seconds. Using the default.',
      );
    }
  }
  // Never hand out an access token that has already expired.
  return Math.min(until, expires);
}

// An old cookie answered from memory long after its refresh is normal for App Router Server
// Components, which can't save cookies. It can also be a copied session cookie. Log it once.
function warnOnLateReuse(entry: RefreshEntry, now: number): void {
  const { settled, settledAt } = entry;
  if (
    entry.warned ||
    settled?.kind !== 'success' ||
    settledAt === undefined ||
    settled.refreshToken === entry.sentRefreshToken ||
    now - settledAt <= MIN_SUCCESS_REUSE_MS
  ) {
    return;
  }
  entry.warned = true;
  console.warn(
    `Subrite: a request used a refresh token that was replaced ${Math.round((now - settledAt) / 1000)} s ` +
      'ago and got the new tokens from memory. This is expected when Server Components refresh ' +
      'the session. See "Where a refreshed token is saved" in the README.',
  );
}

// One app can talk to several Subrite servers or clients. Never share results between them.
function clientKeyOf(params: RefreshParams): string {
  return JSON.stringify([String(params.subriteUrl), params.clientId]);
}

function refreshKeyOf(params: RefreshParams, refreshToken: string): string {
  return JSON.stringify([String(params.subriteUrl), params.clientId, refreshToken]);
}

// After a revocation, neither this refresh token nor old cookies that it replaced may get
// tokens from memory, and this refresh token is not sent to Subrite again.
function forgetRefreshToken(refreshToken: string, params: RefreshParams): void {
  const prefix = clientKeyOf(params).slice(0, -1);
  const now = Date.now();
  const revoked = (sentRefreshToken: string): RefreshEntry => ({
    outcome: Promise.resolve(PERMANENT),
    settled: PERMANENT,
    settledAt: now,
    startedAt: now,
    sentRefreshToken,
    reuseUntil: now + PERMANENT_FAILURE_REUSE_MS,
    keepUntil: now + PERMANENT_FAILURE_REUSE_MS,
    failures: 0,
    probe: false,
  });
  for (const [key, entry] of state.refreshes) {
    if (!key.startsWith(prefix)) continue;
    const replacedBy = entry.settled?.kind === 'success' ? entry.settled.refreshToken : undefined;
    if (replacedBy === refreshToken) {
      state.refreshes.set(key, revoked(entry.sentRefreshToken));
    }
  }
  const key = refreshKeyOf(params, refreshToken);
  const current = state.refreshes.get(key);
  if (current && !current.settled) {
    // Revoked while a refresh is in progress: settle() keeps the revocation.
    current.outcome = Promise.resolve(PERMANENT);
    current.settled = PERMANENT;
    current.settledAt = now;
    current.reuseUntil = now + PERMANENT_FAILURE_REUSE_MS;
    current.keepUntil = current.reuseUntil;
  } else {
    state.refreshes.delete(key);
    state.refreshes.set(key, revoked(refreshToken));
  }
}

function pruneRefreshes(now: number): void {
  const { refreshes } = state;
  // Also prune when the clock went backwards.
  if (now < state.lastPrune || now - state.lastPrune >= PRUNE_INTERVAL_MS) {
    state.lastPrune = now;
    for (const [key, entry] of refreshes) {
      if (entry.settled && entry.keepUntil <= now) {
        refreshes.delete(key);
      }
    }
  }
  // Make room for one more. The Map keeps insertion order, so the first entries are the oldest.
  // Never drop a refresh that is still in progress: its refresh token would be sent twice.
  if (refreshes.size >= MAX_REFRESH_ENTRIES) {
    for (const [key, entry] of refreshes) {
      if (refreshes.size < MAX_REFRESH_ENTRIES) break;
      if (entry.settled) refreshes.delete(key);
    }
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
    return TEMPORARY;
  }
}

async function callTokenEndpoint(
  refreshToken: string,
  params: RefreshParams,
): Promise<RefreshOutcome> {
  let response: Response;
  try {
    const signal = AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const discovery = await discover(params, signal);
    const request = authenticatedForm(discovery, params);
    if (!request) {
      // A configuration problem. Keep the sessions until it is fixed.
      return TEMPORARY;
    }
    request.form.append('grant_type', 'refresh_token');
    request.form.append('refresh_token', refreshToken);

    // Never follow a redirect: it would send the refresh token (and maybe the client secret) to
    // another address. openid-client refuses redirects on sign in too. 'manual' returns the 3xx
    // as it is, which counts as a temporary failure below. ('error' is not supported everywhere,
    // for example not on Cloudflare Workers.)
    response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: request.headers,
      body: request.form,
      signal,
      redirect: 'manual',
    });
  } catch (error) {
    // Network error, timeout or failed discovery. Worth trying again later.
    console.error('Error refreshing access token:', describeError(error));
    return TEMPORARY;
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
      return TEMPORARY;
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
    if (isRejection(response.status, error)) {
      return PERMANENT;
    }
    if (error && response.status >= 400 && response.status < 500) {
      console.error(
        `Subrite answered ${error}, which points to the client configuration (client id, ` +
          'secret, or allowed grants). Sessions are kept and refreshed once it is fixed.',
      );
    }
    if (response.status >= 300 && response.status < 400) {
      console.error('Subrite redirected the token request. The redirect was not followed.');
    }
    const retryAfterMs = readRetryAfter(response);
    return retryAfterMs === undefined ? TEMPORARY : { kind: 'temporary-failure', retryAfterMs };
  }

  const accessToken = readString(body, 'access_token');
  if (!accessToken) {
    // Not a real token response, for example a maintenance page answering 200. Only
    // invalid_grant signs users out. The body may hold tokens, so only log the status.
    console.error('Error refreshing access token: the token response has no access_token', {
      status: response.status,
    });
    return TEMPORARY;
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

// RFC 6749 section 5.2: invalid_grant means the refresh token is invalid, expired or revoked.
// Every other error code is about the client, the request or the server (invalid_client,
// unauthorized_client, invalid_request, unsupported_grant_type), and says nothing about the
// user's token. A client error without a code comes from something in between, like a firewall.
function isRejection(status: number, error: string | undefined): boolean {
  return status >= 400 && status < 500 && error === 'invalid_grant';
}

// Retry-After is either a number of seconds or an HTTP date (RFC 9110 section 10.2.3).
function readRetryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

type AuthenticatedForm = { headers: Record<string, string>; form: URLSearchParams };

// Same choice as openid-client, which NextAuth uses for the sign in: HTTP Basic unless Subrite
// says it only supports client_secret_post. The config can choose explicitly.
function authenticatedForm(
  discovery: Discovery,
  params: RefreshParams,
): AuthenticatedForm | undefined {
  const method = params.client?.token_endpoint_auth_method ?? defaultAuthMethod(discovery);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const form = new URLSearchParams();
  if (method === 'client_secret_basic') {
    headers.Authorization = basicAuth(params.clientId, params.clientSecret);
  } else if (method === 'client_secret_post') {
    form.append('client_id', params.clientId);
    form.append('client_secret', params.clientSecret);
  } else {
    console.error(
      `Subrite: token_endpoint_auth_method ${method} is not supported. Use client_secret_basic ` +
        'or client_secret_post.',
    );
    return undefined;
  }
  return { headers, form };
}

type Discovery = {
  token_endpoint: string;
  revocation_endpoint?: unknown;
  token_endpoint_auth_methods_supported?: unknown;
};

const discoveryCache = processWide(
  'discovery',
  () => new Map<string, { document: Promise<Discovery>; expires: number }>(),
);

// Fetches Subrite's OpenID configuration once and shares it. The shared request has its own
// timeout, so one caller giving up early doesn't fail the others. Each caller waits only as
// long as its own signal allows.
function discover(params: RefreshParams, signal: AbortSignal): Promise<Discovery> {
  const url = subriteEndpoint(params.subriteUrl, WELL_KNOWN_PATH);
  const cached = discoveryCache.get(url);
  if (cached && cached.expires > Date.now()) {
    return untilAborted(cached.document, signal);
  }
  const timeoutMs = Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const document = fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
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
  return untilAborted(document, signal);
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

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

// Includes the cause (like ECONNREFUSED or a certificate error), which fetch puts there.
// Neither the message nor the cause ever holds a token.
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const text = `${error.name}: ${error.message}`;
  const cause = error.cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    return `${text} (${typeof code === 'string' ? code : cause.name}: ${cause.message})`;
  }
  return text;
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
