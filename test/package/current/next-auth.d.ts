// Copied from the README. scripts/test-package.ts checks that it still matches.
// next-auth.d.ts
// Read more at: https://next-auth.js.org/getting-started/typescript#module-augmentation
import type { SubriteJWT, SubriteSession } from '@subrite/next-auth-provider';

declare module 'next-auth' {
  interface Session extends SubriteSession {}
}

declare module 'next-auth/jwt' {
  interface JWT extends SubriteJWT {}
}
