# Subrite Auth

Subrite Auth is an authentication service for web sites using Subrite.

It is based on OAuth 2.0 and OpenID Connect.

This guide walks through the steps required to use Subrite Auth

## Registering a Subrite Application

To use Subrite Auth, you must first register your application with Subrite.
You must provide a `REDIRECT_URI` for your application. This is the URL where
Subrite Auth will redirect the user after they have logged in.

Once you have registered your application, you will be given a `CLIENT_ID` and a `CLIENT_SECRET`. You will also be given a `SUBRITE_URL`, which is the URL of the Subrite server you will be using.

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
```

With `@subrite/next-auth-provider` you can use `generatePostSignOutUrl(subriteUrl, clientId, postLogoutRedirectUri)` instead.

The `postLogoutRedirectUri` must be one of the `post_logout_redirect_uri` values configured for your application in Subrite.

```tsx
<!-- This link initiates the sign out flow -->
<a href={subriteSignoutUrl.href}>Sign Out</a>
```

The `/logout` page where the browser is redirected to should clear the user's application session.
Below is an example that uses NextAuth.js:

```tsx
'use client';

import { signOut, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function LogoutPage() {
  const [error, setError] = useState<string>('');
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    // Wait until NextAuth knows whether the user is signed in.
    if (status === 'loading') return;

    if (status === 'authenticated') {
      signOut({ callbackUrl: '/' }).catch((err) => setError(err.message));
    } else {
      router.push('/');
    }
  }, [status, router]);

  return <>{error ? <p>{error}</p> : <p>Signing out...</p>}</>;
}
```

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
  toSubriteJWT,
} from '@subrite/next-auth-provider';

const subriteConfig = {
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  subriteUrl: 'your-subrite-url',
};

export const options: NextAuthOptions = {
  providers: [Subrite(subriteConfig)],
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

`refreshAccessToken` never throws. If Subrite rejects the refresh token (for example because the user signed out from Subrite, or the session expired), the token gets `error: 'RefreshAccessTokenError'`.
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

On the server, check `token.error` (from `getToken`) or `session.error` (from `getServerSession`) the same way.

If Subrite can't be reached, or answers with a 5xx or 429, the token is left as is (still expired) and the refresh is tried again after 10 seconds.

### Keeping the access token on the server

The example `session` callback puts the access token in the session, which makes it readable by JavaScript in the browser.
Only do that if browser code calls Subrite directly. Otherwise leave it out, and read the token on the server with `getToken` from `next-auth/jwt`.
The refresh token is never put in the session.

### Running on several servers

Within one server process, parallel requests share a single refresh, so a refresh token is never sent twice.
If your app runs on several servers or serverless instances, two of them can still refresh the same session at the same moment.
If Subrite rotates refresh tokens, the second refresh is rejected and that user has to sign in again.

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
  "expires_in": {SECONDS_UNTIL_EXPIRATION},
}
```

Always store the new refresh token. Once it is used, the old one may no longer work.

For a more detailed explanation please refer to [The OAuth 2.0 Authorization Framework
](https://www.rfc-editor.org/rfc/rfc6749.html) specification.
