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
// The trailing slash keeps any path that SUBRITE_URL has.
const base = subriteUrl.endsWith('/') ? subriteUrl : `${subriteUrl}/`;
const subriteSignoutUrl = new URL('api/oidc/session/end', base);
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

It requires Node.js 22 or later and `next-auth` 4.24.15 or later.

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
  subriteUrl: 'your-subrite-url',
};

export const options: NextAuthOptions = {
  providers: [Subrite(subriteConfig)],
  events: {
    // The refresh token keeps working after the user signs out of Subrite, so revoke it.
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
      // Lets the browser see that the user must sign in again.
      session.error = token.error;
      return session;
    },
  },
};
```

The ID token is validated on sign in, and the user's name, email and picture are read from it.

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

On the server, check `session.error` (from `getServerSession`) or `token.error` (from `getToken`) the same way.

Nothing else signs anyone out. A network error, a timeout, a 5xx or 429, a firewall or CDN page, or an error about the client configuration (such as `invalid_client` while a client secret is being fixed) leaves the token as is (still expired).
Refreshes for that Subrite client then pause for 10 seconds, or as long as Subrite's `Retry-After` header says. After the pause one request checks whether Subrite is back, while the others keep their tokens. Each failure in a row doubles the pause, up to 5 minutes.
Configuration problems are logged with a hint, and sessions recover on their own once the configuration is fixed.

### Where a refreshed token is saved

The `jwt` callback refreshes the token wherever NextAuth reads the session. The new token is only saved where NextAuth can write the session cookie:

- the NextAuth route `/api/auth/session`, which `useSession` and `SessionProvider` call in the browser
- `getServerSession(req, res, options)` in the Pages Router

In the App Router, `getServerSession(options)` in Server Components, Route Handlers and Server Actions refreshes the token but cannot save it. The browser keeps the old cookie.

That matters when Subrite replaces the refresh token on refresh (rotation). Sending the old one again is a reuse, and Subrite may answer by revoking the whole sign in.
So within one server process, a request with an old cookie gets the new tokens from memory instead, until the new access token is about to expire. The first time that happens more than 30 seconds after the refresh, it is logged as a warning.
When Subrite keeps the refresh token, nothing is reused for longer than 30 seconds, so a forced refresh or a revocation reaches Subrite.

In App Router apps, make sure the browser saves the refreshed cookie soon:

```tsx
<SessionProvider refetchInterval={5 * 60}>{children}</SessionProvider>
```

`SessionProvider` calls `/api/auth/session` when it mounts, when the window gets focus, and every `refetchInterval` seconds. It does not call it on client side navigation, and it skips the call on mount when you pass it a `session` prop. Keep `refetchInterval` well below the access token lifetime minus one minute.

An app that only renders on the server, without `SessionProvider`, sends an already used refresh token once the new access token expires. If Subrite rotates refresh tokens, that user must sign in again.

Answering old cookies from memory also means a copied session cookie gets new tokens without Subrite noticing the reuse. If your app always saves refreshed cookies right away (Pages Router, or no Server Components that read the session), make the window short:

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

If your application is registered with `client_secret_post`, send `client_id` and `client_secret` in the form instead of the `Authorization` header.

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
