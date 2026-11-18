// Copied from the README. scripts/test-package.ts checks that it still matches.
import type { NextAuthOptions } from 'next-auth';
import Subrite, {
  isAccessTokenExpired,
  refreshAccessToken,
  revokeRefreshToken,
  toSubriteJWT,
} from '@subrite/next-auth-provider';

const subriteConfig = {
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  subriteUrl: 'your-subrite-url',
};

export const options: NextAuthOptions = {
  providers: [Subrite(subriteConfig)],
  events: {
    // The refresh token keeps working after the user signs out of Subrite, so revoke it.
    async signOut({ token }) {
      await revokeRefreshToken(token, subriteConfig);
    },
  },
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
