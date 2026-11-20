// The NextAuth configuration from the 0.2.1 README, with the session error passed on. It must
// keep compiling with an augmentation that narrows `error` to the one value 0.2.1 set.
import { NextAuthOptions } from 'next-auth';
import Subrite, { refreshAccessToken, toSubriteJWT } from '@subrite/next-auth-provider';

const subriteConfig = {
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  subriteUrl: 'your-subrite-url',
};

export const options: NextAuthOptions = {
  providers: [Subrite(subriteConfig)],
  callbacks: {
    async jwt({ token, user, account }) {
      if (account && user) {
        return {
          ...token,
          ...toSubriteJWT(account),
          user,
        };
      }
      if (Date.now() < token.accessTokenExpires) {
        return token;
      }
      return refreshAccessToken(token, subriteConfig);
    },
    async session({ session, token }) {
      if (token.error) {
        session.error = token.error;
      }
      return { ...session, accessToken: token.accessToken };
    },
  },
};
