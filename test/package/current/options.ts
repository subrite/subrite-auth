// The NextAuth configuration from the README, as an app would write it.
import type { NextAuthOptions } from 'next-auth';
import Subrite, {
  isAccessTokenExpired,
  refreshAccessToken,
  toSubriteJWT,
} from '@subrite/next-auth-provider';

const subriteConfig = {
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  subriteUrl: 'your-subrite-url',
};

export const options: NextAuthOptions = {
  providers: [Subrite(subriteConfig)],
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
