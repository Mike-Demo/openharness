'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CommunityError } from '@/lib/community/client';
import { describeNotification, markNotificationsRead, readNotifications, type HubNotification } from '@/lib/community/notifications';
import { Header, SignIn } from '../components/Header';
import styles from '../community.module.css';

const day = (createdAt: string) => new Date(createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** The reader's notifications, latest first; opening the page marks them read (what was new stays bold here). */
export default function NotificationsPage() {
  const [items, setItems] = useState<HubNotification[] | null>(null), [signedOut, setSignedOut] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    readNotifications().then(({ notifications, unread }) => {
      if (!live) return;
      setItems(notifications);
      if (unread) void markNotificationsRead().catch(() => { /* They stay unread for next time. */ });
    }, (e: unknown) => {
      if (!live) return;
      if (e instanceof CommunityError && e.status === 401) setSignedOut(true);
      else setError('Your notifications could not be loaded.');
    });
    return () => { live = false; };
  }, []);
  return <><Header /><main className={`${styles.wrap} ${styles.publish}`}>
    <h1>Notifications</h1>
    {signedOut && <SignIn action="see your notifications" />}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {items && !items.length && <p className={styles.notice}>When someone comments on, replies to or forks your work, you will see it here.</p>}
    {items?.map(item => {
      const { text, href } = describeNotification(item);
      return <Link key={item.id} href={href} className={`${styles.notification} ${item.read ? '' : styles.unread}`}><span>{text}</span><small>{day(item.createdAt)}</small></Link>;
    })}
  </main></>;
}
