import type {DouyinItem} from './types.ts';
/** Race only one alternate from the selected rendition. A different codec, quality
 * or item is never a byte-identical mirror. Old persisted items safely use one URL. */
export function douyinPlaybackMirrors(item:DouyinItem):string[]{
 const variant=item.variants?.find(v=>v.playUrl===item.playUrl||v.playUrls?.includes(item.playUrl));
 if(!variant)return [];
 const scheme=item.playUrl.match(/^https?:/i)?.[0].toLowerCase();
 return [...new Set([variant.playUrl,...(variant.playUrls??[])])]
  .filter(url=>url!==item.playUrl&&url.match(/^https?:/i)?.[0].toLowerCase()===scheme).slice(0,1);
}
