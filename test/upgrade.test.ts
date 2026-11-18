// Apps that update from 0.2.1 keep their users' session cookies and often their old NextAuth
// callbacks. These tests make sure both keep working with this version.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as api from '../src/index.ts';
import Subrite, {
  isAccessTokenExpired,
  refreshAccessToken,
  toSubriteJWT,
  type SubriteJWT,
} from '../src/index.ts';
import { captureConsole, fakeSubrite, ok, unique } from './helpers.ts';

captureConsole();

type Token = Record<string, unknown> & SubriteJWT;

// The JWT payload 0.2.1 apps store in the session cookie, when set up as its README said.
// The tokens are also copied into `user`, because 0.2.1 returned them from `profile()`.
function sessionFrom021(overrides: Partial<Token> = {}): Token {
  const accessToken = unique('access');
  const refreshToken = unique('refresh');
  const accessTokenExpires = Date.now() - 1000;
  return {
    name: 'Ada',
    email: 'ada@example.com',
    picture: 'ada.png',
    sub: 'user-1',
    accessToken,
    refreshToken,
    accessTokenExpires,
    user: {
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      image: 'ada.png',
      accessToken,
      refreshToken,
      accessTokenExpires,
    },
    iat: 1_700_000_000,
    exp: 1_702_592_000,
    jti: 'jti-1',
    ...overrides,
  };
}

const newTokens = () =>
  ok({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });

describe('upgrading from 0.2.1', () => {
  it('keeps every export from 0.2.1', () => {
    for (const name of [
      'default',
      'toSubriteJWT',
      'refreshAccessToken',
      'generatePostSignOutUrl',
    ]) {
      assert.equal(typeof api[name as keyof typeof api], 'function', name);
    }
  });

  it('refreshes a session cookie written by 0.2.1 and keeps its other fields', async () => {
    const subrite = fakeSubrite({ token: newTokens });
    const token = sessionFrom021();
    const refreshed = await refreshAccessToken(token, subrite.params);

    assert.equal(subrite.calls.token[0].form.get('refresh_token'), token.refreshToken);
    assert.equal(refreshed.accessToken, 'new-access');
    assert.equal(refreshed.refreshToken, 'new-refresh');
    assert.equal('error' in refreshed, false);
    for (const key of ['name', 'email', 'picture', 'sub', 'user', 'iat', 'exp', 'jti']) {
      assert.deepEqual(refreshed[key], token[key], key);
    }
  });

  it('recovers a 0.2.1 session that was flagged after a network blip', async () => {
    // 0.2.1 set this on any failed refresh and never removed it, even when a later refresh worked.
    const subrite = fakeSubrite({ token: newTokens });
    const token = sessionFrom021({ error: 'RefreshAccessTokenError' });
    const refreshed = await refreshAccessToken(token, subrite.params);

    assert.equal(subrite.calls.token.length, 1);
    assert.equal(refreshed.accessToken, 'new-access');
    assert.equal('error' in refreshed, false);
  });

  it('flags a 0.2.1 session whose refresh token Subrite rejects, then stops', async () => {
    const subrite = fakeSubrite({
      token: () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    });
    const token = sessionFrom021({ error: 'RefreshAccessTokenError' });
    const flagged = await refreshAccessToken(token, subrite.params);
    assert.equal(flagged.error, 'RefreshAccessTokenError');
    assert.equal(flagged.refreshToken, '');

    assert.equal(await refreshAccessToken(flagged, subrite.params), flagged);
    assert.equal(subrite.calls.token.length, 1);
  });

  it('works with the jwt callback from the 0.2.1 README', async () => {
    const subrite = fakeSubrite({ token: newTokens });
    const subriteConfig = { ...subrite.params, clientId: 'client id', clientSecret: 's3cret:+' };

    // Copied from the 0.2.1 README.
    async function jwt({
      token,
      user,
      account,
    }: {
      token: Token;
      user?: unknown;
      account?: Account;
    }) {
      if (account && user) {
        // Initial sign in
        return {
          ...token,
          ...toSubriteJWT(account),
          user,
        };
      }

      // Return previous token if the access token has not expired yet
      if (Date.now() < token.accessTokenExpires) {
        return token;
      }

      return refreshAccessToken(token, subriteConfig);
    }

    await signInAndRefresh(subrite, jwt);
  });

  it('works with the jwt callback from the current README', async () => {
    const subrite = fakeSubrite({ token: newTokens });
    const subriteConfig = { ...subrite.params };

    async function jwt({ token, account }: { token: Token; account?: Account }) {
      if (account) {
        return { ...token, ...toSubriteJWT(account) };
      }
      if (!isAccessTokenExpired(token)) {
        return token;
      }
      return refreshAccessToken(token, subriteConfig);
    }

    await signInAndRefresh(subrite, jwt);
  });
});

type Account = { access_token: string; refresh_token: string; expires_at: number };
type JwtCallback = (params: { token: Token; user?: unknown; account?: Account }) => Promise<Token>;

// Runs a jwt callback the way NextAuth does: once on sign in, then on a later request.
async function signInAndRefresh(subrite: ReturnType<typeof fakeSubrite>, jwt: JwtCallback) {
  const provider = Subrite({
    clientId: 'client id',
    clientSecret: 's3cret:+',
    subriteUrl: subrite.subriteUrl,
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const firstRefresh = unique('first-refresh');
  const account = {
    access_token: unique('first-access'),
    refresh_token: firstRefresh,
    expires_at: nowSeconds + 30,
  };
  const user = await provider.profile?.({ sub: 'user-1', name: 'Ada' }, account);
  assert.equal(JSON.stringify(user).includes('first-'), false, 'no tokens on the user');

  const signedIn = await jwt({
    token: { name: 'Ada', sub: 'user-1' } as unknown as Token,
    user,
    account,
  });
  assert.equal(signedIn.accessToken, account.access_token);
  assert.equal(signedIn.refreshToken, firstRefresh);
  assert.equal(signedIn.accessTokenExpires, (nowSeconds + 30) * 1000);

  // A later request, once the access token has expired.
  const later = await jwt({ token: { ...signedIn, accessTokenExpires: Date.now() - 1000 } });
  assert.equal(subrite.calls.token.length, 1);
  assert.equal(subrite.calls.token[0].form.get('refresh_token'), firstRefresh);
  assert.equal(later.accessToken, 'new-access');
  assert.equal(later.refreshToken, 'new-refresh');
  assert.equal(later.name, 'Ada');
}
