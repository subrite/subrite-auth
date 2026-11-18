import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Subrite, {
  generatePostSignOutUrl,
  isAccessTokenExpired,
  refreshAccessToken,
  toSubriteJWT,
} from '../src/index.ts';
import { captureConsole, fakeSubrite, ok, sessionToken } from './helpers.ts';

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
    assert.equal(provider.idToken, true);
    assert.deepEqual(provider.checks, ['pkce', 'state']);
    assert.deepEqual(provider.authorization, { params: { scope: 'openid offline_access' } });
    assert.equal(provider.options?.clientId, 'id');
  });

  it('keeps a path in the Subrite URL', () => {
    for (const subriteUrl of ['https://example.com/tenant', 'https://example.com/tenant/']) {
      const provider = Subrite({ clientId: 'id', clientSecret: 'secret', subriteUrl });
      assert.equal(
        provider.wellKnown,
        'https://example.com/tenant/api/oidc/.well-known/openid-configuration',
      );
    }
  });

  it('maps the profile without any tokens', async () => {
    const provider = Subrite({ clientId: 'id', clientSecret: 's', subriteUrl: 'https://a.b' });
    const tokens = { access_token: 'a', refresh_token: 'r', expires_at: 1 };
    assert.deepEqual(
      await provider.profile?.(
        { sub: '1', name: 'Ada', email: 'ada@example.com', picture: 'p.png', image: 'i.png' },
        tokens,
      ),
      { id: '1', name: 'Ada', email: 'ada@example.com', image: 'p.png' },
    );
    assert.deepEqual(await provider.profile?.({ sub: '2', image: 'i.png' }, tokens), {
      id: '2',
      name: null,
      email: null,
      image: 'i.png',
    });
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

  it('keeps a path in the Subrite URL', () => {
    const url = new URL(generatePostSignOutUrl('https://example.com/tenant', 'id', 'https://a.b'));
    assert.equal(url.pathname, '/tenant/api/oidc/session/end');
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

  it('flags an unsupported token_endpoint_auth_method without calling Subrite', async () => {
    const subrite = fakeSubrite({ token: () => ok({ access_token: 'a', expires_in: 60 }) });
    const refreshed = await refreshAccessToken(sessionToken(), {
      ...subrite.params,
      client: { token_endpoint_auth_method: 'private_key_jwt' },
    });
    assert.equal(refreshed.error, 'RefreshAccessTokenError');
    assert.equal(subrite.calls.token.length, 0);
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

  it('never logs tokens from an unexpected token response', async () => {
    const subrite = fakeSubrite({
      token: () => ok({ access_token: 'secret-access', refresh_token: 'secret-refresh' }),
    });
    const token = sessionToken();
    const refreshed = await refreshAccessToken(token, subrite.params);
    assert.equal(refreshed.error, 'RefreshAccessTokenError');
    assert.notEqual(loggedText(), '');
    assert.doesNotMatch(loggedText(), /secret-access|secret-refresh/);
    assert.doesNotMatch(loggedText(), new RegExp(token.refreshToken));
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
    const started = Date.now();
    const refreshed = await refreshAccessToken(token, { ...subrite.params, timeoutMs: 50 });
    assert.deepEqual(refreshed, token);
    assert.ok(Date.now() - started < 5000);
    assert.match(loggedText(), /TimeoutError/);
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
    const subrite = fakeSubrite({
      discoveryStatus: 500,
      token: () => ok({ access_token: 'a', expires_in: 60 }),
    });
    const token = sessionToken();
    assert.deepEqual(await refreshAccessToken(token, subrite.params), token);
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
});
