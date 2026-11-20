// Copied from the README. scripts/test-package.ts checks that it still matches.
'use client';

import { signOut, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SIGN_OUT_STATE_KEY } from './sign-out-button';

export default function LogoutPage() {
  const [error, setError] = useState('');
  const [askFirst, setAskFirst] = useState(false);
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    // Wait until NextAuth knows whether the user is signed in.
    if (status === 'loading') return;
    if (status !== 'authenticated') {
      router.push('/');
      return;
    }

    const state = new URLSearchParams(window.location.search).get('state');
    if (state && state === sessionStorage.getItem(SIGN_OUT_STATE_KEY)) {
      signOut({ callbackUrl: '/' }).catch((err) => setError(err.message));
    } else {
      // The sign out did not start here. Let the user decide.
      setAskFirst(true);
    }
  }, [status, router]);

  if (error) return <p>{error}</p>;
  if (askFirst) return <button onClick={() => signOut({ callbackUrl: '/' })}>Sign out</button>;
  return <p>Signing out...</p>;
}
