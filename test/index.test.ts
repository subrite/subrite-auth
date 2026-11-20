import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import Subrite, {
  generatePostSignOutUrl,
  isAccessTokenExpired,
  refreshAccessToken,
  resetRefreshState,
  toSubriteJWT,
  type RefreshParams,
} from '../src/index.ts';
import { captureConsole, fakeSubrite, ok, sessionToken, unique } from './helpers.ts';

const loggedText = captureConsole();

describe('Subrite provider', () => {
  it('uses the OpenID configuration with PKCE, state and offline access', () => {
    const provider = Subrite({
      clientId: 'id',
      clientSecret: 'secret',
      subriteUrl: 'https://auth.example.com',
    });
    assert.equal(provider.id, 'subrite');
    assert.equal(provider.type, 'oauth');
    assert.equal(
      provider.wellKnown,
      'https://auth.example.com/api/oidc/.well-known/openid-configuration',
    );
    // NextAuth turns it on for a wellKnown configuration. Left out, as in 0.2.x, so the
    // provider object stays the same for snapshot tests.
    assert.equal('idToken' in provider, false);
    assert.deepEqual(provider.checks, ['pkce', 'state']);
    assert.deepEqual(provider.authorization, { params: { scope: 'openid offline_access' } });
    assert.equal(provider.options?.clientId, 'id');
  });

  it('ignores a path in the Subrite URL, as 0.2.x did, and warns once', () => {
    for (let i = 0; i < 2; i += 1) {
      const provider = Subrite({
        clientId: 'id',
        clientSecret: 'secret',
        subriteUrl: 'https://example.com/tenant',
      });
      assert.equal(
        provider.wellKnown,
        'https://example.com/api/oidc/.well-known/openid-configuration',
      );
    }
    assert.equal(loggedText().match(/The path \/tenant is ignored/g)?.length, 1);
  });

  it('maps the profile, and adds the tokens for apps written for 0.2.x', async () => {
    const provider = Subrite({ clientId: 'id', clientSecret: 's', subriteUrl: 'https://a.b' });
    const tokens = { access_token: 'a', refresh_token: 'r', expires_at: 1 };
    const tokenFields = { accessToken: 'a', refreshToken: 'r', accessTokenExpires: 1000 };
    assert.deepEqual(
      await provider.profile?.(
        { sub: '1', name: 'Ada', email: 'ada@example.com', picture: 'p.png', image: 'i.png' },
        tokens,
      ),
      { id: '1', name: 'Ada', email: 'ada@example.com', image: 'p.png', ...tokenFields },
    );
    assert.deepEqual(await provider.profile?.({ sub: '2', image: 'i.png' }, tokens), {
      id: '2',
      name: null,
      email: null,
      image: 'i.png',
      ...tokenFields,
    });
  });

  it('returns a promise from profile(), as 0.2.x did', async () => {
    const provider = Subrite({ clientId: 'id', clientSecret: 's', subriteUrl: 'https://a.b' });
    const tokens = { access_token: 'a', refresh_token: 'r', expires_at: 1 };
    const result = provider.profile?.({ sub: '1' }, tokens);
    assert.ok(result instanceof Promise);
    await result;
    // A missing refresh token rejects instead of throwing.
    const failing = provider.profile?.({ sub: '1' }, { access_token: 'a', expires_at: 1 });
    assert.ok(failing instanceof Promise);
    await assert.rejects(Promise.resolve(failing), /No refresh_token/);
  });

  it('treats an empty picture claim as missing', async () => {
    const provider = Subrite({ clientId: 'id', clientSecret: 's', subriteUrl: 'https://a.b' });
    const tokens = { access_token: 'a', refresh_token: 'r', expires_at: 1 };
    const user = (claims: { sub: string; picture?: string; image?: string }) =>
      Promise.resolve(provider.profile?.(claims, tokens)).then((u) => u?.image);
    assert.equal(await user({ sub: '1', picture: '' }), null);
    assert.equal(await user({ sub: '1', picture: '', image: 'i.png' }), 'i.png');
  });

  it('accepts public clients, and logs other auth methods once', () => {
    const quiet = Subrite({
      clientId: 'id',
      clientSecret: '',
      subriteUrl: 'https://auth.example.com',
      client: { token_endpoint_auth_method: 'none' },
    });
    assert.equal(
      quiet.wellKnown,
      'https://auth.example.com/api/oidc/.well-known/openid-configuration',
    );
    assert.equal(quiet.options.clientId, 'id');
    assert.equal(loggedText(), '');
    for (let i = 0; i < 3; i += 1) {
      Subrite({
        clientId: 'id',
        clientSecret: 's',
        subriteUrl: 'https://auth.example.com',
        client: { token_endpoint_auth_method: 'private_key_jwt' },
      });
    }
    assert.equal(loggedText().match(/private_key_jwt works for sign in/g)?.length, 1);
    // A typo is not a sign in method either.
    Subrite({
      clientId: 'id',
      clientSecret: 's',
      subriteUrl: 'https://auth.example.com',
      client: { token_endpoint_auth_method: 'client_secret_postt' },
    });
    assert.match(loggedText(), /client_secret_postt is not a known method, so sign in and/);
  });

  it('treats an empty token_endpoint_auth_method as not set', async () => {
    const config = { client: { token_endpoint_auth_method: '' } };
    const subrite = fakeSubrite({ token: () => ok({ access_token: 'a', expires_in: 60 }) });
    Subrite({ ...subrite.params, subriteUrl: subrite.subriteUrl, ...config });
    assert.equal(loggedText(), '');
    const refreshed = await refreshAccessToken(sessionToken(), { ...subrite.params, ...config });
    assert.equal(refreshed.accessToken, 'a');
    assert.match(subrite.calls.token[0].headers.get('authorization') ?? '', /^Basic /);
  });
});

describe('toSubriteJWT', () => {
  it('converts expires_at from seconds to milliseconds', () => {
    assert.deepEqual(toSubriteJWT({ access_token: 'a', refresh_token: 'r', expires_at: 1700 }), {
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpires: 1_700_000,
    });
  });

  it('throws when a token is missing', () => {
    assert.throws(() => toSubriteJWT({ refresh_token: 'r', expires_at: 1 }), /No access_token/);
    assert.throws(() => toSubriteJWT({ access_token: 'a', expires_at: 1 }), /No refresh_token/);
    assert.throws(() => toSubriteJWT({ access_token: 'a', refresh_token: 'r' }), /No expires_at/);
  });
});

describe('isAccessTokenExpired', () => {
  it('counts a token as expired one minute early by default', () => {
    assert.equal(isAccessTokenExpired({ accessTokenExpires: Date.now() + 120_000 }), false);
    assert.equal(isAccessTokenExpired({ accessTokenExpires: Date.now() + 30_000 }), true);
    assert.equal(isAccessTokenExpired({ accessTokenExpires: Date.now() - 1 }), true);
  });

  it('takes a custom margin', () => {
    assert.equal(isAccessTokenExpired({ accessTokenExpires: Date.now() + 30_000 }, 0), false);
    assert.equal(isAccessTokenExpired({ accessTokenExpires: Date.now() + 30_000 }, 45), true);
  });

  it('treats a missing or broken expiry as expired', () => {
    assert.equal(isAccessTokenExpired({}), true);
    assert.equal(isAccessTokenExpired({ accessTokenExpires: Number.NaN }), true);
  });
});

describe('generatePostSignOutUrl', () => {
  it('builds the end session URL', () => {
    const url = new URL(
      generatePostSignOutUrl(
        'https://auth.example.com',
        'client id',
        'https://app.example.com/logout',
      ),
    );
    assert.equal(url.origin + url.pathname, 'https://auth.example.com/api/oidc/session/end');
    assert.equal(url.searchParams.get('client_id'), 'client id');
    assert.equal(
      url.searchParams.get('post_logout_redirect_uri'),
      'https://app.example.com/logout',
    );
  });

  it('ignores a path in the Subrite URL, as 0.2.x did', () => {
    const url = new URL(generatePostSignOutUrl('https://example.com/tenant', 'id', 'https://a.b'));
    assert.equal(url.pathname, '/api/oidc/session/end');
  });

  it('accepts null options from JavaScript callers', () => {
    const url = generatePostSignOutUrl('https://a.b', 'id', 'https://c.d', null as never);
    assert.match(url, /client_id=id/);
  });
});

describe('refreshAccessToken', () => {
  it('uses the discovered token endpoint with HTTP Basic auth', async () => {
    const subrite = fakeSubrite({
      token: () =>
        ok({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    });
    const token = sessionToken();
    const before = Date.now();
    const refreshed = await refreshAccessToken(token, subrite.params);

    assert.equal(subrite.calls.token.length, 1);
    const [request] = subrite.calls.token;
    assert.equal(request.headers.get('authorization'), `Basic ${btoa('client+id:s3cret%3A%2B')}`);
    assert.equal(request.form.get('grant_type'), 'refresh_token');
    assert.equal(request.form.get('refresh_token'), token.refreshToken);
    assert.equal(request.form.get('client_secret'), null);
    assert.ok(request.signal, 'the request can time out');

    assert.equal(refreshed.accessToken, 'new-access');
    assert.equal(refreshed.refreshToken, 'new-refresh');
    assert.equal(refreshed.sub, 'user-1');
    assert.equal(refreshed.name, 'Ada');
    assert.ok(refreshed.accessTokenExpires >= before + 3_600_000);
    assert.ok(refreshed.accessTokenExpires <= Date.now() + 3_600_000);
    assert.equal('error' in refreshed, false);
  });

  it('sends the secret in the form when Subrite only supports client_secret_post', async () => {
    const subrite = fakeSubrite({
      discovery: { token_endpoint_auth_methods_supported: ['client_secret_post'] },
      token: () => ok({ access_token: 'a', expires_in: 60 }),
    });
    await refreshAccessToken(sessionToken(), subrite.params);
    const [request] = subrite.calls.token;
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(request.form.get('client_id'), 'client id');
    assert.equal(request.form.get('client_secret'), 's3cret:+');
  });

  it('follows token_endpoint_auth_method from the config', async () => {
    const subrite = fakeSubrite({ token: () => ok({ access_token: 'a', expires_in: 60 }) });
    await refreshAccessToken(sessionToken(), {
      ...subrite.params,
      client: { token_endpoint_auth_method: 'client_secret_post' },
    });
    const [request] = subrite.calls.token;
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(request.form.get('client_secret'), 's3cret:+');
  });

  it('sends only the client id for a public client', async () => {
    const subrite = fakeSubrite({ token: () => ok({ access_token: 'a', expires_in: 60 }) });
    await refreshAccessToken(sessionToken(), {
      ...subrite.params,
      clientSecret: '',
      client: { token_endpoint_auth_method: 'none' },
    });
    // Without a secret and without a method, as apps passed it to 0.2.x.
    await refreshAccessToken(sessionToken(), { ...subrite.params, clientSecret: '' });
    assert.equal(subrite.calls.token.length, 2);
    for (const request of subrite.calls.token) {
      assert.equal(request.headers.get('authorization'), null);
      assert.equal(request.form.get('client_id'), 'client id');
      assert.equal(request.form.has('client_secret'), false);
    }
    assert.equal(loggedText(), '');
  });

  it('keeps the session when token_endpoint_auth_method is not supported', async () => {
    const subrite = fakeSubrite({ token: () => ok({ access_token: 'a', expires_in: 60 }) });
    const token = sessionToken();
    const refreshed = await refreshAccessToken(token, {
      ...subrite.params,
      client: { token_endpoint_auth_method: 'private_key_jwt' },
    });
    assert.deepEqual(refreshed, token, 'a configuration problem never signs users out');
    assert.equal(subrite.calls.token.length, 0);
    assert.match(loggedText(), /private_key_jwt is not supported/);
  });

  it('removes its own error on success, and leaves values the app set alone', async () => {
    const subrite = fakeSubrite({
      token: () => ok({ access_token: unique('access'), expires_in: 60 }),
    });
    const flagged = await refreshAccessToken(
      sessionToken({ error: 'RefreshAccessTokenError' }),
      subrite.params,
    );
    assert.equal('error' in flagged, false);
    const own = await refreshAccessToken(
      sessionToken({ error: 'SubscriptionEnded' }),
      subrite.params,
    );
    assert.equal(own.error, 'SubscriptionEnded');
  });

  it('keeps the old refresh token when Subrite does not send a new one', async () => {
    const subrite = fakeSubrite({
      token: () => ok({ access_token: 'new-access', expires_in: 60 }),
    });
    const token = sessionToken();
    const refreshed = await refreshAccessToken(token, subrite.params);
    assert.equal(refreshed.accessToken, 'new-access');
    assert.equal(refreshed.refreshToken, token.refreshToken);
  });

  it('flags a rejected refresh token and stops calling Subrite', async () => {
    const subrite = fakeSubrite({
      token: () =>
        Response.json({ error: 'invalid_grant', error_description: 'gone' }, { status: 400 }),
    });
    const token = sessionToken();
    const refreshed = await refreshAccessToken(token, subrite.params);
    assert.equal(refreshed.error, 'RefreshAccessTokenError');
    assert.equal(refreshed.accessToken, token.accessToken);
    assert.equal(refreshed.refreshToken, '', 'the rejected refresh token is dropped');
    assert.match(loggedText(), /invalid_grant/);
    assert.doesNotMatch(loggedText(), new RegExp(token.refreshToken));

    const again = await refreshAccessToken(refreshed, subrite.params);
    assert.equal(again, refreshed);
    assert.equal(subrite.calls.token.length, 1);
  });

  it('keeps new tokens without expires_in, assumes 5 minutes, and logs no tokens', async () => {
    const subrite = fakeSubrite({
      token: () => ok({ access_token: 'secret-access', refresh_token: 'secret-refresh' }),
    });
    const token = sessionToken();
    const before = Date.now();
    const refreshed = await refreshAccessToken(token, subrite.params);
    assert.equal(refreshed.accessToken, 'secret-access');
    assert.equal(refreshed.refreshToken, 'secret-refresh');
    assert.ok(refreshed.accessTokenExpires >= before + 300_000);
    assert.ok(refreshed.accessTokenExpires <= Date.now() + 300_000);
    assert.match(loggedText(), /expires_in/);
    assert.doesNotMatch(loggedText(), /secret-access|secret-refresh/);
    assert.doesNotMatch(loggedText(), new RegExp(token.refreshToken));
  });

  it('keeps the session when a 200 has no access token, and logs no tokens', async () => {
    // For example a maintenance page answering 200. Only invalid_grant signs users out.
    const subrite = fakeSubrite({
      token: () => ok({ refresh_token: 'secret-refresh', expires_in: 60 }),
    });
    const token = sessionToken();
    assert.deepEqual(await refreshAccessToken(token, subrite.params), token);
    assert.doesNotMatch(loggedText(), /secret-refresh/);
    assert.doesNotMatch(loggedText(), new RegExp(token.refreshToken));
  });

  it('accepts expires_in as a numeric string', async () => {
    const subrite = fakeSubrite({ token: () => ok({ access_token: 'a', expires_in: '3600' }) });
    const before = Date.now();
    const refreshed = await refreshAccessToken(sessionToken(), subrite.params);
    assert.ok(refreshed.accessTokenExpires >= before + 3_600_000);
  });

  it('leaves the token alone on a temporary failure and backs off', async () => {
    const subrite = fakeSubrite({ token: () => new Response('down', { status: 503 }) });
    const token = sessionToken();
    const refreshed = await refreshAccessToken(token, subrite.params);
    assert.deepEqual(refreshed, token);
    assert.equal('error' in refreshed, false);

    await refreshAccessToken(token, subrite.params);
    assert.equal(subrite.calls.token.length, 1, 'no second call during the back off');
  });

  it('treats 429 as a temporary failure', async () => {
    const subrite = fakeSubrite({ token: () => new Response('slow down', { status: 429 }) });
    const token = sessionToken();
    assert.deepEqual(await refreshAccessToken(token, subrite.params), token);
  });

  it('treats a network error as a temporary failure', async () => {
    const subrite = fakeSubrite({
      token: () => {
        throw new TypeError('fetch failed');
      },
    });
    const token = sessionToken();
    assert.deepEqual(await refreshAccessToken(token, subrite.params), token);
    assert.match(loggedText(), /fetch failed/);
  });

  it('gives up after the timeout', async () => {
    const subrite = fakeSubrite({
      token: ({ signal }) =>
        new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    });
    const token = sessionToken();
    // The timer behind AbortSignal.timeout doesn't keep Node running. A real request does, through
    // its open socket. The fake request has no socket, so keep Node running for it.
    const keepAlive = setTimeout(() => {}, 5000);
    try {
      const started = Date.now();
      const refreshed = await refreshAccessToken(token, { ...subrite.params, timeoutMs: 50 });
      assert.deepEqual(refreshed, token);
      assert.ok(Date.now() - started < 5000);
      assert.match(loggedText(), /TimeoutError/);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('never throws, even without params', async () => {
    const token = sessionToken();
    const refreshed = await refreshAccessToken(token, undefined as unknown as RefreshParams);
    assert.deepEqual(refreshed, token);
  });

  it('ignores httpOptions.timeout, which NextAuth uses for the sign in', async () => {
    const subrite = fakeSubrite({
      token: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return ok({ access_token: 'slow-but-fine', expires_in: 60 });
      },
    });
    const params = { ...subrite.params, httpOptions: { timeout: 50 } };
    const refreshed = await refreshAccessToken(sessionToken(), params);
    assert.equal(refreshed.accessToken, 'slow-but-fine');
  });

  it('waits 30 s for the token endpoint and 10 s for the OpenID configuration by default', async () => {
    const waits: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    mock.method(AbortSignal, 'timeout', (ms: number) => {
      waits.push(ms);
      return original(ms);
    });
    const subrite = fakeSubrite({ token: () => ok({ access_token: 'a', expires_in: 60 }) });
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.deepEqual(waits.sort(), [10_000, 30_000]);
  });

  it('still times out where AbortSignal.timeout is missing, like jsdom before 22', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    const keepAlive = setTimeout(() => {}, 5000);
    try {
      const subrite = fakeSubrite({
        token: ({ signal }) =>
          new Promise<Response>((_, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason));
          }),
      });
      const token = sessionToken();
      const started = Date.now();
      assert.deepEqual(
        await refreshAccessToken(token, { ...subrite.params, timeoutMs: 50 }),
        token,
      );
      assert.ok(Date.now() - started < 2000);
      assert.match(loggedText(), /TimeoutError/);
    } finally {
      clearTimeout(keepAlive);
      if (descriptor) Object.defineProperty(AbortSignal, 'timeout', descriptor);
    }
  });

  it('releases the connection of a failed OpenID configuration request', async () => {
    let cancelled = false;
    const subrite = fakeSubrite({
      discoveryResponse: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('<html>error page</html>'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 500 },
        ),
      token: () => ok({ access_token: 'a', expires_in: 60 }),
    });
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(cancelled, true);
  });

  it('never throws, even with a broken timeout', async () => {
    const subrite = fakeSubrite({ token: () => ok({ access_token: 'a', expires_in: 60 }) });
    const token = sessionToken();
    assert.deepEqual(await refreshAccessToken(token, { ...subrite.params, timeoutMs: -1 }), token);
  });

  it('shares one call to Subrite between parallel requests', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const subrite = fakeSubrite({
      token: async () => {
        await gate;
        return ok({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 60 });
      },
    });
    const token = sessionToken();
    const pending = [1, 2, 3].map(() => refreshAccessToken({ ...token }, subrite.params));
    release();
    const results = await Promise.all(pending);
    assert.equal(subrite.calls.token.length, 1);
    for (const result of results) {
      assert.equal(result.accessToken, 'new-access');
      assert.equal(result.refreshToken, 'new-refresh');
    }
  });

  it('shares one call however the Subrite URL is written', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const subrite = fakeSubrite({
      token: async () => {
        await gate;
        return ok({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 60 });
      },
    });
    const token = sessionToken();
    const spellings = [
      subrite.subriteUrl,
      new URL(subrite.subriteUrl),
      `${subrite.subriteUrl}/`,
      subrite.subriteUrl.toUpperCase(),
    ];
    const pending = spellings.map((subriteUrl) =>
      refreshAccessToken({ ...token }, { ...subrite.params, subriteUrl }),
    );
    release();
    const results = await Promise.all(pending);
    assert.equal(subrite.calls.token.length, 1);
    for (const result of results) {
      assert.equal(result.refreshToken, 'new-refresh');
    }
  });

  it('reuses a fresh result for a request that still has the old refresh token', async () => {
    const subrite = fakeSubrite({
      token: () => ok({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 60 }),
    });
    const token = sessionToken();
    await refreshAccessToken(token, subrite.params);
    const late = await refreshAccessToken(token, subrite.params);
    assert.equal(subrite.calls.token.length, 1);
    assert.equal(late.refreshToken, 'new-refresh');
  });

  it('caches the OpenID configuration', async () => {
    const subrite = fakeSubrite({ token: () => ok({ access_token: 'a', expires_in: 60 }) });
    await refreshAccessToken(sessionToken(), subrite.params);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.discovery, 1);
    assert.equal(subrite.calls.token.length, 2);
  });

  it('does not cache a failed OpenID configuration request', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const subrite = fakeSubrite({
      discoveryStatus: 500,
      token: () => ok({ access_token: 'a', expires_in: 60 }),
    });
    const token = sessionToken();
    assert.deepEqual(await refreshAccessToken(token, subrite.params), token);
    // Refreshes pause for 10 s after a failure. Then the next one fetches the configuration again.
    mock.timers.tick(10_000);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.discovery, 2);
    assert.equal(subrite.calls.token.length, 0);
  });

  it('flags a token without a refresh token without calling Subrite', async () => {
    const subrite = fakeSubrite({ token: () => ok({ access_token: 'a', expires_in: 60 }) });
    const token = { ...sessionToken(), refreshToken: undefined as unknown as string };
    const refreshed = await refreshAccessToken(token, subrite.params);
    assert.equal(refreshed.error, 'RefreshAccessTokenError');
    assert.equal(subrite.calls.discovery, 0);
  });
});

describe('refresh sharing', () => {
  it('never shares a result between two Subrite servers', async () => {
    const first = fakeSubrite({ token: () => ok({ access_token: 'from-first', expires_in: 60 }) });
    const token = sessionToken();
    assert.equal((await refreshAccessToken(token, first.params)).accessToken, 'from-first');

    const second = fakeSubrite({
      token: () => ok({ access_token: 'from-second', expires_in: 60 }),
    });
    assert.equal((await refreshAccessToken(token, second.params)).accessToken, 'from-second');
    assert.equal(second.calls.token.length, 1);
  });

  it('starts over after resetRefreshState, so app tests can reuse a refresh token', async () => {
    const subrite = fakeSubrite({ token: () => ok({ access_token: unique('a'), expires_in: 60 }) });
    const token = sessionToken();
    await refreshAccessToken(token, subrite.params);
    await refreshAccessToken(token, subrite.params);
    assert.equal(subrite.calls.token.length, 1);
    assert.equal(subrite.calls.discovery, 1);
    resetRefreshState();
    await refreshAccessToken(token, subrite.params);
    assert.equal(subrite.calls.token.length, 2);
    assert.equal(subrite.calls.discovery, 2);
  });

  it('ignores refreshes that finish after resetRefreshState', async () => {
    // A test that ends without waiting for its refresh must not leak into the next one.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const subrite = fakeSubrite({
      token: async () => {
        if (first) {
          first = false;
          await gate;
        }
        return new Response('down', { status: 503 });
      },
    });
    const pending = refreshAccessToken(sessionToken(), subrite.params);
    resetRefreshState();
    // Two failures of this test's own. With the leaked one they would make three: an outage.
    await refreshAccessToken(sessionToken(), subrite.params);
    await refreshAccessToken(sessionToken(), subrite.params);
    release();
    await pending;
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.token.length, 4, 'the third failure of this test is its own');
  });
});
