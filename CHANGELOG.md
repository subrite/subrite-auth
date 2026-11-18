# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/)
and this project adheres to [Semantic Versioning](http://semver.org/).

## [Unreleased]

### Breaking

- Requires Node.js 24 or later.
- Requires `next-auth` 4.24.15 or later. Older versions have known security issues.
- The provider no longer puts the tokens on the NextAuth `User`. Read them from `account` in the
  `jwt` callback with `toSubriteJWT` (as the README shows). This stops stale copies of the tokens
  piling up in the session cookie.
- `SubriteProfile` no longer extends `SubriteJWT`, and `name`, `email` and `image` are optional.
  Use the new `SubriteSession` type to augment `Session` (see the README).
- A path in `subriteUrl` is now kept. `https://example.com/tenant` gives
  `https://example.com/tenant/api/oidc/...`. Before, the path was dropped.

### Added

- `isAccessTokenExpired(token, marginSeconds = 60)`. Refreshes a little before the access token
  expires, so it doesn't run out in the middle of a request.
- `SubriteSession` and `SubriteTokenError` types.
- `refreshAccessToken` takes an optional `timeoutMs` (default 10 seconds) and `client`.

### Fixed

- `refreshAccessToken` no longer writes tokens to the log when Subrite sends an unexpected
  response.
- A temporary failure (network error, timeout, 5xx, 429) no longer marks the session with
  `RefreshAccessTokenError`. The token is left as is and the refresh is tried again after 10
  seconds.
- When Subrite rejects the refresh token, the token is marked with `RefreshAccessTokenError`, the
  rejected refresh token is removed, and Subrite is not called again for that session.
- Sessions that 0.2.1 marked with `RefreshAccessTokenError` after a temporary failure recover on
  the next refresh. 0.2.1 never removed the mark.
- Parallel requests in the same server process share one refresh, so a rotated refresh token is
  never sent twice. Results are never shared between different Subrite servers or clients.
- `refreshAccessToken` reads the token endpoint from Subrite's OpenID configuration, and
  authenticates the same way as the sign in (HTTP Basic, unless Subrite only supports
  `client_secret_post`).
- The profile picture is read from the standard `picture` claim, falling back to `image`.
- TypeScript types now resolve with `moduleResolution` set to `bundler`, `node16` or `nodenext`.
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

- Added documentaion
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
