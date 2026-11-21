import {douyinPlaybackAddresses} from './media-expiry.ts';
import {validatedDouyinPlaybackItem} from './playback-source.ts';
import {formatDouyinDetailFailure} from './errors.ts';
import type { DouyinClient } from './client.ts';
import type { DouyinContent, DouyinItem, DouyinResult } from './types.ts';
import type { ContentBlock } from '../reader/content.ts';

/** Display metadata is durable; it must never make an expired playback URL fresh. */
export async function loadDouyinDetail(client: DouyinClient, id: string, supplied?: DouyinItem): Promise<DouyinResult<DouyinContent>> {
  if (supplied?.awemeId === id) return { ok: true, data: { kind: 'video', item: supplied } };
  const local=await client.findLocalItem(id);
  return local ? { ok: true, data: { kind: 'video', item: local } } : client.fetchDetail(id);
}
/** A local favorite owns metadata and an ID. Only a usable rendition can bypass detail. */
export async function resolveSavedDouyinPlayback(client: Pick<DouyinClient, 'resolvePlayback'>, selected: DouyinItem, now = Date.now): Promise<DouyinItem> {
  const id = selected.awemeId.trim();
  if (!id) throw new Error('收藏缺少视频标识');
  const usable = (item: DouyinItem) => {
    const {expiresAtMs} = douyinPlaybackAddresses(item);
    return item.awemeId === id && !!item.playUrl && (expiresAtMs === undefined || now() < expiresAtMs);
  };
  const local = validatedDouyinPlaybackItem(selected);
  if (usable(local)) return local;

  const refreshed = await client.resolvePlayback(id, { forceRefresh: true, allowDetail: true });
  if (!refreshed.ok) throw Object.assign(new Error(formatDouyinDetailFailure(refreshed.code)), {
    code: refreshed.code, networkFailure: refreshed.networkFailure, httpStatus: refreshed.httpStatus,
  });
  const playback = validatedDouyinPlaybackItem(refreshed.data);
  if (!usable(playback)) throw new Error('详情未返回有效播放地址，请重试');
  return playback;
}
export function douyinDetailBlocks(content: DouyinContent): ContentBlock[] {
  const video = content.kind === 'video' ? content.item : undefined;
  const description = video?.description ?? (content.kind === 'note' ? content.description : '');
  const author = video?.authorName ?? (content.kind === 'note' ? content.authorName : '');
  const likes=video?.likeCount??(content.kind==='note'?content.likeCount:0);
  return [
    { type: 'text', style: 'title', text: description.trim() || (content.kind==='note'?'抖音图文':'抖音视频') },
    { type: 'text', style: 'subtitle', text: `作者：${author.trim() || '未知作者'}` },
    { type: 'text', style: 'body', text: likes ? `点赞 ${likes}` : '这是一条来自抖音的信息流内容。' },
    ...(video ? [{ type: 'video' as const, url: video.playUrl || `https://www.douyin.com/video/${video.awemeId}`, poster: video.coverUrl }, {type:'text' as const,style:'quote' as const,text:'点击视频卡片即可播放。'}]
      : content.kind === 'note' ? content.imageUrls.map(url => ({ type: 'image' as const, url })) : []),
  ];
}
