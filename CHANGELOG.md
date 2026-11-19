# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/)
and this project adheres to [Semantic Versioning](http://semver.org/).

## [Unreleased]

## [0.3.0] - Unreleased

See "Upgrading from 0.1.x or 0.2.x" in the README.

### Breaking

- Requires Node.js 22 or later.
- Requires `next-auth` 4.24.15 or later. Older versions have known security issues. npm refuses
  to install next to an older `next-auth`. Note two changes in `next-auth` itself: `NEXTAUTH_URL`
  now wins over the host Vercel detects, and a sign in started before the deploy fails once at
  the callback.
- Only `invalid_grant` from Subrite marks the session with `RefreshAccessTokenError`. Other
  failures return the token unchanged, and that refresh token is tried again later instead of on
  the next request. An unchanged token means "not refreshed yet", not a failed refresh.

### Deprecated

- The tokens on the NextAuth `User` at sign in. `profile()` still returns them, so `jwt`
  callbacks that read them from `user` keep working, but read them from `account` with
  `toSubriteJWT`. They go away in 1.0.
- `SubriteProfile`, kept so 0.2.x type augmentations still compile. Use `SubriteClaims` for the
  claims and `SubriteSession` for the session.

### Added

- `isAccessTokenExpired(token, marginSeconds = 60)`. Refreshes a little before the access token
  expires, so it doesn't run out in the middle of a request.
- `revokeRefreshToken(token, params)`. Revokes the refresh token at Subrite, for example from
  `events.signOut`, where Subrite lists a `revocation_endpoint`. Refresh tokens for offline access
  keep working after the user signs out of Subrite. Gives up after 3 seconds by default.
- `generatePostSignOutUrl` takes `{ state, idTokenHint }`. The README shows how `state` stops
  other sites from signing your users out.
- `refreshAccessToken` takes optional `timeoutMs` (default `httpOptions.timeout`, or 10 seconds),
  `httpOptions`, `client` and `oldCookieGraceSeconds`.
- `SubriteClaims`, `SubriteSession`, `SubriteTokenError`, `RefreshParams` and `SignOutOptions`
  types. `RefreshParams.subriteUrl` accepts a `URL` as well as a string.
- A warning when `subriteUrl` has a path, which is ignored as before.

### Fixed

- `refreshAccessToken` no longer writes tokens to the log, and never throws.
- In 0.2.x any failed refresh, even a network blip, set `RefreshAccessTokenError` for good. Now
  the session is only marked when Subrite rejects the refresh token. Then the rejected refresh
  token is removed and Subrite is not asked again for that session. Sessions that 0.2.x marked
  after a temporary failure recover on the next refresh.
- Failures that are not about the token keep the session: network errors, timeouts, a response
  that breaks off or has no tokens, redirects, 5xx, 429, firewall or CDN pages, and client
  configuration errors such as `invalid_client`, `unauthorized_client` or `invalid_request`.
  That refresh token waits 10 seconds (or as long as `Retry-After` says), doubling with each
  failure in a row up to 5 minutes, so a refresh token that keeps failing only delays itself.
  When three different refresh tokens fail with no answer from Subrite in between, refreshes for
  that Subrite client pause for 10 seconds, growing to at most a minute, and one request at a
  time checks whether Subrite is back. Broken accounts can't keep healthy users out this way.
  When a check finds Subrite back, everyone refreshes right away.
- Requests that hold the same refresh token share one refresh within a server process, also
  across the copies of the library that Next.js loads for different routers. When Subrite
  replaced the refresh token, a later request with an old cookie gets the new tokens from memory
  until the new access token is about to expire (`oldCookieGraceSeconds` can shorten this),
  instead of sending the used refresh token again. When Subrite kept it, results are shared for
  30 seconds at most. An expired access token is never handed out. Results are never shared
  between different Subrite servers or clients.
- `refreshAccessToken` reads the token endpoint from Subrite's OpenID configuration, never
  follows redirects (and works on Cloudflare Workers), and authenticates the same way as the sign
  in (HTTP Basic, unless Subrite only supports `client_secret_post`).
- A token response without `expires_in` keeps the new tokens and assumes 5 minutes, instead of
  throwing away a refresh token Subrite may already have replaced. `expires_in` may be a numeric
  string.
- Network errors are logged with their cause, such as `ECONNREFUSED`.
- The profile picture is read from the standard `picture` claim, falling back to `image`.
- TypeScript types now resolve with `moduleResolution` set to `bundler`, `node16` or `nodenext`,
  and work with `exactOptionalPropertyTypes`. `error` accepts your own values too.
- The package `exports` declare their types. A browser bundle that only uses
  `generatePostSignOutUrl` no longer includes the refresh code.

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

[Unreleased]: https://github.com/subrite/subrite-auth/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/subrite/subrite-auth/compare/762342a...v0.3.0
[0.2.1]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.2.1
[0.2.0]: https://github.com/subrite/subrite-auth/commit/44e42f18cd4a41245be7b2231563558f2c356868
[0.1.0]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.1.0
[0.0.2]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.0.2
[0.0.1]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.0.1
