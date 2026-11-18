// A CommonJS app that loads the package with require().
// eslint-disable-next-line @typescript-eslint/no-require-imports -- this is what the fixture tests
import subrite = require('@subrite/next-auth-provider');

// @ts-expect-error clientId is required
subrite.default({ clientSecret: 'secret', subriteUrl: 'https://example.com' });

export const expired: boolean = subrite.isAccessTokenExpired({ accessTokenExpires: 0 });
