'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, Link2 } from 'lucide-react';
import { harnessPath } from '@/lib/community/slug';
import styles from '../community.module.css';

type Copy = 'idle' | 'copied' | 'failed';
const labels: Record<Copy, string> = { idle: 'Share', copied: 'Link copied', failed: 'Copy failed' };

const touch = '(pointer: coarse)';
const onPointerChange = (notify: () => void) => {
  const query = window.matchMedia?.(touch);
  query?.addEventListener('change', notify);
  return () => query?.removeEventListener('change', notify);
};
/**
 * A touch screen with a share sheet uses it. A mouse copies the link, even where the browser has a
 * sheet too (Safari and Chrome on a Mac): the Hub's web is mouse-first. The server draws the copy.
 */
function useShareSheet() {
  return useSyncExternalStore(onPointerChange, () => typeof navigator.share === 'function' && !!window.matchMedia?.(touch).matches, () => false);
}

/** Shares the harness's address: the phone's sheet, or a copied link that says so for two seconds. */
export function ShareButton({ harness }: { harness: { id: string; title: string } }) {
  const [copy, setCopy] = useState<Copy>('idle'), sheet = useShareSheet();
  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => setCopy('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copy]);
  async function share() {
    const url = `${window.location.origin}${harnessPath(harness)}`, title = harness.title;
    if (sheet) {
      // A sheet closed without choosing anything is not a failure to report.
      await navigator.share({ title, url }).catch(() => undefined);
      return;
    }
    try { await navigator.clipboard.writeText(url); setCopy('copied'); } catch { setCopy('failed'); }
  }
  return <button type="button" aria-label={sheet ? 'Share this harness' : 'Copy link to this harness'} onClick={() => void share()}>
    {copy === 'copied' ? <Check /> : <Link2 />}<span className={styles.actionLabel} aria-live="polite">{labels[copy]}</span>
  </button>;
}
