// The module augmentation from the 0.2.1 README, unchanged.
// Read more at: https://next-auth.js.org/getting-started/typescript#module-augmentation
import { DefaultSession } from 'next-auth';
import { SubriteJWT, SubriteProfile } from '@subrite/next-auth-provider';

declare module 'next-auth' {
  interface User extends SubriteJWT {}

  interface Session {
    user: DefaultSession['user'] & SubriteProfile;
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends SubriteJWT {}
}
