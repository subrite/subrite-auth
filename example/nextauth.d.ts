// Read more at: https://next-auth.js.org/getting-started/typescript#module-augmentation
import type { SubriteJWT, SubriteSession } from '../src';

declare module 'next-auth' {
  interface Session extends SubriteSession {}
}

declare module 'next-auth/jwt' {
  interface JWT extends SubriteJWT {}
}
