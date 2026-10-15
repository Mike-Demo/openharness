import Link from 'next/link';
import { Header } from './Header';
import styles from '../community.module.css';

/** A page the Hub says is gone: a harness unpublished, a creator with nothing published. */
export function Unavailable({ what }: { what: string }) {
  return <><Header /><main className={`${styles.wrap} ${styles.empty}`}><h1>This {what} is unavailable.</h1><Link className={styles.textLink} href="/hub">Back to Explore</Link></main></>;
}
