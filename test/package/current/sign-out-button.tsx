// Copied from the README. scripts/test-package.ts checks that it still matches.
'use client';

import { generatePostSignOutUrl } from '@subrite/next-auth-provider';

export const SIGN_OUT_STATE_KEY = 'subrite-sign-out-state';

export function SignOutButton() {
  function signOutOfSubrite() {
    const state = crypto.randomUUID();
    sessionStorage.setItem(SIGN_OUT_STATE_KEY, state);
    window.location.href = generatePostSignOutUrl(
      process.env.NEXT_PUBLIC_SUBRITE_URL!,
      process.env.NEXT_PUBLIC_SUBRITE_CLIENT_ID!,
      new URL('/logout', window.location.origin).href,
      { state },
    );
  }

  return <button onClick={signOutOfSubrite}>Sign out</button>;
}
