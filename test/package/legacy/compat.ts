// Other patterns apps used with 0.2.x, with the 0.2.x type augmentation. They must still compile.
import type { NextAuthOptions } from 'next-auth';
import Subrite, { refreshAccessToken } from '@subrite/next-auth-provider';

const subriteConfig = {
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  subriteUrl: 'https://example.subrite.no',
};

export const options: NextAuthOptions = {
  providers: [Subrite(subriteConfig)],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // The tokens taken from `user` on sign in.
        return {
          ...token,
          accessToken: user.accessToken,
          refreshToken: user.refreshToken,
          accessTokenExpires: user.accessTokenExpires,
        };
      }
      if (Date.now() < token.accessTokenExpires) {
        return token;
      }
      const refreshed = await refreshAccessToken(token, subriteConfig);
      // An app's own error values.
      return refreshed.error ? { ...refreshed, error: 'SignInAgain' } : refreshed;
    },
    async session({ session, token }) {
      // The 0.2.x augmentation typed session.user with the token fields.
      const previous: string = session.user.accessToken;
      return { ...session, user: { ...session.user, accessToken: token.accessToken ?? previous } };
    },
  },
};
