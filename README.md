# Subrite Auth

Subrite Auth is an authentication service for web sites using Subrite.

It is based on OAuth 2.0 and OpenID Connect.

This guide walks through the steps required to use Subrite Auth

## Registering a Subrite Application

To use Subrite Auth, you must first register your application with Subrite.
You must provide a `REDIRECT_URI` for your application. This is the URL where
Subrite Auth will redirect the user after they have logged in.

Once you have registered your application, you will be given a `CLIENT_ID` and a `CLIENT_SECRET`. You will also be given a `SUBRITE_URL`, which is the URL of the Subrite server you will be using.

Your application must be allowed to use refresh tokens (the `offline_access` scope). The NextAuth provider below needs them.

## Creating a login link

To log in a user, you must first create a login link.
The example below is an example (with line breaks for readability).
All parameters must be URL encoded.

    {SUBRITE_URL}/api/oidc/auth
      ?client_id={CLIENT_ID}
      &scope=openid%20offline_access
      &response_type=code
      &redirect_uri={REDIRECT_URI}
      &state={STATE}
      &code_challenge={CODE_CHALLENGE}
      &code_challenge_method=S256

It's strongly recommended that you use an OAuth library to generate this link.
You need to use PKCE.

The `STATE` and `CODE_CHALLENGE` will be provided by your OAuth library.

## Logging out

When you implement logout in your application, you must make sure to log the user out from Subrite as well as your application.

You should log out from Subrite first, and then log out from your application.

To log out from Subrite, the browser must visit the Subrite logout endpoint.
The Subrite logout endpoint will then redirect back to your application's configured `post_logout_redirect_uri`

The following JavaScript code illustrates how to construct a logout URL for Subrite:

```typescript
// Construct a URL object for the Subrite sign out endpoint.
const subriteSignoutUrl = new URL('/api/oidc/session/end', subriteUrl);
// Tell subrite what client we are signing out from
subriteSignoutUrl.searchParams.append('client_id', clientId);
// Tell subrite where to send the user agent after signing out (where we sign out from the application)
const postLogoutRedirectUri = new URL('/logout', process.env.NEXT_PUBLIC_NEXTAUTH_URL!).href;
subriteSignoutUrl.searchParams.append('post_logout_redirect_uri', postLogoutRedirectUri);
// A random value that Subrite sends back to the logout page. See below.
subriteSignoutUrl.searchParams.append('state', state);
```

With `@subrite/next-auth-provider` you can use `generatePostSignOutUrl(subriteUrl, clientId, postLogoutRedirectUri, { state })` instead.

The `postLogoutRedirectUri` must be one of the `post_logout_redirect_uri` values configured for your application in Subrite.

The `/logout` page where the browser is redirected to should clear the user's application session.
It should only do that without asking when the sign out started on your site. Otherwise any other site could sign your users out by linking to `/logout`.
The `state` value makes that check possible. Below is an example that uses NextAuth.js:

```tsx
'use client';

import { generatePostSignOutUrl } from '@subrite/next-auth-provider';

export const SIGN_OUT_STATE_KEY = 'subrite-sign-out-state';

export function SignOutButton() {
  function signOutOfSubrite() {
    const state = crypto.randomUUID();
    sessionStorage.setItem(SIGN_OUT_STATE_KEY, state);
    window.location.href = generatePostSignOutUrl(
      process.env.NEXT_PUBLIC_SUBRITE_URL!,
      process.env.NEXT_PUBLIC_SUBRITE_CLIENT_ID!,
      new URL('/logout', window.location.origin).href,
      { state },
    );
  }

  return <button onClick={signOutOfSubrite}>Sign out</button>;
}
```

```tsx
'use client';

import { signOut, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SIGN_OUT_STATE_KEY } from './sign-out-button';

export default function LogoutPage() {
  const [error, setError] = useState('');
  const [askFirst, setAskFirst] = useState(false);
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    // Wait until NextAuth knows whether the user is signed in.
    if (status === 'loading') return;
    if (status !== 'authenticated') {
      router.push('/');
      return;
    }

    const state = new URLSearchParams(window.location.search).get('state');
    if (state && state === sessionStorage.getItem(SIGN_OUT_STATE_KEY)) {
      signOut({ callbackUrl: '/' }).catch((err) => setError(err.message));
    } else {
      // The sign out did not start here. Let the user decide.
      setAskFirst(true);
    }
  }, [status, router]);

  if (error) return <p>{error}</p>;
  if (askFirst) return <button onClick={() => signOut({ callbackUrl: '/' })}>Sign out</button>;
  return <p>Signing out...</p>;
}
```

Signing out of Subrite does not end the app sessions that use it: refresh tokens for offline access keep working after it. That is why the app must clear its own session.

## NextAuth.js

If your application uses [NextAuth.js](https://next-auth.js.org/) v4, you can use the `@subrite/next-auth-provider` NPM module.

It requires Node.js 22 or later and `next-auth` 4.24.15 or later. Coming from an earlier version? See [Upgrading from 0.1.x or 0.2.x](#upgrading-from-01x-or-02x).

### Installation

    npm install @subrite/next-auth-provider

### NextAuth Configuration

Configure NextAuth to use the Subrite provider:

```typescript
import type { NextAuthOptions } from 'next-auth';
import Subrite, {
  isAccessTokenExpired,
  refreshAccessToken,
  revokeRefreshToken,
  toSubriteJWT,
} from '@subrite/next-auth-provider';

const subriteConfig = {
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  // The Subrite server's origin, like https://example.subrite.no
  subriteUrl: 'your-subrite-url',
};

export const options: NextAuthOptions = {
  providers: [Subrite(subriteConfig)],
  events: {
    // The refresh token keeps working after the user signs out of Subrite, so revoke it
    // (where Subrite supports revocation, see "Signing out" below).
    async signOut({ token }) {
      await revokeRefreshToken(token, subriteConfig);
    },
  },
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        // Initial sign in
        return {
          ...token,
          ...toSubriteJWT(account),
        };
      }

      // Return previous token if the access token has not expired yet.
      // The token counts as expired one minute early, so it doesn't run out mid request.
      if (!isAccessTokenExpired(token)) {
        return token;
      }

      return refreshAccessToken(token, subriteConfig);
    },
    async session({ session, token }) {
      // Only needed if code in the browser calls Subrite with the access token.
      session.accessToken = token.accessToken;
      // Lets the browser see that the user must sign in again. A token that still has its refresh
      // token is fine: 0.2.x could leave a stale error on it. (Leave the key out rather than set
      // it to undefined, which getServerSideProps can't serialize.)
      if (token.error && !token.refreshToken) {
        session.error = token.error;
      }
      return session;
    },
  },
};
```

The ID token is validated on sign in, and the user's name, email and picture are read from it.

The one minute margin of `isAccessTokenExpired` assumes access tokens live much longer (Subrite's live hours). With tokens that live a minute or two, pass a smaller margin, like `isAccessTokenExpired(token, 10)`, or every request refreshes.

`refreshAccessToken` and `revokeRefreshToken` use the global `fetch`, and ignore the provider's `httpOptions`. `refreshAccessToken` waits up to 30 seconds for Subrite. Set `timeoutMs` to change that, but don't set it much lower: when Subrite replaces refresh tokens, a refresh given up after Subrite handled it leaves the session with a used refresh token.

Subrite must give the app a refresh token without asking the user for consent each time. If your Subrite server only does that with `prompt=consent`, add `authorization: { params: { prompt: 'consent' } }` to `subriteConfig`.

If your application is registered with `client_secret_post` instead of the default HTTP Basic authentication, add it to the config.
`satisfies` keeps the exact type that NextAuth expects:

```typescript
import type { SubriteConfig } from '@subrite/next-auth-provider';

const subriteConfig = {
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  subriteUrl: 'your-subrite-url',
  client: { token_endpoint_auth_method: 'client_secret_post' },
} satisfies SubriteConfig;
```

A public client, registered without a secret, sets `clientSecret: ''` and `client: { token_endpoint_auth_method: 'none' }`. The refresh then sends only the client id.

### TypeScript Configuration

(You can skip this step if you are not using TypeScript)

NextAuth provides some built-in types for TypeScript that [can be augmented](https://next-auth.js.org/getting-started/typescript#module-augmentation) with custom properties.

Add Subrite-specific properties:

```typescript
// next-auth.d.ts
// Read more at: https://next-auth.js.org/getting-started/typescript#module-augmentation
import type { SubriteJWT, SubriteSession } from '@subrite/next-auth-provider';

declare module 'next-auth' {
  interface Session extends SubriteSession {}
}

declare module 'next-auth/jwt' {
  interface JWT extends SubriteJWT {}
}
```

### When the user must sign in again

`refreshAccessToken` never throws. If Subrite rejects the refresh token with `invalid_grant` (because it expired or was revoked), the token gets `error: 'RefreshAccessTokenError'` and the rejected refresh token is removed.
From then on `refreshAccessToken` returns it as is, without calling Subrite. Send the user through sign in again:

```tsx
'use client';

import { signIn, useSession } from 'next-auth/react';
import { useEffect } from 'react';

export function SubriteSessionGuard() {
  const { data: session } = useSession();

  useEffect(() => {
    if (session?.error === 'RefreshAccessTokenError') {
      signIn('subrite');
    }
  }, [session?.error]);

  return null;
}
```

On the server, check `session.error` (from `getServerSession`) the same way. `getToken` returns the raw token, so check `token.error === 'RefreshAccessTokenError' && !token.refreshToken`.

The user must sign in again only when `error` is `'RefreshAccessTokenError'` and `refreshToken` is empty. A token that still has its refresh token can carry a stale error from 0.2.x, which the next successful refresh removes.
When `refreshAccessToken` returns the token unchanged (the same `accessToken`), the token has not been refreshed yet: Subrite was down or slow, or refreshes are paused. That is not a failed refresh, so don't sign the user out for it.

Nothing else signs anyone out. A network error, a timeout, a 5xx or 429, a firewall or CDN page, a response without tokens, or an error about the client configuration (such as `invalid_client` while a client secret is being fixed) leaves the token as is (still expired).
One exception: when Subrite replaces refresh tokens, a refresh that times out or breaks off after Subrite handled it leaves the session with a used refresh token, so the next refresh gets `invalid_grant`.

- That refresh token waits 10 seconds before it is tried again (or as long as Subrite's `Retry-After` header says, between 10 seconds and 5 minutes), doubling with each failure in a row up to 5 minutes. A refresh token that keeps failing on its own (for example because of bad data for one account) only delays itself.
- When three different refresh tokens fail and Subrite answers nothing in between (no new tokens and no rejection), Subrite is likely in trouble or the client is misconfigured. Then all refreshes for that Subrite client pause for 10 seconds (or as long as `Retry-After` says). After that, one request at a time checks whether Subrite is back. The others keep their tokens and wait for its answer, up to 30 seconds. When the check fails and its refresh token had already failed in the outage, only tokens like it wait again.
- The pause doubles when a check by a refresh token that had not failed yet fails, up to one minute (or as long as `Retry-After` says, up to 5 minutes). Requests that were already on their way when the pause started never make it double. One that fails later starts the current pause over. The pause does not grow for `500 server_error`, Subrite's answer to any unexpected failure, because that can be one account's bad data. So three broken accounts failing in a quiet moment can hold other users up for 10 seconds, plus 10 seconds for each further broken account that fails for the first time during the pause, plus how long their checks wait on Subrite.
- As soon as a check finds Subrite back, everyone refreshes right away. That is at most a minute after Subrite recovers (or as long as `Retry-After` asked, up to 5 minutes), plus up to 30 seconds if a check was waiting on Subrite at that moment.

Configuration problems are logged with a hint, and sessions recover on their own once the configuration is fixed.

### Where a refreshed token is saved

The `jwt` callback refreshes the token wherever NextAuth reads the session. The new token is only saved where NextAuth can write the session cookie:

- the NextAuth route `/api/auth/session`, which `useSession` and `SessionProvider` call in the browser
- `getServerSession(req, res, options)` in the Pages Router

In the App Router, `getServerSession(options)` in Server Components, Route Handlers and Server Actions refreshes the token but cannot save it. The browser keeps the old cookie.

That matters when Subrite replaces the refresh token on refresh (rotation). Sending the old one again is a reuse, and Subrite may answer by revoking the whole sign in.
So within one server process, a request with an old cookie gets the new tokens from memory instead, until the new access token is about to expire. The first time that happens more than 30 seconds after the refresh, it is logged as a warning.
When Subrite keeps the refresh token, a result is reused for at most 30 seconds. A forced refresh with the same refresh token within those 30 seconds gets the same access token.

In App Router apps, make sure the browser saves the refreshed cookie soon:

```tsx
<SessionProvider refetchInterval={5 * 60}>{children}</SessionProvider>
```

`SessionProvider` calls `/api/auth/session` when it mounts, when the window gets focus, and every `refetchInterval` seconds. It does not call it on client side navigation, and it skips the call on mount when you pass it a `session` prop. Keep `refetchInterval` well below the access token lifetime minus one minute.

An app that only renders on the server, without `SessionProvider`, sends an already used refresh token once the new access token expires. If Subrite rotates refresh tokens, that user must sign in again.

Answering old cookies from memory also means a copied session cookie gets new tokens without Subrite noticing the reuse. If your app always saves refreshed cookies right away (Pages Router, or no Server Components that read the session), make the window short. The setting can only shorten the default window, and never below 30 seconds:

```typescript
refreshAccessToken(token, { ...subriteConfig, oldCookieGraceSeconds: 30 });
```

### Keeping the access token on the server

The example `session` callback puts the access token in the session, which makes it readable by JavaScript in the browser.
Only do that if browser code calls Subrite directly. Otherwise leave it out, and read the token on the server with `getToken` from `next-auth/jwt`.

`getToken` returns the token as the cookie stores it. It never refreshes, so check `isAccessTokenExpired(token)` before you use `token.accessToken`.
If it has expired, answer with a 401 and let the browser call `getSession()` (which refreshes and saves the cookie) and try again.
The refresh token is never put in the session.

### Running on several servers

Within one server process, every request that holds the same refresh token shares one refresh, also across the separate copies of the library that Next.js loads for the Pages Router and the App Router.
Different servers and serverless instances don't share memory. Two of them can refresh the same session at the same moment, or an old cookie can reach an instance that hasn't seen the refresh.
If Subrite rotates refresh tokens and rejects a reused one, that user must sign in again.

### Signing out

`revokeRefreshToken(token, subriteConfig)` revokes the refresh token at Subrite. The configuration above calls it from `events.signOut`.
It never throws, and returns `true` when Subrite confirmed the revocation. Afterwards, requests with an old cookie that holds the token are not answered from memory any more.

It only works on Subrite servers whose OpenID configuration lists a `revocation_endpoint`. Elsewhere it returns `false`, logs a warning once, and the refresh token keeps working until it expires.
NextAuth waits for `events.signOut` before it signs the user out, so `revokeRefreshToken` gives up after 3 seconds unless you set `timeoutMs`.

### Testing your app

Unit tests that mock `fetch` for `refreshAccessToken`, or for a `jwt` callback that calls it, must:

- Answer `GET {subriteUrl}/api/oidc/.well-known/openid-configuration` with at least a `token_endpoint`. Route mocks by URL, since the configuration is cached and not requested every time.
- Expect the client id and secret in an `Authorization: Basic` header, not in the form. The form is used when the config sets `token_endpoint_auth_method`, when the OpenID configuration lists only `client_secret_post`, or when the secret is empty.
- Call `resetRefreshState()` before each test. Refresh results, back offs and the configuration are kept in memory for the whole process, and `jest.resetModules()` does not clear them.

```typescript
import { resetRefreshState } from '@subrite/next-auth-provider';

beforeEach(() => {
  resetRefreshState();
});
```

## Upgrading from 0.1.x or 0.2.x

Most apps upgrade without code changes. Each item says who it affects.

### Installing

1. **Use Node.js 22 or later wherever you install**, also in CI, Docker images and your host's build. yarn 1, and npm or pnpm with `engine-strict`, refuse to install on older Node.
2. **Install `next-auth` 4.24.15 or later in the same step.** Older versions have known security issues.

       npm install @subrite/next-auth-provider@^0.3.0 next-auth@^4.24.15

   When `next-auth` is a caret range in package.json (npm's default), npm upgrades it by itself. When it is pinned to an older version, npm fails with `ERESOLVE`. pnpm and yarn only warn, and so does npm when the provider comes in through another package. Check with `npm ls next-auth`.

   If your app depends on `nodemailer` (for example for NextAuth's Email provider), `next-auth` 4.24.12 and later need nodemailer 7, or npm fails with `ERESOLVE`. Add `nodemailer@^7.0.7` to the same command. Its only breaking change is in the SES transport.

3. **`next-auth` 4.24.15 behaves differently** in two ways. `NEXTAUTH_URL` now wins over the host from the request headers, which `next-auth` used on Vercel and with `AUTH_TRUST_HOST` (for example behind a proxy, or one deployment serving several domains). Set it to the URL each environment is served on. And a sign in that was started before your deploy fails once at the callback, because the sign in cookies now belong to a provider. Signing in again works.

### Code

4. **TypeScript checks the provider config now.** With `moduleResolution` set to `bundler` (the Next.js default), `node16` or `nodenext`, the 0.2.x types resolved to `any`. `next build` can now report:
   - `Type 'string | undefined' is not assignable to type 'string'` for env vars passed to `Subrite()`. Use `process.env.SUBRITE_CLIENT_ID!`, or check the variables at startup.
   - Errors on `checks` in a separate config object. Add `satisfies SubriteConfig` to it.
   - Errors on a `profile` override. Type its first parameter as `SubriteClaims` (or leave it untyped), not `Record<string, unknown>`. While your `User` augmentation has the token fields, return `...toSubriteJWT(tokens)` from it (see the next item).
   - Errors in `export *` re-exports, when one of the new exports has the same name as one of yours.

   These also show up with `node10`, since the types changed:
   - Errors where your code narrows `error`, keeps something other than a string in `token.error`, or declares `error?: unknown` in its `JWT` augmentation. `error` is a string, `null` or `undefined`. Compare with `=== 'RefreshAccessTokenError'`, and store `error instanceof Error ? error.message : String(error)` (an `Error` was saved as `{}` in the cookie anyway).
   - Errors where code needs every key of `SubriteJWT`, like `Record<keyof SubriteJWT, string>`. It has `error` now. Use `SubriteTokens`, which has only the three token fields.
   - Errors in tests that call `provider.profile()` with the token fields in the claims. Pass only the claims (`SubriteClaims`).
   - Errors on settings typed as `Parameters<typeof refreshAccessToken>[1]`, whose `subriteUrl` may now be a `URL`. Type them as `SubriteConfig`.

5. **Take the tokens from `account`, not `user`.** If your `jwt` callback reads `accessToken`, `refreshToken` or `accessTokenExpires` from `user` on sign in, it still works, but that is deprecated and goes away in 1.0. Use `...toSubriteJWT(account)` as in the configuration above, and remove the token fields from your `User` augmentation so TypeScript shows what still reads them.
6. **Move to `SubriteSession`.** The 0.2.x augmentation (`user: DefaultSession['user'] & SubriteProfile`) still compiles. `SubriteProfile` is deprecated, because the session's user never really had those token fields, and `@typescript-eslint/no-deprecated` reports it. Use `interface Session extends SubriteSession {}` and `session.accessToken`.
7. **Show `session.error`.** When Subrite rejects the refresh token, the session gets `error: 'RefreshAccessTokenError'` and the user must sign in again (see [When the user must sign in again](#when-the-user-must-sign-in-again)). Coming from 0.1.x: since 0.2.0 `refreshAccessToken` never throws, so NextAuth no longer clears the session by itself. If you want that, throw from the `jwt` callback when `error` is `'RefreshAccessTokenError'` and `refreshToken` is empty.
8. **`subriteUrl` is the server's origin.** A path in it is ignored, as before, and now logs a warning once.

### Behavior

9. **An unchanged token is not a failure.** Other errors no longer flag the session. The token comes back unchanged, with its expired access token, and that refresh token is tried again after 10 seconds, doubling up to 5 minutes. After `invalid_grant`, `refreshToken` is an empty string.
10. **The profile picture is filled in.** `session.user.image` now comes from Subrite's `picture` claim. 0.2.x only read `image`, so it was usually empty. If you show it with `next/image`, allow its host in `images.remotePatterns`, and in `img-src` if you have a Content Security Policy. A missing name or picture is now `null` instead of left out, so default values in destructuring and `=== undefined` checks no longer apply. To keep the 0.2.x values, override `profile` to return `{ id: claims.sub, name: claims.name, email: claims.email, image: claims.image, ...toSubriteJWT(tokens) }`.
11. **The refresh request changed.** It first reads `/api/oidc/.well-known/openid-configuration` (once an hour per server process), then authenticates with HTTP Basic, unless the `client` you pass to `refreshAccessToken` sets `token_endpoint_auth_method`. Pass it the same config as `Subrite()`. 0.2.x posted the client secret in the form to `/api/oidc/token`. Firewall rules for outgoing requests must allow both.
12. **Refreshes are shared and time out.** Requests with the same refresh token share one refresh within a server process, and a second refresh within 30 seconds gets the same access token. A refresh gives up after 30 seconds. 0.2.x waited as long as `fetch` did (5 minutes). If Subrite can take longer, raise `timeoutMs`: when Subrite replaces refresh tokens, a refresh given up after Subrite handled it means the user must sign in again.
13. **Log messages changed.** Errors still start with `Error refreshing access token`, now followed by a colon and `{ status, error, error_description }`. Configuration problems and a missing `expires_in` have messages of their own. `toSubriteJWT`'s error for a missing refresh token still starts with `No refresh_token`, but says more.

### Tests

14. **App tests that mock `fetch` need updating.** See [Testing your app](#testing-your-app).

## Refreshing the access token

_Refreshing the access token is built into the `@subrite/next-auth-provider` module via the `refreshAccessToken` function._

If you are not using NextAuth, you will need to implement the refresh token flow yourself.

Read the token endpoint from `token_endpoint` in Subrite's OpenID configuration at `{SUBRITE_URL}/api/oidc/.well-known/openid-configuration`.

The HTTP request below requests a new access token (as well as a new refresh token).
The client authenticates with HTTP Basic: the form encoded `CLIENT_ID` and `CLIENT_SECRET`, joined by `:` and base64 encoded.

```
POST /api/oidc/token HTTP/1.1
Host: {SUBRITE_HOST}
Content-Type: application/x-www-form-urlencoded
Authorization: Basic {BASE64(CLIENT_ID:CLIENT_SECRET)}

grant_type=refresh_token&
refresh_token={REFRESH_TOKEN}
```

If your application is registered with `client_secret_post`, send `client_id` and `client_secret` in the form instead of the `Authorization` header. A public client (`none`) sends only `client_id` in the form.

Response:

```json
{
  "access_token": "{NEW_ACCESS_TOKEN}",
  "refresh_token": "{NEW_REFRESH_TOKEN}",
  "expires_in": 3600
}
```

`expires_in` is the number of seconds until the access token expires.

Always store the new refresh token. Once it is used, the old one may no longer work.

For a more detailed explanation please refer to [The OAuth 2.0 Authorization Framework
](https://www.rfc-editor.org/rfc/rfc6749.html) specification.
