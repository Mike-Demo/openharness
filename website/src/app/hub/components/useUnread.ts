'use client';
import { useEffect, useState } from 'react';
import { readUnread } from '@/lib/community/notifications';

/** How many of the reader's notifications are unread: read when signed in, again on returning to the tab. */
export function useUnread(signedIn: boolean | null): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const update = () => { readUnread().then(count => { if (live) setUnread(count); }, () => { /* The bell stays as it was. */ }); };
    update();
    window.addEventListener('focus', update);
    return () => { live = false; window.removeEventListener('focus', update); };
  }, [signedIn]);
  return signedIn ? unread : 0;
}
