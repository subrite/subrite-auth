// Copied from the README. scripts/test-package.ts checks that it still matches.
'use client';

import { signIn, useSession } from 'next-auth/react';
import { useEffect } from 'react';

export function SubriteSessionGuard() {
  const { data: session } = useSession();

  useEffect(() => {
    if (session?.error === 'RefreshAccessTokenError') {
      signIn('subrite');
    }
  }, [session?.error]);

  return null;
}
