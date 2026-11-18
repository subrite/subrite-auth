// Each @ts-expect-error below fails the type check if the package types resolve to `any`,
// which is what apps got from 0.2.1 under the bundler and node16 module resolutions.
import Subrite, {
  generatePostSignOutUrl,
  isAccessTokenExpired,
  refreshAccessToken,
  toSubriteJWT,
  type RefreshParams,
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

export const values = { notANumber, refreshAccessToken, toSubriteJWT };
export type Types = [
  RefreshParams,
  SubriteConfig,
  SubriteJWT,
  SubriteProfile,
  SubriteSession,
  SubriteTokenError,
];
