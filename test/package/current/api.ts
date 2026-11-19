// Each @ts-expect-error below fails the type check if the package types resolve to `any`,
// which is what apps got from 0.2.1 under the bundler and node16 module resolutions.
import Subrite, {
  generatePostSignOutUrl,
  isAccessTokenExpired,
  refreshAccessToken,
  revokeRefreshToken,
  toSubriteJWT,
  type RefreshParams,
  type SignOutOptions,
  type SubriteClaims,
  type SubriteConfig,
  type SubriteJWT,
  type SubriteProfile,
  type SubriteSession,
  type SubriteTokenError,
} from '@subrite/next-auth-provider';

// @ts-expect-error clientId is required
Subrite({ clientSecret: 'secret', subriteUrl: 'https://example.com' });

// @ts-expect-error the margin is a number of seconds
isAccessTokenExpired({ accessTokenExpires: 0 }, '60');

// @ts-expect-error the sign out URL is a string
const notANumber: number = generatePostSignOutUrl('https://a.example', 'id', 'https://b.example');

export const signOutUrl: string = generatePostSignOutUrl('https://a.example', 'id', 'https://b', {
  state: 'state',
});

const params: RefreshParams = {
  subriteUrl: 'https://a.example',
  clientId: 'id',
  clientSecret: 'secret',
  oldCookieGraceSeconds: 30,
};
export const revoked: Promise<boolean> = revokeRefreshToken({ refreshToken: 'r' }, params);

// @ts-expect-error oldCookieGraceSeconds is a number of seconds
export const badParams: RefreshParams = { ...params, oldCookieGraceSeconds: '30' };

// Extra fields, as in the `account` NextAuth passes, are fine.
export const fromAccount: SubriteJWT = toSubriteJWT({
  access_token: 'a',
  refresh_token: 'r',
  expires_at: 1,
  id_token: 'i',
  scope: 'openid offline_access',
});

// Apps may keep their own error values on the token.
export const ownError: SubriteJWT = { ...fromAccount, error: 'MyOwnError' };

export const claims: SubriteClaims = { sub: 'user-1' };

export const values = { notANumber, refreshAccessToken, toSubriteJWT };
export type Types = [
  RefreshParams,
  SignOutOptions,
  SubriteConfig,
  SubriteJWT,
  SubriteProfile,
  SubriteSession,
  SubriteTokenError,
];
