// More 0.2.x code that compiled because the 0.2.1 types were `any` under the bundler and node16
// module resolutions. Found by testing upgrades from 0.2.1. It must keep compiling.
import { Agent } from 'node:https';
import type { NextAuthOptions, TokenSet } from 'next-auth';
import Subrite, {
  generatePostSignOutUrl,
  refreshAccessToken,
  toSubriteJWT,
  type SubriteProfile,
} from '@subrite/next-auth-provider';

// A client registered with client_secret_post, in a plain object shared with the refresh.
const postConfig = {
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  subriteUrl: 'https://example.subrite.no',
  client: { token_endpoint_auth_method: 'client_secret_post' },
};

// Options NextAuth knows, in the object that also goes to refreshAccessToken.
const proxyConfig = {
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  subriteUrl: 'https://example.subrite.no',
  httpOptions: { agent: new Agent() },
};
const signedConfig = {
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  subriteUrl: 'https://example.subrite.no',
  client: { id_token_signed_response_alg: 'RS256' },
};

const withRoles = Subrite({
  ...postConfig,
  // A profile override typed with the 0.2.x type.
  profile(profile: SubriteProfile, tokens: TokenSet) {
    return {
      id: profile.sub,
      name: profile.name,
      email: profile.email,
      image: profile.image,
      ...toSubriteJWT(tokens),
    };
  },
});

export const options: NextAuthOptions = {
  providers: [
    withRoles,
    Subrite(proxyConfig),
    Subrite(signedConfig),
    Subrite({ ...signedConfig, subriteUrl: new URL(signedConfig.subriteUrl) }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        // Clearing the error with null.
        return { ...token, ...toSubriteJWT(account), error: null };
      }
      if (Date.now() < token.accessTokenExpires) {
        return token;
      }
      const refreshed = await refreshAccessToken(token, postConfig);
      await refreshAccessToken(token, signedConfig);
      await refreshAccessToken(token, proxyConfig);
      if (!refreshed.error) {
        refreshed.error = null;
      }
      return refreshed;
    },
  },
};

// The sign out URL built from the provider's own options.
export const signOutUrl = generatePostSignOutUrl(
  withRoles.options.subriteUrl,
  withRoles.options.clientId,
  'https://app.example.com/logout',
);
