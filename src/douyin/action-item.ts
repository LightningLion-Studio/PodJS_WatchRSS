import type { DouyinItem } from './types.ts';

/** Persist display/save metadata only. Playback freshness is always resolved separately. */
export function douyinActionItem(value: unknown, awemeId: string): DouyinItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (raw.awemeId !== awemeId || !awemeId.trim() || typeof raw.description !== 'string' || typeof raw.authorName !== 'string') return;
  const string = (key: string) => typeof raw[key] === 'string' ? raw[key] as string : '';
  const number = (key: string) => typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? Math.max(0, raw[key] as number) : 0;
  return { awemeId, description: string('description'), authorName: string('authorName'), authorId: string('authorId'),
    ...(string('authorAvatar') ? { authorAvatar: string('authorAvatar') } : {}), ...(string('coverUrl') ? { coverUrl: string('coverUrl') } : {}), playUrl: string('playUrl'),
    createdAtSeconds: number('createdAtSeconds'), durationMs: number('durationMs'), likeCount: number('likeCount'),
    commentCount: number('commentCount'), shareCount: number('shareCount'), collectCount: number('collectCount'), variants: [] };
}
