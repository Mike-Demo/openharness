import { communityRequest } from './client';

type Like = { liked: boolean; likes: number };

/** Saves the reader's like; the Hub answers with it and the harness's count. */
export const putLike = (id: string, liked: boolean) =>
  communityRequest<Like>(`harnesses/${id}/like`, { method: 'PUT', body: { liked } });
