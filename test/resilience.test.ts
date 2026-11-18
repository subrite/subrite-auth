// How refreshAccessToken behaves when things go wrong: odd answers from Subrite or from
// something in between, slow or broken connections, outages, old cookies and several copies of
// the library in one process.
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import * as library from '../src/index.ts';
import { generatePostSignOutUrl, refreshAccessToken, revokeRefreshToken } from '../src/index.ts';
import { captureConsole, fakeSubrite, libraryState, ok, sessionToken } from './helpers.ts';

const loggedText = captureConsole();

// Lets a test move the clock forward. Only Date is faked: fetch and timeouts use real timers.
function fakeClock() {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  return (ms: number) => mock.timers.tick(ms);
}

const MINUTE = 60_000;

// Subrite replaces the refresh token on every refresh (rotation).
let rotation = 0;
const rotatingTokens = () => {
  rotation += 1;
  return ok({
    access_token: `access-${rotation}`,
    refresh_token: `refresh-${rotation}`,
    expires_in: 3600,
  });
};
// Subrite keeps the refresh token (node-oidc-provider's default for confidential clients).
const keptTokens = () => ok({ access_token: `access-${(rotation += 1)}`, expires_in: 3600 });

const down = () => new Response('down', { status: 503 });
const rejected = () => Response.json({ error: 'invalid_grant' }, { status: 400 });

describe('what counts as a rejected refresh token', () => {
  const cases: Array<[string, () => Response, 'rejected' | 'kept']> = [
    ['400 invalid_grant', rejected, 'rejected'],
    [
      '401 invalid_grant',
      () => Response.json({ error: 'invalid_grant' }, { status: 401 }),
      'rejected',
    ],
    [
      '401 invalid_client (wrong client secret)',
      () => Response.json({ error: 'invalid_client' }, { status: 401 }),
      'kept',
    ],
    [
      '400 invalid_request (empty client secret)',
      () => Response.json({ error: 'invalid_request' }, { status: 400 }),
      'kept',
    ],
    [
      '400 unauthorized_client (grant not allowed for the client)',
      () => Response.json({ error: 'unauthorized_client' }, { status: 400 }),
      'kept',
    ],
    [
      '400 unsupported_grant_type',
      () => Response.json({ error: 'unsupported_grant_type' }, { status: 400 }),
      'kept',
    ],
    [
      '403 HTML page from a firewall',
      () => new Response('<html>Forbidden</html>', { status: 403 }),
      'kept',
    ],
    ['404 without a body (deploy in progress)', () => new Response(null, { status: 404 }), 'kept'],
    ['408 request timeout', () => Response.json({ error: 'timeout' }, { status: 408 }), 'kept'],
    ['425 too early', () => new Response(null, { status: 425 }), 'kept'],
    ['429 too many requests', () => Response.json({ error: 'slow_down' }, { status: 429 }), 'kept'],
    ['502 bad gateway', () => new Response('bad gateway', { status: 502 }), 'kept'],
  ];

  for (const [name, respond, expected] of cases) {
    it(`${name}: ${expected === 'rejected' ? 'the user must sign in again' : 'the session is kept'}`, async () => {
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

  it('points to the configuration for client errors that are not about the token', async () => {
    const subrite = fakeSubrite({
      token: () => Response.json({ error: 'invalid_client' }, { status: 401 }),
    });
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.match(loggedText(), /client configuration/);
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

  it('never follows a redirect and keeps the session', async () => {
    const subrite = fakeSubrite({
      token: () =>
        new Response(null, {
          status: 307,
          headers: { Location: 'https://elsewhere.example/steal' },
        }),
    });
    const token = sessionToken();
    assert.deepEqual(await refreshAccessToken(token, subrite.params), token);
    // 'manual' hands the 3xx back instead of following it. ('error' fails on Cloudflare Workers.)
    assert.deepEqual(subrite.calls.redirects, ['manual', 'manual']);
    assert.deepEqual(subrite.calls.unexpected, []);
    assert.match(loggedText(), /redirect was not followed/);
  });

  it('does not cache an OpenID configuration without token_endpoint', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ discovery: { token_endpoint: null }, token: rotatingTokens });
    const token = sessionToken();
    assert.deepEqual(await refreshAccessToken(token, subrite.params), token);
    tick(10_000);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.discovery, 2);
    assert.equal(subrite.calls.token.length, 0);
    assert.match(loggedText(), /no token_endpoint/);
  });

  it('logs the cause of a network error', async () => {
    const subrite = fakeSubrite({
      token: () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
            code: 'ECONNREFUSED',
          }),
        });
      },
    });
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.match(loggedText(), /fetch failed \(ECONNREFUSED: connect ECONNREFUSED/);
  });

  it('lets each caller keep its own timeout while the OpenID configuration loads', async () => {
    let releaseDiscovery: () => void = () => {};
    const discoveryGate = new Promise<void>((resolve) => (releaseDiscovery = resolve));
    const subrite = fakeSubrite({ token: rotatingTokens });
    const fakeFetch = globalThis.fetch;
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('openid-configuration')) {
        // Like a real fetch: stop waiting when the request's own signal aborts.
        await new Promise<void>((resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          discoveryGate.then(resolve);
        });
      }
      return fakeFetch(input, init);
    });
    // The first caller gives up quickly. The second one joins the same discovery request.
    const hasty = refreshAccessToken(sessionToken(), { ...subrite.params, timeoutMs: 20 });
    const patient = refreshAccessToken(sessionToken(), { ...subrite.params, timeoutMs: 5000 });
    const keepAlive = setTimeout(() => {}, 5000);
    try {
      await hasty;
      releaseDiscovery();
      assert.match((await patient).accessToken, /^access-/);
      assert.equal(subrite.calls.discovery, 1);
    } finally {
      clearTimeout(keepAlive);
    }
  });
});

describe('old cookies', () => {
  it('when the refresh token was replaced: answers from memory until the new access token is about to expire', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: rotatingTokens });
    // A Server Component refreshes but can't save the cookie. The browser keeps the old one.
    const oldCookie = sessionToken();
    const first = await refreshAccessToken(oldCookie, subrite.params);

    tick(59 * MINUTE - 1);
    const late = await refreshAccessToken(oldCookie, subrite.params);
    assert.equal(late.accessToken, first.accessToken);
    assert.equal(late.refreshToken, first.refreshToken);
    assert.equal(subrite.calls.token.length, 1, 'the replaced refresh token is not sent again');

    // 3600 s minus the 60 s margin.
    tick(1);
    await refreshAccessToken(oldCookie, subrite.params);
    assert.equal(subrite.calls.token.length, 2);
  });

  it('logs once when an old cookie is answered from memory long after the refresh', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: rotatingTokens });
    const oldCookie = sessionToken();
    await refreshAccessToken(oldCookie, subrite.params);
    tick(10_000);
    await refreshAccessToken(oldCookie, subrite.params);
    assert.doesNotMatch(loggedText(), /got the new tokens from memory/, 'not within 30 s');
    tick(5 * MINUTE);
    await refreshAccessToken(oldCookie, subrite.params);
    await refreshAccessToken(oldCookie, subrite.params);
    assert.equal(loggedText().match(/got the new tokens from memory/g)?.length, 1);
    assert.doesNotMatch(loggedText(), new RegExp(oldCookie.refreshToken));
  });

  it('respects a shorter oldCookieGraceSeconds', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: rotatingTokens });
    const params = { ...subrite.params, oldCookieGraceSeconds: 45 };
    const oldCookie = sessionToken();
    await refreshAccessToken(oldCookie, params);
    tick(44_999);
    await refreshAccessToken(oldCookie, params);
    assert.equal(subrite.calls.token.length, 1);
    tick(1);
    await refreshAccessToken(oldCookie, params);
    assert.equal(subrite.calls.token.length, 2, 'sent to Subrite, whose reuse detection decides');
  });

  it('never goes below 30 s, so requests that arrive together share the refresh', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: rotatingTokens });
    const params = { ...subrite.params, oldCookieGraceSeconds: 0 };
    const oldCookie = sessionToken();
    await refreshAccessToken(oldCookie, params);
    tick(29_999);
    await refreshAccessToken(oldCookie, params);
    assert.equal(subrite.calls.token.length, 1);
  });

  it('when the refresh token was kept: asks Subrite again after 30 s', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: keptTokens });
    const token = sessionToken();
    const first = await refreshAccessToken(token, subrite.params);
    assert.equal(first.refreshToken, token.refreshToken);

    tick(29_999);
    assert.equal((await refreshAccessToken(token, subrite.params)).accessToken, first.accessToken);
    assert.equal(subrite.calls.token.length, 1);

    // A forced refresh (for example after a purchase) or a revocation reaches Subrite.
    tick(1);
    const second = await refreshAccessToken(token, subrite.params);
    assert.equal(subrite.calls.token.length, 2);
    assert.notEqual(second.accessToken, first.accessToken);
  });

  it('never hands out an access token that has already expired', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: () => ok({ access_token: unique(), expires_in: 10 }) });
    const token = sessionToken();
    await refreshAccessToken(token, subrite.params);
    tick(10_000);
    await refreshAccessToken(token, subrite.params);
    assert.equal(subrite.calls.token.length, 2);
  });

  it('remembers a rejected refresh token for an hour, then asks again', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: rejected });
    const oldCookie = sessionToken();
    await refreshAccessToken(oldCookie, subrite.params);
    tick(60 * MINUTE - 1);
    assert.equal(
      (await refreshAccessToken(oldCookie, subrite.params)).error,
      'RefreshAccessTokenError',
    );
    assert.equal(subrite.calls.token.length, 1);
    tick(1);
    await refreshAccessToken(oldCookie, subrite.params);
    assert.equal(subrite.calls.token.length, 2);
  });
});

let uniqueCounter = 0;
function unique(): string {
  uniqueCounter += 1;
  return `value-${uniqueCounter}`;
}

describe('outages', () => {
  it('pauses refreshes for every session of the client, not just the one that failed', async () => {
    const tick = fakeClock();
    let isDown = true;
    const subrite = fakeSubrite({ token: () => (isDown ? down() : rotatingTokens()) });

    await refreshAccessToken(sessionToken(), subrite.params);
    // Other users within the pause keep their tokens and don't reach Subrite.
    for (let i = 0; i < 20; i += 1) {
      const token = sessionToken();
      assert.deepEqual(await refreshAccessToken(token, subrite.params), token);
    }
    assert.equal(subrite.calls.token.length, 1);

    tick(10_000);
    isDown = false;
    assert.match(
      (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
      /^access-/,
    );
    assert.equal(subrite.calls.token.length, 2);
    // Back up: no pause any more.
    assert.match(
      (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
      /^access-/,
    );
    assert.equal(subrite.calls.token.length, 3);
  });

  it('lets one request check whether Subrite is back while the others wait', async () => {
    const tick = fakeClock();
    let release: () => void = () => {};
    let gate: Promise<void> = Promise.resolve();
    const subrite = fakeSubrite({
      token: async () => {
        await gate;
        return down();
      },
    });
    await refreshAccessToken(sessionToken(), subrite.params);
    tick(10_000);
    gate = new Promise<void>((resolve) => (release = resolve));
    const probe = refreshAccessToken(sessionToken(), subrite.params);
    const others = [1, 2, 3].map(() => refreshAccessToken(sessionToken(), subrite.params));
    await Promise.all(others);
    release();
    await probe;
    assert.equal(subrite.calls.token.length, 2);
  });

  it('doubles the pause up to 5 minutes', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: down });
    const expectedPauses = [10, 20, 40, 80, 160, 300, 300].map((seconds) => seconds * 1000);
    await refreshAccessToken(sessionToken(), subrite.params);
    for (const [index, pause] of expectedPauses.entries()) {
      tick(pause - 1);
      await refreshAccessToken(sessionToken(), subrite.params);
      assert.equal(
        subrite.calls.token.length,
        index + 1,
        `still paused after failure ${index + 1}`,
      );
      tick(1);
      await refreshAccessToken(sessionToken(), subrite.params);
      assert.equal(subrite.calls.token.length, index + 2, `tries again after ${pause / 1000} s`);
    }
  });

  it('starts over with 10 s after a success', async () => {
    const tick = fakeClock();
    let isDown = true;
    const subrite = fakeSubrite({ token: () => (isDown ? down() : rotatingTokens()) });
    await refreshAccessToken(sessionToken(), subrite.params);
    tick(10_000);
    await refreshAccessToken(sessionToken(), subrite.params); // second failure: 20 s
    tick(20_000);
    isDown = false;
    await refreshAccessToken(sessionToken(), subrite.params);
    isDown = true;
    await refreshAccessToken(sessionToken(), subrite.params);
    tick(10_000);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.token.length, 5);
  });

  it('forgets old failures after 15 minutes', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: down });
    await refreshAccessToken(sessionToken(), subrite.params);
    tick(10_000);
    await refreshAccessToken(sessionToken(), subrite.params); // second failure in a row
    tick(16 * MINUTE);
    await refreshAccessToken(sessionToken(), subrite.params); // a new first failure: 10 s
    tick(10_000);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.token.length, 4);
  });

  it('follows Retry-After, in seconds or as a date', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({
      token: () => new Response(null, { status: 503, headers: { 'Retry-After': '120' } }),
    });
    await refreshAccessToken(sessionToken(), subrite.params);
    tick(119_999);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.token.length, 1);
    tick(1);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.token.length, 2);

    const dated = fakeSubrite({
      token: () =>
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': new Date(Date.now() + 60_000).toUTCString() },
        }),
    });
    await refreshAccessToken(sessionToken(), dated.params);
    tick(59_000);
    await refreshAccessToken(sessionToken(), dated.params);
    assert.equal(dated.calls.token.length, 1);
    tick(1_000);
    await refreshAccessToken(sessionToken(), dated.params);
    assert.equal(dated.calls.token.length, 2);
  });

  it('keeps sessions of other Subrite clients going', async () => {
    const broken = fakeSubrite({ token: down });
    const working = fakeSubrite({ token: rotatingTokens });
    await refreshAccessToken(sessionToken(), broken.params);
    assert.match(
      (await refreshAccessToken(sessionToken(), working.params)).accessToken,
      /^access-/,
    );
  });
});

describe('outages caused by one account or one moment', () => {
  it('a refresh token that keeps failing does not hold up other users', async () => {
    const tick = fakeClock();
    const broken = sessionToken();
    const subrite = fakeSubrite({
      token: ({ form }) =>
        form.get('refresh_token') === broken.refreshToken
          ? new Response('server error', { status: 500 })
          : rotatingTokens(),
    });
    // The first failure could be an outage, so the client pauses once.
    await refreshAccessToken(broken, subrite.params);
    tick(10_000);
    // The same token fails again: only that token waits longer. Everyone else carries on.
    await refreshAccessToken(broken, subrite.params);
    for (let i = 0; i < 5; i += 1) {
      assert.match(
        (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
        /^access-/,
      );
    }
    // The broken token itself now waits 20 s.
    tick(19_999);
    await refreshAccessToken(broken, subrite.params);
    const brokenAttempts = () =>
      subrite.calls.token.filter((r) => r.form.get('refresh_token') === broken.refreshToken).length;
    assert.equal(brokenAttempts(), 2);
    tick(1);
    await refreshAccessToken(broken, subrite.params);
    assert.equal(brokenAttempts(), 3);
    assert.match(
      (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
      /^access-/,
    );
  });

  it('counts requests that failed together as one failure, so the pause stays at 10 s', async () => {
    const tick = fakeClock();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let isDown = true;
    const subrite = fakeSubrite({
      token: async () => {
        if (!isDown) return rotatingTokens();
        await gate;
        return new Response('bad gateway', { status: 502 });
      },
    });
    const inFlight = [1, 2, 3, 4, 5, 6].map(() =>
      refreshAccessToken(sessionToken(), subrite.params),
    );
    release();
    await Promise.all(inFlight);
    tick(10_000);
    isDown = false;
    assert.match(
      (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
      /^access-/,
    );
  });

  it('keeps others waiting until the probe answers, even if a failing token answers first', async () => {
    const tick = fakeClock();
    const broken = sessionToken();
    let releaseBroken: () => void = () => {};
    let brokenGate: Promise<void> = Promise.resolve();
    let releaseProbe: () => void = () => {};
    let probeGate: Promise<void> | undefined = undefined;
    let isDown = false;
    const subrite = fakeSubrite({
      token: async ({ form }) => {
        if (form.get('refresh_token') === broken.refreshToken) {
          await brokenGate;
          return new Response('server error', { status: 500 });
        }
        if (probeGate) {
          await probeGate;
          return rotatingTokens();
        }
        return isDown ? down() : rotatingTokens();
      },
    });
    // The broken token fails once, then Subrite answers others again.
    await refreshAccessToken(broken, subrite.params);
    tick(10_000);
    await refreshAccessToken(sessionToken(), subrite.params);
    // The broken token tries again (slowly) while the client is healthy.
    brokenGate = new Promise<void>((resolve) => (releaseBroken = resolve));
    const brokenAgain = refreshAccessToken(broken, subrite.params);
    // Now an outage begins, and after the pause a probe starts.
    isDown = true;
    await refreshAccessToken(sessionToken(), subrite.params);
    tick(10_000);
    probeGate = new Promise<void>((resolve) => (releaseProbe = resolve));
    const probe = refreshAccessToken(sessionToken(), subrite.params);
    // The broken token's answer arrives first. It must not let everyone through.
    releaseBroken();
    await brokenAgain;
    const callsBefore = subrite.calls.token.length;
    const waiting = sessionToken();
    assert.deepEqual(await refreshAccessToken(waiting, subrite.params), waiting);
    assert.equal(subrite.calls.token.length, callsBefore, 'still waiting for the probe');
    releaseProbe();
    assert.match((await probe).accessToken, /^access-/);
  });

  it('forgets an outage that ended long ago', async () => {
    const tick = fakeClock();
    let isDown = true;
    let release: () => void = () => {};
    let gate: Promise<void> = Promise.resolve();
    const subrite = fakeSubrite({
      token: async () => {
        await gate;
        return isDown ? down() : rotatingTokens();
      },
    });
    await refreshAccessToken(sessionToken(), subrite.params);
    isDown = false;
    tick(3 * 60 * MINUTE);
    // Two users refresh at the same time. Neither has to wait for the other.
    gate = new Promise<void>((resolve) => (release = resolve));
    const both = [
      refreshAccessToken(sessionToken(), subrite.params),
      refreshAccessToken(sessionToken(), subrite.params),
    ];
    release();
    for (const result of await Promise.all(both)) {
      assert.match(result.accessToken, /^access-/);
    }
  });

  it('a clock that goes backwards ends a pause instead of stretching it', async () => {
    const start = Date.now();
    mock.timers.enable({ apis: ['Date'], now: start });
    let isDown = true;
    const subrite = fakeSubrite({ token: () => (isDown ? down() : rotatingTokens()) });
    await refreshAccessToken(sessionToken(), subrite.params);
    isDown = false;
    // NTP sets the clock an hour back. Without care, the pause would last another hour.
    mock.timers.setTime(start - 60 * MINUTE);
    assert.match(
      (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
      /^access-/,
    );
  });
});

describe('reuse never hands out an expired access token', () => {
  it('ignores an oldCookieGraceSeconds longer than the access token lifetime', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({
      token: () => {
        rotation += 1;
        return ok({
          access_token: `access-${rotation}`,
          refresh_token: `refresh-${rotation}`,
          expires_in: 300,
        });
      },
    });
    const params = { ...subrite.params, oldCookieGraceSeconds: 3600 };
    const oldCookie = sessionToken();
    await refreshAccessToken(oldCookie, params);
    // The default window ends 60 s before the 300 s access token expires. A longer grace changes
    // nothing.
    tick(240_000);
    const later = await refreshAccessToken(oldCookie, params);
    assert.equal(subrite.calls.token.length, 2);
    assert.ok(later.accessTokenExpires > Date.now());
  });

  it('caps the reuse of a short-lived rotated access token at its expiry', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({
      token: () => {
        rotation += 1;
        return ok({
          access_token: `access-${rotation}`,
          refresh_token: `refresh-${rotation}`,
          expires_in: 10,
        });
      },
    });
    const oldCookie = sessionToken();
    await refreshAccessToken(oldCookie, subrite.params);
    tick(10_000);
    await refreshAccessToken(oldCookie, subrite.params);
    assert.equal(subrite.calls.token.length, 2);
  });

  it('falls back to the default and logs once for an oldCookieGraceSeconds that is not a number', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: rotatingTokens });
    const params = { ...subrite.params, oldCookieGraceSeconds: Number(undefined) };
    const oldCookie = sessionToken();
    await refreshAccessToken(oldCookie, params);
    tick(10 * MINUTE);
    await refreshAccessToken(oldCookie, params);
    await refreshAccessToken(sessionToken(), params);
    assert.equal(subrite.calls.token.length, 2, 'the old cookie was answered from memory');
    assert.ok((loggedText().match(/oldCookieGraceSeconds must be a number/g)?.length ?? 0) <= 1);
  });
});

describe('revokeRefreshToken', () => {
  it('revokes the refresh token at Subrite with the client credentials', async () => {
    const subrite = fakeSubrite({ token: rotatingTokens });
    const token = sessionToken();
    assert.equal(await revokeRefreshToken(token, subrite.params), true);
    const [request] = subrite.calls.revocation;
    assert.equal(request.form.get('token'), token.refreshToken);
    assert.equal(request.form.get('token_type_hint'), 'refresh_token');
    assert.equal(request.headers.get('authorization'), `Basic ${btoa('client+id:s3cret%3A%2B')}`);
  });

  it('stops answering old cookies from memory', async () => {
    const subrite = fakeSubrite({ token: rotatingTokens });
    const oldCookie = sessionToken();
    const refreshed = await refreshAccessToken(oldCookie, subrite.params);
    await revokeRefreshToken(refreshed, subrite.params);

    for (const cookie of [oldCookie, refreshed]) {
      const after = await refreshAccessToken({ ...cookie, accessTokenExpires: 0 }, subrite.params);
      assert.equal(after.error, 'RefreshAccessTokenError');
    }
    assert.equal(subrite.calls.token.length, 1, 'nothing more is sent to Subrite');
  });

  it('returns false and never throws when Subrite fails or has no revocation endpoint', async () => {
    const failing = fakeSubrite({ token: rotatingTokens, revocation: () => down() });
    assert.equal(await revokeRefreshToken(sessionToken(), failing.params), false);

    const without = fakeSubrite({
      token: rotatingTokens,
      discovery: { revocation_endpoint: null },
    });
    assert.equal(await revokeRefreshToken(sessionToken(), without.params), false);
    assert.match(loggedText(), /no revocation_endpoint/);

    assert.equal(await revokeRefreshToken({ refreshToken: '' }, failing.params), false);
  });
});

describe('cache size', () => {
  it('never drops a refresh that is still in progress', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const subrite = fakeSubrite({
      token: async () => {
        await gate;
        return rotatingTokens();
      },
    });
    const token = sessionToken();
    const inFlight = refreshAccessToken(token, subrite.params);

    // Fill the cache past its limit with finished refreshes.
    const { refreshes } = libraryState();
    const finished = Promise.resolve({ kind: 'temporary-failure' });
    for (let i = 0; i < 10_000; i += 1) {
      refreshes.set(`filler-${i}`, {
        outcome: finished,
        settled: { kind: 'temporary-failure' },
        sentRefreshToken: `filler-${i}`,
        reuseUntil: Number.POSITIVE_INFINITY,
        keepUntil: Number.POSITIVE_INFINITY,
      });
    }
    // Another refresh makes the cache prune. The one in progress must stay.
    const other = fakeSubrite({ token: rotatingTokens });
    await refreshAccessToken(sessionToken(), other.params);
    assert.ok(refreshes.size <= 10_000);

    const again = refreshAccessToken({ ...token }, subrite.params);
    release();
    await Promise.all([inFlight, again]);
    assert.equal(subrite.calls.token.length, 1, 'the refresh token was sent once');
  });
});

describe('clock changes', () => {
  it('still prunes the cache after the clock went backwards', async () => {
    const start = Date.now();
    mock.timers.enable({ apis: ['Date'], now: start + 60 * MINUTE });
    const subrite = fakeSubrite({ token: rotatingTokens });
    await refreshAccessToken(sessionToken(), subrite.params);
    // The server clock is corrected an hour back (for example by NTP).
    mock.timers.setTime(start);
    const { refreshes } = libraryState();
    refreshes.set('finished-long-ago', {
      outcome: Promise.resolve({ kind: 'temporary-failure' }),
      settled: { kind: 'temporary-failure' },
      sentRefreshToken: 'old',
      reuseUntil: start - 1,
      keepUntil: start - 1,
    });
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(refreshes.has('finished-long-ago'), false);
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
        return rotatingTokens();
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
    assert.equal(results[0].refreshToken, results[1].refreshToken);
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
