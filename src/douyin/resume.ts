import { DouyinPlaybackQueue } from './playback-queue.ts';
import type { DouyinClient } from './client.ts';

/** Resume the exact secure snapshot. URL expiry is handled by playback recovery, not startup. */
export async function restoreDouyinQueue(client: DouyinClient, awemeId: unknown, immersive = false) {
  const saved = await client.restorePlaybackQueue();
  const item = saved.items.find(item => item.awemeId === awemeId);
  if (!item || saved.anchorAwemeId !== item.awemeId) return null;
  const queue = new DouyinPlaybackQueue(client, {
    items: saved.items, selectedAwemeId: item.awemeId,
    cursor: saved.cursor, hasMore: saved.hasMore,
    // Restoring an existing queue must not apply the 40-item new-feed window again.
    limit: 200, fixedSources: !immersive,
  });
  return { item, queue };
}
