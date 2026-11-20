import {mediaSourceExpiry} from '@podjs/framework/media-policy';
import {douyinPlaybackMirrors} from './playback-mirrors.ts';
import {douyinPlaybackAudio} from './playback-selector.ts';
import type {DouyinItem} from './types.ts';
/** x-expires is a Unix-second CDN field. Keep the host expiry margin. */
export function douyinMediaExpiry(url:string,resolvedAt:number):number {
  const normalized=url.replace(/([?&])x-expires=/ig,'$1expires=');
  const explicit=/[?&](?:expires|deadline)=\d{9,10}(?:&|$)/i.test(normalized);
  return mediaSourceExpiry([normalized],resolvedAt,explicit?30*60_000:5*60_000);
}

/** A metadata refresh TTL is not a CDN authorization deadline. Only explicit
 * Unix-second fields can stop an already authorized native stream. */
export function douyinMediaNetworkDeadline(urls:readonly string[]):number|undefined {
 const known=urls.map(url=>url.replace(/([?&])x-expires=/ig,'$1expires='))
  .filter(url=>/[?&](?:expires|deadline)=\d{9,10}(?:&|$)/i.test(url));
 return known.length?mediaSourceExpiry(known,0,Number.MAX_SAFE_INTEGER):undefined;
}

export function douyinPlaybackAddressExpired(item:DouyinItem,now=Date.now()):boolean {
 const audioUrl=douyinPlaybackAudio(item);
 const deadline=douyinMediaNetworkDeadline([item.playUrl,...douyinPlaybackMirrors(item),...(audioUrl?[audioUrl]:[])]);
 return deadline!==undefined&&deadline<=now;
}
