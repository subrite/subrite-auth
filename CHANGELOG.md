# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/)
and this project adheres to [Semantic Versioning](http://semver.org/).

## [Unreleased]

## [0.3.0] - Unreleased

See "Upgrading from 0.1.x or 0.2.x" in the README.

### Breaking

Installing:

- Requires Node.js 22 or later. yarn 1, and npm or pnpm with `engine-strict`, refuse to install
  on older Node, also in frozen lockfile installs in CI and Docker. npm and pnpm otherwise only
  warn, or say nothing.
- Requires `next-auth` 4.24.15 or later. Older versions have known security issues. When
  `next-auth` is a caret range in package.json (npm's default), npm upgrades it in the same
  install. When it is pinned to an older version, npm fails with `ERESOLVE`. pnpm and yarn only
  warn, and so does npm when the provider comes in through another package. Apps that depend on
  `nodemailer` must move to nodemailer 7 (`^7.0.7`) in the same install, or npm fails with
  `ERESOLVE`. `next-auth` 4.24.15 changes two things itself: `NEXTAUTH_URL` now wins over the host
  from the request headers (used on Vercel and with `AUTH_TRUST_HOST`), so a deployment that
  serves several domains, or Vercel previews, must leave it unset. And a sign in started before
  the deploy fails once at the callback.

TypeScript:

- With `moduleResolution` set to `bundler` (the Next.js default), `node16` or `nodenext`, the
  0.2.x types resolved to `any`, so nothing was checked. Now they are. Env vars passed to
  `Subrite()` need `!` or a check. A separate config object that sets `checks` needs
  `satisfies SubriteConfig`. A `profile` override takes `SubriteClaims` (not
  `Record<string, unknown>`), and must return the tokens while the `User` augmentation has them.
- With any `moduleResolution`: `SubriteJWT` has an optional `error`: a string, `null` or
  `undefined`. A type that narrows `error` on the result of `refreshAccessToken`, a non-string
  value in `token.error`, `error?: unknown` in a `JWT` augmentation, and `keyof SubriteJWT` no
  longer fit. `SubriteTokens` has only the three token fields. Tests that call
  `provider.profile()` pass only the claims. `Parameters<typeof refreshAccessToken>[1]` has a
  `subriteUrl` that may be a `URL`. `style` read back from a config typed `SubriteConfig` may be
  partial. With `exactOptionalPropertyTypes`, calling a `SubriteConfig` profile override yourself
  gives a `SubriteUser`, whose name, email and image may be `undefined`, not a `User`.
- New exports can clash with your own names in `export *` re-exports.
- `SubriteProfile` is marked `@deprecated`, so `@typescript-eslint/no-deprecated` reports the
  0.2.x augmentation.

Sign in:

- `session.user.image` (`token.picture`) is now set from Subrite's `picture` claim. 0.2.x only
  read `image`. Apps that show it with `next/image` must allow its host in
  `images.remotePatterns`.
- A missing name or picture is `null` in the session and the JWT. 0.2.x left it out.
- The error `toSubriteJWT` throws for a missing refresh token says more. It still starts with
  `No refresh_token`.

Refreshing:

- Only `invalid_grant` from Subrite marks the session with `RefreshAccessTokenError`, and then
  `refreshToken` is an empty string. Other failures return the token unchanged, with its expired
  access token, and that refresh token is tried again after 10 seconds, doubling up to 5 minutes,
  or when `Retry-After` says (between 10 seconds and 5 minutes). When three different refresh
  tokens fail with no answer from Subrite in between, refreshes for the client pause for 10
  seconds, growing to a minute (or as long as `Retry-After` says, up to 5 minutes). Three broken
  accounts failing in a quiet moment look the same, so they can hold other users up briefly.
- The refresh reads Subrite's OpenID configuration first (once an hour per server process) and
  authenticates with HTTP Basic, like the sign in, unless Subrite only supports
  `client_secret_post` or the config sets `token_endpoint_auth_method`. Without a client secret it
  sends only the client id. 0.2.x posted the client secret in the form to `/api/oidc/token`.
- Refreshes are shared within a server process. A second refresh with the same refresh token
  within 30 seconds gets the same access token without asking Subrite.
- A refresh gives up after 30 seconds (`timeoutMs`). 0.2.x waited as long as `fetch` did. When
  Subrite replaces refresh tokens, a refresh given up after Subrite handled it means the user must
  sign in again.
- Log messages changed. Errors still start with `Error refreshing access token`, now followed by
  a colon and `{ status, error, error_description }`.
- App tests that mock `fetch` must also answer the OpenID configuration request, expect HTTP
  Basic, and call `resetRefreshState()` before each test.

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
- `refreshAccessToken` takes optional `timeoutMs` (default 30 seconds), `client` and
  `oldCookieGraceSeconds`, and accepts the provider config as it is.
- `resetRefreshState()`, so app tests can start each test with empty memory.
- Public clients: with `token_endpoint_auth_method: 'none'`, or an empty client secret, the
  refresh sends only the client id.
- `SubriteClaims`, `SubriteSession`, `SubriteTokens`, `SubriteTokenError`, `SubriteProvider`,
  `SubriteProviderLike`, `SubriteUser`, `SubriteAuthMethod`, `RefreshParams` and
  `SignOutOptions` types. `RefreshParams.subriteUrl` accepts a `URL` as well as a string.
- A warning when `subriteUrl` has a path, which is ignored as before, and an error when the
  config sets a `token_endpoint_auth_method` the refresh can't use (or that is no method at all).
  Each is logged once per process. An empty `token_endpoint_auth_method` counts as not set.

### Fixed

- `refreshAccessToken` no longer writes tokens to the log, and never throws.
- In 0.2.x any failed refresh, even a network blip, set `RefreshAccessTokenError` for good. Now
  the session is only marked when Subrite rejects the refresh token. Then the rejected refresh
  token is removed and Subrite is not asked again for that session. Sessions that 0.2.x marked
  with `RefreshAccessTokenError` after a temporary failure recover on the next refresh. Error
  values your app sets are left alone.
- Failures that are not about the token keep the session: network errors, timeouts, a response
  that breaks off or has no tokens, redirects, 5xx, 429, firewall or CDN pages, and client
  configuration errors such as `invalid_client`, `unauthorized_client` or `invalid_request`.
  That refresh token waits 10 seconds (or as long as `Retry-After` says, up to 5 minutes),
  doubling with each failure in a row up to 5 minutes, so a refresh token that keeps failing only
  delays itself. When three different refresh tokens fail with no answer from Subrite in between
  (no new tokens and no rejection), refreshes for that Subrite client pause for 10 seconds,
  growing to at most a minute unless `Retry-After` asks for longer, and one request at a time
  checks whether Subrite is back. The pause does not grow for `500 server_error`, which can be
  one account's bad data, so each broken account adds one pause (10 seconds in a quiet moment, up
  to a minute right after a long outage) plus how long its check waits on Subrite. During an outage the client's pause replaces each refresh token's own wait, so a check
  comes at least once a minute even when only users whose tokens already failed are around. When
  a check finds Subrite back, everyone refreshes right away. Signing out twice while a check runs
  doesn't hold refreshes up, and a clock that steps back never makes a token wait longer than it
  was told to.
- Requests that hold the same refresh token share one refresh within a server process, also
  across the copies of the library that Next.js loads for different routers. When Subrite
  replaced the refresh token, a later request with an old cookie gets the new tokens from memory
  until the new access token is about to expire (`oldCookieGraceSeconds` can shorten this),
  instead of sending the used refresh token again. When Subrite kept it, results are shared for
  30 seconds at most. An expired access token is never handed out. Results are never shared
  between different Subrite servers or clients, and one server is the same however its URL is
  written.
- `refreshAccessToken` reads the token endpoint from Subrite's OpenID configuration, never
  follows redirects (and works on Cloudflare Workers), and authenticates the same way as the sign
  in: HTTP Basic, `client_secret_post` or `none`.
- A token response without `expires_in` keeps the new tokens and assumes 5 minutes, instead of
  throwing away a refresh token Subrite may already have replaced. `expires_in` may be a numeric
  string.
- Network errors are logged with their cause, such as `ECONNREFUSED`.
- The profile picture is read from the standard `picture` claim, falling back to `image`. An
  empty claim counts as missing.
- Works in test environments without `AbortSignal.timeout`, such as Jest 29 with jsdom.
- TypeScript types resolve with `moduleResolution` set to `bundler`, `node16` or `nodenext`, and
  work with `exactOptionalPropertyTypes`. These 0.2.x patterns still compile: a `profile`
  override typed with `SubriteProfile`, or one that returns `undefined` for a missing claim, a
  `client` option in a plain config object, a partial `style`, a config with `httpOptions` passed
  to `refreshAccessToken`, `error: null`, a JWT augmentation that narrows `error` to
  `'RefreshAccessTokenError'`, and a test double for `Subrite()` without `options`. TypeScript 4.9
  can emit declarations for values made with `Subrite()`.
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

[Unreleased]: https://github.com/subrite/subrite-auth/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/subrite/subrite-auth/compare/762342a...v0.3.0
[0.2.1]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.2.1
[0.2.0]: https://github.com/subrite/subrite-auth/commit/44e42f18cd4a41245be7b2231563558f2c356868
[0.1.0]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.1.0
[0.0.2]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.0.2
[0.0.1]: https://www.npmjs.com/package/@subrite/next-auth-provider/v/0.0.1
