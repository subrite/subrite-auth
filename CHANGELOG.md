# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/)
and this project adheres to [Semantic Versioning](http://semver.org/).

## [Unreleased]

### Breaking

- Requires Node.js 22 or later.
- Requires `next-auth` 4.24.15 or later. Older versions have known security issues.
- The provider no longer puts the tokens on the NextAuth `User`. Read them from `account` in the
  `jwt` callback with `toSubriteJWT` (as the README shows). This stops stale copies of the tokens
  piling up in the session cookie. Apps that keep the 0.2.1 callbacks still work.
- `SubriteProfile` no longer extends `SubriteJWT`, and `name`, `email` and `image` are optional.
  Use the new `SubriteSession` type to augment `Session` (see the README).
- A path in `subriteUrl` is now kept. `https://example.com/tenant` gives
  `https://example.com/tenant/api/oidc/...`. Before, the path was dropped.

### Added

- `isAccessTokenExpired(token, marginSeconds = 60)`. Refreshes a little before the access token
  expires, so it doesn't run out in the middle of a request.
- `revokeRefreshToken(token, params)`. Revokes the refresh token at Subrite, for example from
  `events.signOut`. Refresh tokens for offline access keep working after the user signs out of
  Subrite.
- `generatePostSignOutUrl` takes `{ state, idTokenHint }`. The README shows how `state` stops
  other sites from signing your users out.
- `refreshAccessToken` takes optional `timeoutMs` (default 10 seconds), `client` and
  `oldCookieGraceSeconds`.
- `SubriteSession`, `SubriteTokenError`, `RefreshParams` and `SignOutOptions` types.
  `subriteUrl` accepts a `URL` as well as a string.

### Fixed

- `refreshAccessToken` no longer writes tokens to the log.
- Only `invalid_grant` from Subrite marks the session with `RefreshAccessTokenError`. Then the
  rejected refresh token is removed and Subrite is not asked again for that session. In 0.2.1 any
  failure, even a network blip, set the error for good.
- Every other failure leaves the token as is: network errors, timeouts, a response that breaks
  off or has no tokens, redirects, 5xx, 429, firewall or CDN pages, and client configuration
  errors such as `invalid_client`, `unauthorized_client` or `invalid_request`. That refresh
  token waits 10 seconds (or as long as `Retry-After` says), doubling with each failure in a row
  up to 5 minutes, so a refresh token that keeps failing only delays itself. When two different
  refresh tokens fail with no answer from Subrite in between, all refreshes for that Subrite
  client pause the same way and one request at a time checks whether Subrite is back. As soon as
  Subrite answers, everyone refreshes right away.
- Sessions that 0.2.1 marked with `RefreshAccessTokenError` after a temporary failure recover on
  the next refresh.
- Requests that hold the same refresh token share one refresh within a server process, also
  across the copies of the library that Next.js loads for different routers. When Subrite
  replaced the refresh token, a later request with an old cookie gets the new tokens from memory
  until the new access token is about to expire (`oldCookieGraceSeconds` can shorten this),
  instead of sending the used refresh token again. An expired access token is never handed out. When Subrite kept it, results are shared for
  30 seconds at most. Results are never shared between different Subrite servers or clients.
- `refreshAccessToken` reads the token endpoint from Subrite's OpenID configuration, never
  follows redirects (and works on Cloudflare Workers), and authenticates the same way as the sign
  in (HTTP Basic, unless Subrite only supports `client_secret_post`).
- A token response without `expires_in` keeps the new tokens and assumes 5 minutes, instead of
  throwing away a refresh token Subrite may already have replaced. `expires_in` may be a numeric
  string.
- Network errors are logged with their cause, such as `ECONNREFUSED`.
- The profile picture is read from the standard `picture` claim, falling back to `image`.
- TypeScript types now resolve with `moduleResolution` set to `bundler`, `node16` or `nodenext`,
  and work with `exactOptionalPropertyTypes`.
- The package `exports` declare their types.

## [0.2.1] - 2024-10-28

### Fixed

- Build the package before publishing.

## [0.2.0] - 2024-10-28

### Changed

- Requires `next-auth` 4.24 or later.

This version was removed from npm.

## [0.1.0] - 2023-11-01

### Added

- Added `toSubriteJWT` function
- Changed the signature of `refreshAccessToken`

### Changed

- Improved TypeScript types

## [0.0.2] - 2023-10-27

### Added

- Added documentation
- Added `refreshAccessToken` function
- Added `generatePostSignOutUrl` function

## [0.0.1] - 2023-10-18

### Added

- First release!

[Unreleased]: https://github.com/subrite/subrite-auth/commits/develop
[0.2.1]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.2.1
[0.2.0]: https://github.com/subrite/subrite-auth/commit/44e42f18cd4a41245be7b2231563558f2c356868
[0.1.0]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.1.0
[0.0.2]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.0.2
[0.0.1]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.0.1
