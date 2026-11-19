// How refreshAccessToken behaves when things go wrong: odd answers from Subrite or from
// something in between, slow or broken connections, outages, old cookies and several copies of
// the library in one process.
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import * as library from '../src/index.ts';
import {
  generatePostSignOutUrl,
  refreshAccessToken,
  revokeRefreshToken,
  type RefreshParams,
} from '../src/index.ts';
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

  it('does not blame the configuration for load or server errors', async () => {
    for (const respond of [
      () => Response.json({ error: 'slow_down' }, { status: 429 }),
      () => Response.json({ error: 'server_error' }, { status: 500 }),
    ]) {
      const subrite = fakeSubrite({ token: respond });
      await refreshAccessToken(sessionToken(), subrite.params);
    }
    assert.doesNotMatch(loggedText(), /client configuration/);
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
  const failsFor = (tokens: Array<{ refreshToken: string }>) => {
    const broken = new Set(tokens.map((token) => token.refreshToken));
    return ({ form }: { form: URLSearchParams }) =>
      broken.has(form.get('refresh_token') ?? '')
        ? new Response('server error', { status: 500 })
        : rotatingTokens();
  };
  // Three different refresh tokens failing for the first time start an outage.
  const startOutage = async (
    params: RefreshParams,
    tokens = [1, 2, 3].map(() => sessionToken()),
  ) => {
    for (const token of tokens) await refreshAccessToken(token, params);
    return tokens;
  };

  it('one or two refresh tokens failing pause nobody else', async () => {
    fakeClock();
    const broken = [sessionToken(), sessionToken()];
    const subrite = fakeSubrite({ token: failsFor(broken) });
    for (const token of broken) await refreshAccessToken(token, subrite.params);
    for (let i = 0; i < 5; i += 1) {
      assert.match(
        (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
        /^access-/,
      );
    }
    assert.equal(subrite.calls.token.length, 7);
  });

  it('server errors that Subrite answers for single accounts never pause anyone else', async () => {
    const tick = fakeClock();
    const broken = [1, 2, 3, 4, 5, 6].map(() => sessionToken());
    const brokenTokens = new Set(broken.map((token) => token.refreshToken));
    // What node-oidc-provider answers when one account's data breaks the refresh.
    const subrite = fakeSubrite({
      token: ({ form }) =>
        brokenTokens.has(form.get('refresh_token') ?? '')
          ? Response.json({ error: 'server_error' }, { status: 500 })
          : rotatingTokens(),
    });
    for (let second = 0; second < 60; second += 1) {
      for (const token of broken) await refreshAccessToken(token, subrite.params);
      const healthy = sessionToken();
      assert.match((await refreshAccessToken(healthy, subrite.params)).accessToken, /^access-/);
      tick(1000);
    }
    // Each broken account still backs off on its own: 10 s, 20 s, 40 s.
    const attempts = subrite.calls.token.filter((r) =>
      brokenTokens.has(r.form.get('refresh_token') ?? ''),
    ).length;
    assert.equal(attempts, broken.length * 3);
  });

  it('a 503 still counts towards an outage, even with an OAuth error code', async () => {
    fakeClock();
    const subrite = fakeSubrite({
      token: () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }),
    });
    await startOutage(subrite.params);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.token.length, 3, 'paused after three failing refresh tokens');
  });

  it('a refresh token that keeps failing waits longer each time, on its own, up to 5 minutes', async () => {
    const tick = fakeClock();
    const broken = sessionToken();
    const subrite = fakeSubrite({ token: failsFor([broken]) });
    const attempts = () =>
      subrite.calls.token.filter((r) => r.form.get('refresh_token') === broken.refreshToken).length;
    await refreshAccessToken(broken, subrite.params);
    for (const [index, wait] of [10, 20, 40, 80, 160, 300, 300].entries()) {
      tick(wait * 1000 - 1);
      await refreshAccessToken(broken, subrite.params);
      assert.equal(attempts(), index + 1, `still waiting after failure ${index + 1}`);
      tick(1);
      await refreshAccessToken(broken, subrite.params);
      assert.equal(attempts(), index + 2, `tries again after ${wait} s`);
      assert.match(
        (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
        /^access-/,
      );
    }
  });

  it('three different refresh tokens failing pause everyone, then one request checks at a time', async () => {
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
    await startOutage(subrite.params);
    for (let i = 0; i < 5; i += 1) {
      const token = sessionToken();
      assert.deepEqual(await refreshAccessToken(token, subrite.params), token);
    }
    assert.equal(subrite.calls.token.length, 3, 'nobody else reaches Subrite during the pause');

    tick(10_000);
    isDown = false;
    gate = new Promise<void>((resolve) => (release = resolve));
    const probe = refreshAccessToken(sessionToken(), subrite.params);
    const waiting = sessionToken();
    assert.deepEqual(await refreshAccessToken(waiting, subrite.params), waiting);
    release();
    assert.match((await probe).accessToken, /^access-/);
    assert.match(
      (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
      /^access-/,
    );
    assert.equal(subrite.calls.token.length, 5);
  });

  it('counts requests that fail at the same moment as one step, so the pause stays at 10 s', async () => {
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

  it('waits longer only when a refresh token that had not failed yet fails', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: down });
    const [first, second] = await startOutage(subrite.params); // 10 s
    tick(10_000);
    await refreshAccessToken(sessionToken(), subrite.params); // a new token fails: 20 s
    tick(19_999);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.token.length, 4);
    tick(1);
    // `first` already failed in this outage. Its failure is no news: the pause doesn't grow,
    // and only tokens that already failed wait again.
    await refreshAccessToken(first, subrite.params);
    assert.equal(subrite.calls.token.length, 5);
    await refreshAccessToken(second, subrite.params);
    assert.equal(subrite.calls.token.length, 5, 'tokens that already failed wait 20 s again');
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.token.length, 6, 'a token that has not failed may still check');
    tick(40_000);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.token.length, 7, 'that failure was news: 40 s');
  });

  it('doubles the pause for everyone up to a minute while new refresh tokens keep failing', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: down });
    await startOutage(subrite.params);
    let expected = 3;
    for (const pause of [10, 20, 40, 60, 60, 60]) {
      tick(pause * 1000 - 1);
      await refreshAccessToken(sessionToken(), subrite.params);
      assert.equal(subrite.calls.token.length, expected, `still paused within ${pause} s`);
      tick(1);
      await refreshAccessToken(sessionToken(), subrite.params);
      expected += 1;
      assert.equal(subrite.calls.token.length, expected, `one probe after ${pause} s`);
    }
  });

  it('lets every user refresh as soon as a check finds Subrite back', async () => {
    const tick = fakeClock();
    let isDown = true;
    const subrite = fakeSubrite({ token: () => (isDown ? down() : rotatingTokens()) });
    const users = await startOutage(subrite.params);
    // The outage goes on. The users who check fail again, and their own waits grow.
    tick(10_000);
    await refreshAccessToken(users[0], subrite.params);
    tick(10_000);
    await refreshAccessToken(users[1], subrite.params); // its own next try: in 20 s
    isDown = false;
    tick(10_000);
    assert.match((await refreshAccessToken(users[2], subrite.params)).accessToken, /^access-/);
    // The others don't sit out their own waits: the failures were Subrite's, not theirs.
    for (const user of users.slice(0, 2)) {
      assert.match((await refreshAccessToken(user, subrite.params)).accessToken, /^access-/);
    }
  });

  it('forgives the failures that started an outage as soon as any request gets an answer', async () => {
    const tick = fakeClock();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = sessionToken();
    let isDown = true;
    const subrite = fakeSubrite({
      token: async ({ form }) => {
        if (form.get('refresh_token') === slow.refreshToken) {
          await gate;
          return rotatingTokens();
        }
        return isDown ? down() : rotatingTokens();
      },
    });
    const slowRefresh = refreshAccessToken(slow, subrite.params); // already on its way
    const users = await startOutage(subrite.params);
    tick(1000);
    isDown = false;
    release();
    await slowRefresh; // Subrite answered: the outage is over
    // The users who started the outage would wait 10 s on their own, but they are forgiven.
    for (const user of users) {
      assert.match((await refreshAccessToken(user, subrite.params)).accessToken, /^access-/);
    }
  });

  it('goes fully back to normal once Subrite answers', async () => {
    const tick = fakeClock();
    let isDown = true;
    const broken = [sessionToken(), sessionToken(), sessionToken()];
    const brokenTokens = new Set(broken.map((b) => b.refreshToken));
    const subrite = fakeSubrite({
      token: ({ form }) =>
        isDown || brokenTokens.has(form.get('refresh_token') ?? '') ? down() : rotatingTokens(),
    });
    await startOutage(subrite.params);
    tick(10_000);
    isDown = false;
    assert.match(
      (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
      /^access-/,
    );
    // Back to normal: refresh tokens failing on their own pause nobody.
    for (const token of broken.slice(0, 2)) await refreshAccessToken(token, subrite.params);
    assert.match(
      (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
      /^access-/,
    );
  });

  it('broken accounts that are forgiven and fail again do not start a new outage', async () => {
    const tick = fakeClock();
    const broken = [sessionToken(), sessionToken(), sessionToken()];
    const subrite = fakeSubrite({ token: failsFor(broken) });
    await startOutage(subrite.params, broken); // three broken accounts look like an outage
    tick(10_000);
    // A healthy user checks after the pause, gets through, and ends the outage.
    assert.match(
      (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
      /^access-/,
    );
    // The broken accounts are forgiven once, fail again, and pause nobody.
    for (const account of broken) await refreshAccessToken(account, subrite.params);
    for (let i = 0; i < 3; i += 1) {
      assert.match(
        (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
        /^access-/,
      );
    }
  });

  it('broken accounts that win every check still let healthy users through', async () => {
    const tick = fakeClock();
    const broken = [sessionToken(), sessionToken(), sessionToken(), sessionToken()];
    const subrite = fakeSubrite({ token: failsFor(broken) });
    // Three broken accounts fail first in a quiet moment: that looks like an outage.
    await startOutage(subrite.params, broken.slice(0, 3));
    // From now on every second the broken accounts ask first (one of them for the first time),
    // then a healthy user.
    const healthy = sessionToken();
    let healthyRefreshedAt: number | undefined;
    for (let second = 1; second <= 120 && healthyRefreshedAt === undefined; second += 1) {
      tick(1000);
      for (const account of broken) await refreshAccessToken(account, subrite.params);
      const result = await refreshAccessToken(healthy, subrite.params);
      if (result.accessToken !== healthy.accessToken) healthyRefreshedAt = second;
    }
    // At most the first 10 s pause, plus one 20 s pause when the fourth broken account fails for
    // the first time (which is real news). Never minutes.
    assert.ok(
      healthyRefreshedAt !== undefined && healthyRefreshedAt <= 30,
      `got ${healthyRefreshedAt}`,
    );
  });

  it('does not add up single failures far apart', async () => {
    const tick = fakeClock();
    const subrite = fakeSubrite({ token: down });
    await refreshAccessToken(sessionToken(), subrite.params);
    await refreshAccessToken(sessionToken(), subrite.params);
    tick(16 * MINUTE);
    await refreshAccessToken(sessionToken(), subrite.params);
    await refreshAccessToken(sessionToken(), subrite.params);
    assert.equal(subrite.calls.token.length, 4, 'failures 16 minutes apart are no outage');
  });

  it('follows Retry-After, in seconds or as a date', async () => {
    const tick = fakeClock();
    const retryIn120 = () => new Response(null, { status: 503, headers: { 'Retry-After': '120' } });
    // For one refresh token.
    const single = fakeSubrite({ token: retryIn120 });
    const token = sessionToken();
    await refreshAccessToken(token, single.params);
    tick(119_999);
    await refreshAccessToken(token, single.params);
    assert.equal(single.calls.token.length, 1);
    tick(1);
    await refreshAccessToken(token, single.params);
    assert.equal(single.calls.token.length, 2);

    // For the whole client during an outage, also past the usual one minute cap.
    const outage = fakeSubrite({ token: retryIn120 });
    await startOutage(outage.params);
    tick(119_999);
    await refreshAccessToken(sessionToken(), outage.params);
    assert.equal(outage.calls.token.length, 3);
    tick(1);
    await refreshAccessToken(sessionToken(), outage.params);
    assert.equal(outage.calls.token.length, 4);

    // As an HTTP date.
    const dated = fakeSubrite({
      token: () =>
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': new Date(Date.now() + 60_000).toUTCString() },
        }),
    });
    const datedToken = sessionToken();
    await refreshAccessToken(datedToken, dated.params);
    tick(59_000);
    await refreshAccessToken(datedToken, dated.params);
    assert.equal(dated.calls.token.length, 1);
    tick(1_000);
    await refreshAccessToken(datedToken, dated.params);
    assert.equal(dated.calls.token.length, 2);
  });

  it('a clock that goes backwards ends a pause instead of stretching it', async () => {
    const start = Date.now();
    mock.timers.enable({ apis: ['Date'], now: start });
    let isDown = true;
    const subrite = fakeSubrite({ token: () => (isDown ? down() : rotatingTokens()) });
    await startOutage(subrite.params);
    isDown = false;
    // NTP sets the clock an hour back. Without care, the pause would last another hour.
    mock.timers.setTime(start - 60 * MINUTE);
    assert.match(
      (await refreshAccessToken(sessionToken(), subrite.params)).accessToken,
      /^access-/,
    );
  });

  it('keeps sessions of other Subrite clients going', async () => {
    const broken = fakeSubrite({ token: down });
    const working = fakeSubrite({ token: rotatingTokens });
    await startOutage(broken.params);
    assert.match(
      (await refreshAccessToken(sessionToken(), working.params)).accessToken,
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

  it('warns once, not on every sign out, when Subrite has no revocation endpoint', async () => {
    const without = fakeSubrite({
      token: rotatingTokens,
      discovery: { revocation_endpoint: null },
    });
    assert.equal(await revokeRefreshToken(sessionToken(), without.params), false);
    assert.equal(await revokeRefreshToken(sessionToken(), without.params), false);
    assert.equal(loggedText().match(/no revocation_endpoint/g)?.length, 1);
  });

  it('gives up after 3 seconds by default, so signing out stays quick', async () => {
    const subrite = fakeSubrite({
      token: rotatingTokens,
      revocation: ({ signal }) =>
        new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    });
    const keepAlive = setTimeout(() => {}, 10_000);
    try {
      const started = Date.now();
      assert.equal(await revokeRefreshToken(sessionToken(), subrite.params), false);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 2900 && elapsed < 6000, `took ${elapsed} ms`);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('never throws, even without params', async () => {
    assert.equal(
      await revokeRefreshToken(sessionToken(), undefined as unknown as RefreshParams),
      false,
    );
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
