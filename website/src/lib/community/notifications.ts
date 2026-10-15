import { communityRequest } from './client';

/** Something that happened to the reader's work: who did it and where, never what they wrote. */
export type HubNotification = {
  id: string; kind: 'comment' | 'reply' | 'fork'; harnessId: string; harnessTitle: string;
  actorName: string; targetId: string; createdAt: string; read: boolean;
};

export const readNotifications = () => communityRequest<{ notifications: HubNotification[]; unread: number }>('notifications');
export const readUnread = async () => (await communityRequest<{ unread: number }>('notifications/unread')).unread;
export const markNotificationsRead = () => communityRequest('notifications/read', { method: 'POST' });

/** What a notification says, and where it leads: the comments it is about, or the fork. */
export function describeNotification({ kind, actorName, harnessTitle, harnessId, targetId }: HubNotification): { text: string; href: string } {
  if (kind === 'fork') return { text: `${actorName} forked ${harnessTitle}`, href: `/hub/${targetId}` };
  const text = kind === 'reply' ? `${actorName} replied to your comment on ${harnessTitle}` : `${actorName} commented on ${harnessTitle}`;
  return { text, href: `/hub/${harnessId}?comments=1` };
}
