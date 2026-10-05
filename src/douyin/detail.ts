import type { DouyinClient } from './client.ts';
import type { DouyinContent, DouyinItem, DouyinResult } from './types.ts';
import type { ContentBlock } from '../reader/content.ts';

/** Display metadata is durable; it must never make an expired playback URL fresh. */
export async function loadDouyinDetail(client: DouyinClient, id: string, supplied?: DouyinItem): Promise<DouyinResult<DouyinContent>> {
  if (supplied?.awemeId === id) return { ok: true, data: { kind: 'video', item: supplied } };
  const local = (await client.listHistory()).find(entry => entry.item.awemeId === id)?.item
    ?? (await client.listSaved()).find(entry => entry.item.awemeId === id)?.item;
  return local ? { ok: true, data: { kind: 'video', item: local } } : client.fetchDetail(id);
}
export function douyinDetailBlocks(content: DouyinContent): ContentBlock[] {
  const video = content.kind === 'video' ? content.item : undefined;
  const description = video?.description ?? (content.kind === 'note' ? content.description : '');
  const author = video?.authorName ?? (content.kind === 'note' ? content.authorName : '');
  return [
    { type: 'text', style: 'title', text: description.trim() || '抖音视频' },
    { type: 'text', style: 'subtitle', text: `作者：${author.trim() || '未知作者'}` },
    { type: 'text', style: 'body', text: video?.likeCount ? `点赞 ${video.likeCount}` : '这是一条来自抖音的信息流内容。' },
    ...(video ? [{ type: 'video' as const, url: video.playUrl || `https://www.douyin.com/video/${video.awemeId}`, poster: video.coverUrl }, {type:'text' as const,style:'quote' as const,text:'点击视频卡片即可播放。'}]
      : content.kind === 'note' ? content.imageUrls.map(url => ({ type: 'image' as const, url })) : []),
  ];
}
