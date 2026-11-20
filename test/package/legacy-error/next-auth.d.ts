// The 0.2.1 README augmentation, with the error type from NextAuth's refresh token rotation guide.
import { DefaultSession } from 'next-auth';
import { SubriteJWT, SubriteProfile } from '@subrite/next-auth-provider';

declare module 'next-auth' {
  interface User extends SubriteJWT {}

  interface Session {
    user: DefaultSession['user'] & SubriteProfile;
    error?: 'RefreshAccessTokenError';
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends SubriteJWT {
    error?: 'RefreshAccessTokenError';
  }
}
