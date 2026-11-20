// Each @ts-expect-error below fails the type check if the package types resolve to `any`,
// which is what apps got from 0.2.1 under the bundler and node16 module resolutions.
import Subrite, {
  generatePostSignOutUrl,
  isAccessTokenExpired,
  refreshAccessToken,
  resetRefreshState,
  revokeRefreshToken,
  toSubriteJWT,
  type RefreshParams,
  type SignOutOptions,
  type SubriteClaims,
  type SubriteConfig,
  type SubriteAuthMethod,
  type SubriteJWT,
  type SubriteProfile,
  type SubriteProvider,
  type SubriteProviderLike,
  type SubriteSession,
  type SubriteTokenError,
  type SubriteTokens,
  type SubriteUser,
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

// null and undefined clear the error, also with exactOptionalPropertyTypes.
export const cleared: SubriteJWT[] = [
  { ...fromAccount, error: null },
  { ...fromAccount, error: undefined },
];

// A config typed SubriteConfig goes to refreshAccessToken as it is, with the options NextAuth
// knows (also with exactOptionalPropertyTypes).
const typedConfig: SubriteConfig = {
  clientId: 'id',
  clientSecret: 'secret',
  subriteUrl: 'https://a.example',
  httpOptions: { timeout: 5000 },
  client: { token_endpoint_auth_method: 'client_secret_post' },
};
export const refreshedWithConfig = refreshAccessToken(
  { ...fromAccount, error: undefined },
  typedConfig,
);

// The provider keeps its options typed.
export const providerUrl: string = Subrite(typedConfig).options.subriteUrl;
export const provider: SubriteProvider = Subrite(typedConfig);
// Subrite passed as a value gets the signature for test doubles, with `options` optional.
export const mapped: SubriteProviderLike[] = [typedConfig].map(Subrite);
export const mappedUrls: Array<string | undefined> = mapped.map((p) => p.options?.subriteUrl);

// An untyped override that returns missing claims as undefined compiled with 0.2.1 under node10,
// also with exactOptionalPropertyTypes. So does the README's override that keeps the 0.2.x values.
export const untyped: SubriteProvider = Subrite({
  ...typedConfig,
  profile(profile) {
    return { id: profile.sub, name: profile.name, email: profile.email, image: profile.image };
  },
});
export const keeps02x: SubriteProvider = Subrite({
  ...typedConfig,
  profile(claims, tokens) {
    return {
      id: claims.sub,
      name: claims.name,
      email: claims.email,
      image: claims.image,
      ...toSubriteJWT(tokens),
    };
  },
});

Subrite({
  ...typedConfig,
  // @ts-expect-error client metadata keeps its types: the algorithm is a string
  client: { id_token_signed_response_alg: 5 },
});

// Only the three token fields, for apps that map over them.
export const tokenLabels: Record<keyof SubriteTokens, string> = {
  accessToken: 'Access token',
  refreshToken: 'Refresh token',
  accessTokenExpires: 'Expires',
};

export const reset: () => void = resetRefreshState;

export const values = { notANumber, refreshAccessToken, toSubriteJWT };
export type Types = [
  RefreshParams,
  SignOutOptions,
  SubriteAuthMethod,
  SubriteConfig,
  SubriteJWT,
  SubriteProfile,
  SubriteProvider,
  SubriteProviderLike,
  SubriteSession,
  SubriteTokenError,
  SubriteTokens,
  SubriteUser,
];
