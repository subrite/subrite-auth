// How refreshAccessToken behaves when things go wrong: odd answers from Subrite or from
// something in between, slow or broken connections, old cookies and several copies of the
// library in one process.
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import * as library from '../src/index.ts';
import { generatePostSignOutUrl, refreshAccessToken } from '../src/index.ts';
import { captureConsole, fakeSubrite, ok, sessionToken } from './helpers.ts';

const loggedText = captureConsole();

afterEach(() => {
  mock.timers.reset();
});

// Lets a test move the clock forward. Only Date is faked: fetch and timeouts use real timers.
function fakeClock() {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  return (ms: number) => mock.timers.tick(ms);
}

const newTokens = () =>
  ok({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });

describe('what counts as a rejected refresh token', () => {
  const cases: Array<[string, () => Response, 'rejected' | 'temporary']> = [
    [
      '400 invalid_grant',
      () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
      'rejected',
    ],
    [
      '400 unauthorized_client',
      () => Response.json({ error: 'unauthorized_client' }, { status: 400 }),
      'rejected',
    ],
    [
      '401 invalid_client (wrong client secret)',
      () => Response.json({ error: 'invalid_client' }, { status: 401 }),
      'temporary',
    ],
    [
      '403 HTML page from a firewall',
      () => new Response('<html>Forbidden</html>', { status: 403 }),
      'temporary',
    ],
    [
      '404 without a body (deploy in progress)',
      () => new Response(null, { status: 404 }),
      'temporary',
    ],
    [
      '408 request timeout',
      () => Response.json({ error: 'timeout' }, { status: 408 }),
      'temporary',
    ],
    [
      '429 too many requests',
      () => Response.json({ error: 'slow_down' }, { status: 429 }),
      'temporary',
    ],
    ['502 bad gateway', () => new Response('bad gateway', { status: 502 }), 'temporary'],
  ];

  for (const [name, respond, expected] of cases) {
    it(`${name} is ${expected}`, async () => {
      const subrite = fakeSubrite({ token: respond });
      const token = sessionToken();
      const refreshed = await refreshAccessToken(token, subrite.params);
      if (expected === 'rejected') {
        assert.equal(refreshed.error, 'RefreshAccessTokenError');
        assert.equal(refreshed.refreshToken, '');
      } else {
        assert.deepEqual(refreshed, token);
      }
    });
  }

  it('explains invalid_client in the log', async () => {
    const subrite = fakeSubrite({
      token: () => Response.json({ error: 'invalid_client' }, { status: 401 }),
    });
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.match(loggedText(), /client id or secret/);
  });
});

describe('broken responses', () => {
  it('treats a 200 whose body breaks off as temporary', async () => {
    const subrite = fakeSubrite({
      token: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"access_token":"secret-acc'));
              controller.error(new Error('connection reset'));
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const token = sessionToken();
    assert.deepEqual(await refreshAccessToken(token, subrite.params), token);
    assert.match(loggedText(), /could not read the token response/);
    assert.doesNotMatch(loggedText(), /secret-acc/);
  });

  it('never follows redirects', async () => {
    const subrite = fakeSubrite({ token: newTokens });
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.deepEqual(subrite.calls.redirects, ['error', 'error']);
  });

  it('does not cache an OpenID configuration without token_endpoint', async () => {
    const subrite = fakeSubrite({ discovery: { token_endpoint: null }, token: newTokens });
    const token = sessionToken();
    assert.deepEqual(await refreshAccessToken(token, subrite.params), token);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.discovery, 2);
    assert.equal(subrite.calls.token.length, 0);
    assert.match(loggedText(), /no token_endpoint/);
  });
});

describe('old cookies and retries', () => {
  it('answers an old cookie from memory until the new access token is about to expire', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: newTokens });
    // A request that can't save its cookie, like an App Router Server Component, refreshes.
    // The browser keeps sending the old cookie.
    const oldCookie = sessionToken();
    await refreshAccessToken(oldCookie, subrite.params);

    tick(30 * 60 * 1000);
    const later = await refreshAccessToken(oldCookie, subrite.params);
    assert.equal(later.accessToken, 'new-access');
    assert.equal(later.refreshToken, 'new-refresh');
    assert.equal(subrite.calls.token.length, 1, 'the used refresh token is not sent again');

    // Close to expiry (3600 s minus the 60 s margin) the entry ends.
    tick(29 * 60 * 1000 + 1);
    await refreshAccessToken(oldCookie, subrite.params);
    assert.equal(subrite.calls.token.length, 2);
  });

  it('remembers a rejected refresh token for an hour', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({
      token: () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    });
    // An old cookie, saved before the token was flagged, keeps arriving.
    const oldCookie = sessionToken();
    await refreshAccessToken(oldCookie, subrite.params);
    tick(59 * 60 * 1000);
    const again = await refreshAccessToken(oldCookie, subrite.params);
    assert.equal(again.error, 'RefreshAccessTokenError');
    assert.equal(subrite.calls.token.length, 1);
  });

  it('waits longer after each temporary failure in a row', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: () => new Response('down', { status: 503 }) });
    const token = sessionToken();
    const attempts = () => subrite.calls.token.length;

    await refreshAccessToken(token, subrite.params);
    assert.equal(attempts(), 1);

    tick(10_000);
    await refreshAccessToken(token, subrite.params);
    assert.equal(attempts(), 2, 'tries again after 10 s');

    tick(10_000);
    await refreshAccessToken(token, subrite.params);
    assert.equal(attempts(), 2, 'now waits 20 s');

    tick(10_000);
    await refreshAccessToken(token, subrite.params);
    assert.equal(attempts(), 3);

    tick(39_999);
    await refreshAccessToken(token, subrite.params);
    assert.equal(attempts(), 3, 'now waits 40 s');
  });

  it('starts the wait over after a success', async () => {
    const tick = fakeClock();
    let down = true;
    const subrite = fakeSubrite({
      token: () => (down ? new Response('down', { status: 503 }) : newTokens()),
    });
    const token = sessionToken();
    await refreshAccessToken(token, subrite.params);
    tick(10_000);
    down = false;
    const refreshed = await refreshAccessToken(token, subrite.params);
    assert.equal(refreshed.accessToken, 'new-access');
    assert.equal(subrite.calls.token.length, 2);
  });
});

describe('several copies of the library in one process', () => {
  it('share one refresh, like the Pages Router and App Router copies in Next.js', async () => {
    // A query string makes Node load a second, separate copy of the module.
    const specifier = '../src/index.ts?second-copy';
    const copy = (await import(specifier)) as typeof library;
    assert.notEqual(copy.refreshAccessToken, library.refreshAccessToken);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const subrite = fakeSubrite({
      token: async () => {
        await gate;
        return newTokens();
      },
    });
    const token = sessionToken();
    const pending = [
      library.refreshAccessToken({ ...token }, subrite.params),
      copy.refreshAccessToken({ ...token }, subrite.params),
    ];
    release();
    const results = await Promise.all(pending);
    assert.equal(subrite.calls.token.length, 1);
    assert.equal(subrite.calls.discovery, 1);
    for (const result of results) {
      assert.equal(result.refreshToken, 'new-refresh');
    }
  });
});

describe('generatePostSignOutUrl options', () => {
  it('adds state and id_token_hint when given', () => {
    const url = new URL(
      generatePostSignOutUrl('https://auth.example.com', 'id', 'https://app.example.com/logout', {
        state: 'random-state',
        idTokenHint: 'id-token',
      }),
    );
    assert.equal(url.searchParams.get('state'), 'random-state');
    assert.equal(url.searchParams.get('id_token_hint'), 'id-token');
  });

  it('leaves them out by default', () => {
    const url = new URL(generatePostSignOutUrl('https://auth.example.com', 'id', 'https://a.b'));
    assert.equal(url.searchParams.has('state'), false);
    assert.equal(url.searchParams.has('id_token_hint'), false);
  });
});
