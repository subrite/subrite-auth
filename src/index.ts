import type { Awaitable, TokenSet, User } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import type {
  OAuthConfig,
  OAuthProviderButtonStyles,
  OAuthUserConfig,
} from 'next-auth/providers/oauth';

/** The value of `error` when Subrite rejected the refresh token. The user must sign in again. */
export type SubriteTokenError = 'RefreshAccessTokenError';

/** The Subrite tokens, as `toSubriteJWT` returns them. */
export interface SubriteTokens {
  accessToken: string;
  /** Empty once Subrite has rejected it. */
  refreshToken: string;
  /** When the access token expires, in milliseconds since epoch. Easy to compare with `Date.now()`. */
  accessTokenExpires: number;
}

/** The Subrite tokens kept in the NextAuth JWT. */
export interface SubriteJWT extends SubriteTokens {
  /**
   * `'RefreshAccessTokenError'` with an empty `refreshToken` when Subrite rejected the refresh
   * token and the user must sign in again. With a refresh token it is a stale 0.2.x flag, which
   * the next successful refresh removes. The library leaves other values your app sets alone.
   */
  error?: SubriteTokenError | (string & {}) | null | undefined;
}

/** Properties to add to the NextAuth session. See the README for how to wire them up. */
export interface SubriteSession {
  accessToken?: string | undefined;
  error?: SubriteTokenError | (string & {}) | null | undefined;
}

/** The claims Subrite returns about the signed in user. */
export interface SubriteClaims {
  sub: string;
  name?: string;
  email?: string;
  /** The standard OpenID Connect claim for the profile picture. */
  picture?: string;
  /** Non standard name for the profile picture. Used when `picture` is missing. */
  image?: string;
}

/**
 * @deprecated The 0.2.x type, kept so module augmentations written for 0.2.x still compile. The
 * token fields are not part of Subrite's claims. Use `SubriteClaims` for the claims and
 * `SubriteSession` to augment the session.
 */
export interface SubriteProfile extends SubriteJWT {
  sub: string;
  name: string;
  email: string;
  image: string;
}

type UserConfig = OAuthUserConfig<SubriteClaims>;
type ClientMetadata = NonNullable<UserConfig['client']>;
// The named fields of openid-client's ClientMetadata. A plain Omit would keep only its index
// signature and drop every field type.
type NamedClientMetadata = {
  [
    K in keyof ClientMetadata as string extends K
      ? never
      : number extends K
        ? never
        : K extends 'token_endpoint_auth_method'
          ? never
          : K
  ]: ClientMetadata[K];
};

/** The token endpoint authentication methods the refresh supports. */
export type SubriteAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

/**
 * What a profile override returns. NextAuth's `User`, except that `name`, `email` and `image` may
 * also be `undefined`, as 0.2.x returned them for missing claims. That also compiles with
 * `exactOptionalPropertyTypes`.
 */
export type SubriteUser = {
  // Not Omit, which would drop `id` when an app's User augmentation has an index signature.
  [K in keyof User as K extends 'name' | 'email' | 'image' ? never : K]: User[K];
} & {
  name?: string | null | undefined;
  email?: string | null | undefined;
  image?: string | null | undefined;
};

export type SubriteConfig = Omit<UserConfig, 'client' | 'profile' | 'style'> & {
  /** The Subrite server's origin, like `https://example.subrite.no`. A path is ignored. */
  subriteUrl: string;
  /**
   * Client metadata for the sign in. `token_endpoint_auth_method` takes any string, so a plain
   * config object compiles. Subrite() logs an error for a value the refresh doesn't support.
   */
  client?:
    | (NamedClientMetadata & {
        token_endpoint_auth_method?: SubriteAuthMethod | (string & {}) | undefined;
        [key: string]: unknown;
      })
    | undefined;
  /**
   * Replaces the default profile mapping. A method, so overrides written for 0.2.x with a
   * `SubriteProfile` parameter still compile.
   */
  profile?(profile: SubriteClaims, tokens: TokenSet): Awaitable<SubriteUser>;
  /** The button on NextAuth's built in sign in page. NextAuth fills in what is left out. */
  style?: Partial<OAuthProviderButtonStyles> | undefined;
};

/** What Subrite() returns: a NextAuth provider whose `options` is the config passed in. */
export type SubriteProvider = OAuthConfig<SubriteClaims> & { options: SubriteConfig };

/**
 * What `ReturnType<typeof Subrite>`, `jest.mocked(Subrite)` and `vi.mocked(Subrite)` see: the
 * provider with `options` optional, so test doubles can leave it out.
 */
export type SubriteProviderLike = OAuthConfig<SubriteClaims> & {
  options?: Partial<SubriteConfig> | undefined;
};

export type RefreshParams = {
  subriteUrl: string | URL;
  clientId: string;
  clientSecret: string;
  /**
   * Only `token_endpoint_auth_method` is used. Set it if you also set it in the provider config,
   * so the refresh request authenticates the same way as the sign in.
   */
  client?:
    | {
        token_endpoint_auth_method?: SubriteAuthMethod | (string & {}) | undefined;
        [key: string]: unknown;
      }
    | undefined;
  /**
   * Not used. Allowed so you can pass the provider config. NextAuth's `httpOptions.timeout` is for
   * the sign in, and refreshes go through the global `fetch`. Set `timeoutMs` instead.
   */
  httpOptions?: { [key: string]: unknown } | undefined;
  /**
   * How long to wait for Subrite before giving up. Defaults to 30 seconds (3 seconds for
   * `revokeRefreshToken`, which runs while the user waits to sign out). Giving up on a refresh
   * that Subrite already handled can cost the user the session when Subrite replaces refresh
   * tokens, so don't set it much lower.
   */
  timeoutMs?: number | undefined;
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
  oldCookieGraceSeconds?: number | undefined;
};

export type SignOutOptions = {
  /**
   * Subrite sends this back to `postLogoutRedirectUri`. Check it there before signing the user
   * out of the app, so other sites can't sign your users out by linking to that page.
   */
  state?: string | undefined;
  /** The ID token from the sign in, if you keep it. Lets Subrite skip asking the user to confirm. */
  idTokenHint?: string | undefined;
};

const WELL_KNOWN_PATH = 'api/oidc/.well-known/openid-configuration';
const SIGN_OUT_PATH = 'api/oidc/session/end';
const REFRESH_ERROR: SubriteTokenError = 'RefreshAccessTokenError';
const SUPPORTED_AUTH_METHODS: readonly string[] = [
  'client_secret_basic',
  'client_secret_post',
  'none',
] satisfies SubriteAuthMethod[];
// Methods NextAuth's sign in supports, but the refresh doesn't.
const SIGN_IN_ONLY_AUTH_METHODS: readonly string[] = [
  'client_secret_jwt',
  'private_key_jwt',
  'tls_client_auth',
  'self_signed_tls_client_auth',
];

// Generous: when Subrite replaces refresh tokens, a refresh given up after Subrite handled it
// leaves the session with a used refresh token. Still well below fetch's own 300 seconds.
const DEFAULT_TIMEOUT_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
// Revocation is best effort, and NextAuth waits for it before it signs the user out.
const DEFAULT_REVOKE_TIMEOUT_MS = 3_000;
const DEFAULT_EXPIRY_MARGIN_SECONDS = 60;
// Requests that arrive together share one refresh. A result is reused at least this long.
const MIN_SUCCESS_REUSE_MS = 30_000;
// A rejected refresh token is answered from memory for this long, without asking Subrite again.
const PERMANENT_FAILURE_REUSE_MS = 60 * 60 * 1000;
// After a temporary failure, the refresh token waits before it is tried again: 10 s, doubling
// with every failure in a row up to the maximum, unless Subrite says how long with Retry-After.
const BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
// When this many different refresh tokens fail for the first time with no answer from Subrite in
// between (new tokens or a rejection), Subrite is likely down for the client, or the client is
// misconfigured. Its refreshes then pause the same way, but for at most a minute (unless
// Retry-After asks for longer), so users get new tokens soon after Subrite is back.
const OUTAGE_MIN_FAILING_TOKENS = 3;
const MAX_OUTAGE_PAUSE_MS = 60_000;
// Failures further apart than this don't count as in a row, and don't add up to an outage.
const FAILURE_MEMORY_MS = 15 * 60 * 1000;
// Used when Subrite leaves out expires_in. Short, so a real expiry is missed by little.
const FALLBACK_EXPIRES_IN_SECONDS = 300;
// Bounds the memory used by the refresh cache in one process.
const MAX_REFRESH_ENTRIES = 10_000;
const PRUNE_INTERVAL_MS = 10_000;
const DISCOVERY_CACHE_MS = 60 * 60 * 1000;

// Direct calls get the first signature, with a typed `options`. ReturnType, mock types and
// Subrite passed as a value (configs.map(Subrite)) get the last one, so test doubles written for
// 0.2.x without `options` still compile.
export default function Subrite(config: SubriteConfig): SubriteProvider;
export default function Subrite(config: SubriteConfig): SubriteProviderLike;
export default function Subrite(config: SubriteConfig): SubriteProvider {
  warnAboutPath(config.subriteUrl);
  // An empty method counts as not set.
  const authMethod = config.client?.token_endpoint_auth_method;
  if (authMethod && !SUPPORTED_AUTH_METHODS.includes(authMethod)) {
    logOnce(
      `auth-method:${authMethod}`,
      SIGN_IN_ONLY_AUTH_METHODS.includes(authMethod)
        ? `Subrite: token_endpoint_auth_method ${authMethod} works for sign in, but ` +
            'refreshAccessToken only supports client_secret_basic, client_secret_post and none.'
        : `Subrite: token_endpoint_auth_method ${authMethod} is not a known method, so sign in ` +
            'and refreshAccessToken will fail. Use client_secret_basic, client_secret_post or none.',
      'error',
    );
  }
  return {
    id: 'subrite',
    name: 'Subrite',
    type: 'oauth',
    version: '2.0',
    // NextAuth validates the ID token and reads the profile from its claims, as it does for any
    // `wellKnown` OpenID configuration.
    wellKnown: subriteEndpoint(config.subriteUrl, WELL_KNOWN_PATH),
    checks: ['pkce', 'state'],
    authorization: {
      params: {
        scope: 'openid offline_access',
      },
    },
    // Async, as in 0.2.x, so code that chains .then() on it keeps working.
    async profile(profile, tokens): Promise<User & SubriteJWT> {
      return {
        id: profile.sub,
        name: profile.name ?? null,
        email: profile.email ?? null,
        // An empty claim counts as missing, so the app's placeholder picture still shows.
        image: profile.picture || profile.image || null,
        // Deprecated, kept for apps written for 0.2.x whose jwt callback reads the tokens from
        // `user` on sign in. Read them from `account` with toSubriteJWT instead.
        ...toSubriteJWT(tokens),
      };
    },
    // NextAuth reads these as OAuthUserConfig. Subrite() itself checks the auth method above.
    options: config as SubriteConfig & UserConfig,
  };
}

/** Picks the Subrite tokens out of the `account` NextAuth passes to the `jwt` callback on sign in. */
export function toSubriteJWT(tokens: TokenSet): SubriteTokens {
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
 *
 * The margin must be well below the access token lifetime (Subrite's are hours). With tokens
 * that live a minute or two, pass a smaller margin, or every request refreshes.
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
  | {
      kind: 'temporary-failure';
      retryAfterMs?: number;
      /**
       * Subrite answered 500 server_error, node-oidc-provider's answer to any unexpected
       * failure. That can be one account's bad data or Subrite's storage being down, so it
       * counts towards an outage, but never makes the outage pause longer.
       */
      serverError?: boolean;
    };

const TEMPORARY: RefreshOutcome = { kind: 'temporary-failure' };
const PERMANENT: RefreshOutcome = { kind: 'permanent-failure' };

type RefreshEntry = {
  outcome: Promise<RefreshOutcome>;
  /** Set once the request has finished. */
  settled?: RefreshOutcome;
  settledAt?: number;
  /** monotonicNow() when it settled, to measure waits across a clock that went backwards. */
  settledMono?: number;
  /** state.seq when it settled, to order it against Subrite's answers whatever the clock does. */
  settledSeq?: number;
  startedAt: number;
  /** The refresh token this entry sent to Subrite. */
  sentRefreshToken: string;
  /** Until when other requests with the same refresh token get this outcome. */
  reuseUntil: number;
  /** Until when the entry is kept. Longer than reuseUntil after a failure, to count failures. */
  keepUntil: number;
  /** Temporary failures in a row for this refresh token. */
  failures: number;
  /** This request checks whether Subrite is back during an outage. */
  probe: boolean;
  /** The probe's refresh token had not failed in this outage yet, so its failure is news. */
  freshProbe: boolean;
  /** Failed while Subrite seemed down. Forgiven as soon as Subrite answers again. */
  duringOutage: boolean;
  /** Whether a late reuse of this entry has been logged. */
  warned?: boolean;
  /** state.generation when the entry was made. */
  generation: number;
};

/** How Subrite has been answering for one Subrite URL and client id. */
type ClientHealth = {
  /** state.seq when Subrite last really answered a refresh (new tokens or a rejection). */
  lastAnswerSeq: number;
  /**
   * Refresh tokens that failed since then, while no outage was declared. One failing refresh
   * token may be that token's own problem. Two different ones mean Subrite is likely down.
   */
  failing: Set<string>;
  failingSince: number;
  outage: boolean;
  /** Steps of the outage. Each step doubles the pause. */
  step: number;
  /** During an outage, no new refreshes from pausedFrom until pausedUntil. */
  pausedFrom: number;
  pausedUntil: number;
  /**
   * Refresh tokens that already failed in this outage also wait until then. A failure from one
   * of them is no news, so it only holds back the others like it, never users who haven't
   * failed. Otherwise a few broken accounts could keep healthy users out for minutes.
   */
  stalePausedUntil: number;
  /**
   * A refresh is checking whether Subrite is back. Until it has an answer, other refresh tokens
   * get their token back unchanged right away.
   */
  probing: boolean;
};

type State = {
  refreshes: Map<string, RefreshEntry>;
  clients: Map<string, ClientHealth>;
  lastPrune: number;
  /**
   * Counts resetRefreshState calls, so the outcome of refreshes still in progress then is
   * ignored.
   */
  generation: number;
  /** Counts settled refreshes and answers, to order them without the wall clock. */
  seq: number;
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
const state = /* @__PURE__ */ processWide<State>('state', () => ({
  refreshes: new Map(),
  clients: new Map(),
  lastPrune: 0,
  generation: 0,
  seq: 0,
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
  try {
    return await refresh(token, params);
  } catch (error) {
    // Only reachable with broken arguments (for example params undefined in JavaScript). A throw
    // from the jwt callback would make NextAuth clear the session, so keep the token instead.
    console.error('Error refreshing access token:', describeError(error));
    return token;
  }
}

async function refresh(token: JWT & SubriteJWT, params: RefreshParams): Promise<JWT & SubriteJWT> {
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
      // Only the library's own flag. Values the app sets are the app's.
      if (refreshed.error === REFRESH_ERROR) {
        delete refreshed.error;
      }
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
  try {
    const refreshToken = token?.refreshToken;
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return false;
    }
    forgetRefreshToken(refreshToken, params);
    const signal = timeoutSignal(params.timeoutMs ?? DEFAULT_REVOKE_TIMEOUT_MS);
    const discovery = await discover(params, signal);
    const endpoint = readString(discovery, 'revocation_endpoint');
    if (!endpoint) {
      warnOnce(
        `no-revocation:${clientKeyOf(params)}`,
        'Subrite: this Subrite server has no revocation_endpoint, so revokeRefreshToken cannot ' +
          'revoke refresh tokens. They keep working until they expire.',
      );
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
  const health = clientHealth(clientKey, now);
  const existing = state.refreshes.get(key);
  const failedAt = existing?.settled?.kind === 'temporary-failure' ? existing.settledAt : undefined;
  if (existing && failedAt !== undefined && failedAt > now) {
    // The clock went backwards (for example an NTP correction), which would stretch the wait
    // after this failure by the size of the step. Take the time since the failure from the
    // monotonic clock instead, so the token waits as long as it was told to, Retry-After
    // included.
    const elapsed = Math.max(0, monotonicNow() - (existing.settledMono ?? Infinity));
    const shift = failedAt - (now - elapsed);
    existing.settledAt = failedAt - shift;
    existing.reuseUntil -= shift;
    existing.keepUntil -= shift;
  }
  // A failure during an outage is not the token's fault. Once Subrite answers again, try now.
  const forgiven = existing !== undefined && isForgiven(existing, health);
  // During an outage, the pause for the whole client (at most a minute, unless Retry-After asks
  // for longer) replaces the wait of a refresh token that failed in it. Otherwise, with only such
  // tokens around, nothing would check whether Subrite is back for up to 5 minutes.
  const outageWait =
    health.outage &&
    existing?.duringOutage === true &&
    existing.settled?.kind === 'temporary-failure';
  if (existing && existing.reuseUntil > now && !forgiven && !outageWait) {
    warnOnLateReuse(existing, now);
    return existing.outcome;
  }
  // Failures in a row for this refresh token, if its last attempt failed recently. A forgiven
  // token counts as having failed once, so if it fails again right away (it may be broken), it
  // doesn't count towards a new outage.
  const failedRecently =
    existing?.settled?.kind === 'temporary-failure' && existing.keepUntil > now;
  const tokenFailures = forgiven ? 1 : failedRecently ? existing.failures : 0;

  let probe = false;
  let freshProbe = false;
  if (health.outage) {
    // A refresh token that failed recently (in this outage or just before) can't tell whether
    // Subrite is back: it may be broken itself.
    const stale = tokenFailures > 0;
    const pausedUntil = stale
      ? Math.max(health.pausedUntil, health.stalePausedUntil)
      : health.pausedUntil;
    if (pausedUntil > now || health.probing) {
      // Subrite seems down. Keep the token and don't add to the load.
      return Promise.resolve(TEMPORARY);
    }
    // This request checks whether Subrite is back. Until it has an answer, other refresh tokens
    // get their token back unchanged.
    probe = true;
    health.probing = true;
    freshProbe = !stale;
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
    freshProbe,
    duringOutage: false,
    generation: state.generation,
  };
  // Delete first, so the Map's insertion order stays oldest first for pruning.
  state.refreshes.delete(key);
  state.refreshes.set(key, entry);
  entry.outcome.then((outcome) => settle(entry, key, clientKey, outcome, params));
  return entry.outcome;
}

function isForgiven(entry: RefreshEntry, health: ClientHealth): boolean {
  return (
    entry.settled?.kind === 'temporary-failure' &&
    entry.duringOutage &&
    (entry.settledSeq ?? 0) < health.lastAnswerSeq
  );
}

function clientHealth(clientKey: string, now: number): ClientHealth {
  let health = state.clients.get(clientKey);
  if (!health) {
    health = {
      lastAnswerSeq: 0,
      failing: new Set(),
      failingSince: 0,
      outage: false,
      step: 0,
      pausedFrom: 0,
      pausedUntil: 0,
      stalePausedUntil: 0,
      probing: false,
    };
    state.clients.set(clientKey, health);
  }
  // A clock that went backwards (for example an NTP correction) would stretch a pause by the
  // size of the step. End the pause instead: only one probe goes through anyway.
  if (now < health.pausedFrom) {
    health.pausedUntil = now;
    health.stalePausedUntil = now;
  }
  // Failures far apart don't add up to an outage.
  if (health.failing.size > 0 && Math.abs(now - health.failingSince) > FAILURE_MEMORY_MS) {
    health.failing.clear();
  }
  return health;
}

function settle(
  entry: RefreshEntry,
  key: string,
  clientKey: string,
  outcome: RefreshOutcome,
  params: RefreshParams,
): void {
  // Started before resetRefreshState: it belongs to a test that is over. (Not whether the entry
  // is still in the map: a second revocation replaces it, and its outcome must still count.)
  if (entry.generation !== state.generation) return;
  const now = Date.now();
  // Revoked while the request was in progress: the revocation wins.
  const revoked = entry.settled !== undefined;
  if (!revoked) {
    entry.settled = outcome;
    entry.settledAt = now;
    entry.settledMono = monotonicNow();
    entry.settledSeq = ++state.seq;
  }
  const health = clientHealth(clientKey, now);
  if (entry.probe) {
    health.probing = false;
  }

  if (outcome.kind !== 'temporary-failure') {
    // Subrite answered, so it is up. Any outage is over.
    health.lastAnswerSeq = ++state.seq;
    health.failing.clear();
    health.outage = false;
    health.step = 0;
    health.pausedUntil = 0;
    health.stalePausedUntil = 0;
    if (revoked) return;
    entry.failures = 0;
    entry.reuseUntil =
      outcome.kind === 'success'
        ? successReuseUntil(entry, outcome, params, now)
        : now + PERMANENT_FAILURE_REUSE_MS;
    entry.keepUntil = entry.reuseUntil;
    return;
  }

  const failedBefore = entry.failures > 0;
  if (!revoked) {
    // This refresh token waits on its own, longer after each failure in a row. A refresh token
    // that keeps failing (for example bad data for one account) only delays itself.
    entry.failures += 1;
    entry.reuseUntil = now + pauseLength(entry.failures, outcome.retryAfterMs);
    entry.keepUntil = Math.max(entry.reuseUntil, now + FAILURE_MEMORY_MS);
  }

  if (!health.outage) {
    // A refresh token that failed before may be the problem itself. Only first failures of
    // different refresh tokens add up to an outage.
    if (failedBefore) {
      return;
    }
    if (health.failing.size === 0) {
      health.failingSince = now;
    }
    health.failing.add(key);
    if (health.failing.size < OUTAGE_MIN_FAILING_TOKENS) {
      return;
    }
    // Several different refresh tokens failed with no answer from Subrite in between: Subrite is
    // likely down for this client. Pause all refreshes and probe one at a time.
    health.outage = true;
    health.step = 1;
    health.stalePausedUntil = 0;
    pause(health, now, outagePauseLength(1, outcome.retryAfterMs));
    for (const failingKey of health.failing) {
      const failed = state.refreshes.get(failingKey);
      if (failed) failed.duringOutage = true;
    }
    health.failing.clear();
    return;
  }

  entry.duringOutage = true;
  if (entry.probe && entry.freshProbe) {
    // A refresh token that had not failed yet failed too: Subrite is still down. Wait longer,
    // unless it was server_error, which may be that account's own problem. Then check again
    // after a pause of the same length. (Not a shorter one: a struggling Subrite often mixes
    // server_error with 503s and timeouts.)
    if (!outcome.serverError) health.step += 1;
    pause(health, now, outagePauseLength(health.step, outcome.retryAfterMs));
  } else if (entry.probe) {
    // No news from a refresh token that already failed. Only tokens like it wait again, so
    // users who haven't failed can still check whether Subrite is back. The wait grows with the
    // token's failures, so a few such users don't check every 10 seconds for a whole outage.
    health.pausedFrom = now;
    health.stalePausedUntil =
      now + outagePauseLength(Math.max(health.step, entry.failures), outcome.retryAfterMs);
  } else {
    // A request that was already on its way: part of the same step.
    const length = outagePauseLength(health.step, outcome.retryAfterMs);
    pause(health, now, Math.max(health.pausedUntil - now, length));
  }
}

function pause(health: ClientHealth, now: number, length: number): void {
  health.pausedFrom = now;
  health.pausedUntil = now + length;
}

// For the whole client: like pauseLength, but at most a minute unless Subrite asked for longer
// with Retry-After. One check a minute is no real load, and it bounds the wait after recovery.
function outagePauseLength(step: number, retryAfterMs: number | undefined): number {
  return retryAfterMs !== undefined
    ? pauseLength(step, retryAfterMs)
    : Math.min(pauseLength(step, undefined), MAX_OUTAGE_PAUSE_MS);
}

// 10 s doubling to 5 min, or what Subrite asked for with Retry-After, within the same bounds.
function pauseLength(step: number, retryAfterMs: number | undefined): number {
  const wanted = retryAfterMs ?? BACKOFF_MS * 2 ** Math.min(Math.max(step, 1) - 1, 10);
  return Math.min(Math.max(wanted, BACKOFF_MS), MAX_BACKOFF_MS);
}

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
    } else {
      logOnce(
        'grace',
        'Subrite: oldCookieGraceSeconds must be a number of seconds. Using the default.',
        'error',
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
  return JSON.stringify([serverOf(params.subriteUrl), params.clientId]);
}

function refreshKeyOf(params: RefreshParams, refreshToken: string): string {
  return JSON.stringify([serverOf(params.subriteUrl), params.clientId, refreshToken]);
}

// The origin, since a path is ignored anyway. A string, a URL or a trailing slash is one server.
function serverOf(subriteUrl: string | URL): string {
  let origin = 'null';
  try {
    origin = new URL(subriteUrl).origin;
  } catch {
    // An invalid URL fails loudly when it is used.
  }
  return origin === 'null' ? String(subriteUrl) : origin;
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
    freshProbe: false,
    duringOutage: false,
    generation: state.generation,
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
    const signal = timeoutSignal(params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
    if (error && CLIENT_ERRORS.includes(error)) {
      console.error(
        `Subrite answered ${error}, which points to the client configuration (client id, ` +
          'secret, or allowed grants). Sessions are kept and refreshed once it is fixed.',
      );
    }
    if (response.status >= 300 && response.status < 400) {
      console.error('Subrite redirected the token request. The redirect was not followed.');
    }
    const failure: RefreshOutcome = { kind: 'temporary-failure' };
    const retryAfterMs = readRetryAfter(response);
    if (retryAfterMs !== undefined) {
      failure.retryAfterMs = retryAfterMs;
    }
    if (response.status === 500 && error === 'server_error') {
      failure.serverError = true;
    }
    return failure;
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
    console.warn(
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

// RFC 6749 section 5.2 error codes about the client or the request rather than the token.
const CLIENT_ERRORS = [
  'invalid_client',
  'unauthorized_client',
  'invalid_request',
  'unsupported_grant_type',
  'invalid_scope',
];

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
// says it only supports client_secret_post. The config can choose explicitly. Without a secret
// the client is public (`none`) and only sends its id, as 0.2.x effectively did.
function authenticatedForm(
  discovery: Discovery,
  params: RefreshParams,
): AuthenticatedForm | undefined {
  // An empty method counts as not set.
  const method =
    params.client?.token_endpoint_auth_method ||
    (params.clientSecret ? defaultAuthMethod(discovery) : 'none');
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
  } else if (method === 'none') {
    form.append('client_id', params.clientId);
  } else {
    logOnce(
      `unsupported-method:${method}:${clientKeyOf(params)}`,
      `Subrite: token_endpoint_auth_method ${method} is not supported. Use client_secret_basic, ` +
        'client_secret_post or none.',
      'error',
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

const discoveryCache = /* @__PURE__ */ processWide(
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
  const timeoutMs = Math.max(params.timeoutMs ?? 0, DISCOVERY_TIMEOUT_MS);
  const document = fetch(url, {
    headers: { Accept: 'application/json' },
    signal: timeoutSignal(timeoutMs),
    redirect: 'manual',
  }).then(async (response) => {
    if (!response.ok) {
      // Release the connection: a large error page would otherwise keep the socket open.
      await response.body?.cancel().catch(() => {});
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
  // JavaScript callers may pass null.
  const { state, idTokenHint } = options ?? {};
  if (state) {
    subriteSignoutUrl.searchParams.append('state', state);
  }
  if (idTokenHint) {
    subriteSignoutUrl.searchParams.append('id_token_hint', idTokenHint);
  }
  return subriteSignoutUrl.toString();
}

// An endpoint on the Subrite server. As in 0.2.x, a path in the Subrite URL is ignored.
function subriteEndpoint(subriteUrl: string | URL, path: string): string {
  return new URL(`/${path}`, subriteUrl).href;
}

function warnAboutPath(subriteUrl: string | URL): void {
  let pathname: string;
  try {
    pathname = new URL(subriteUrl).pathname;
  } catch {
    return; // An invalid URL fails loudly elsewhere.
  }
  if (pathname !== '/' && pathname !== '') {
    warnOnce(
      `path:${String(subriteUrl)}`,
      `Subrite: subriteUrl should be the server's origin, like https://example.subrite.no. ` +
        `The path ${pathname} is ignored.`,
    );
  }
}

// Milliseconds that keep counting forward when the wall clock is set back.
function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

// AbortSignal.timeout, with a fallback for test environments without it, like jsdom before 22.1
// (Jest 29's jest-environment-jsdom).
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer: unknown = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  return controller.signal;
}

// Messages logged once per process, also across the copies of the library Next.js loads.
const logged = /* @__PURE__ */ processWide('logged', () => new Set<string>());

function logOnce(key: string, message: string, level: 'warn' | 'error' = 'warn'): void {
  if (logged.has(key)) return;
  logged.add(key);
  console[level](message);
}

function warnOnce(key: string, message: string): void {
  logOnce(key, message);
}

/**
 * Clears what the library keeps in memory: shared refresh results, backoff and outage state, the
 * cached OpenID configuration, and which warnings were logged. For tests, so each test starts
 * fresh. An app never needs it.
 */
export function resetRefreshState(): void {
  state.generation += 1;
  state.refreshes.clear();
  state.clients.clear();
  state.lastPrune = 0;
  discoveryCache.clear();
  logged.clear();
}
