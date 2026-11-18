// The module augmentation from the README.
import type { SubriteJWT, SubriteSession } from '@subrite/next-auth-provider';

declare module 'next-auth' {
  interface Session extends SubriteSession {}
}

declare module 'next-auth/jwt' {
  interface JWT extends SubriteJWT {}
}
