import {admitDouyinItem} from './playback-ingress.ts';
import {directDouyinMediaUrl} from './cache-availability.ts';
import {applyPreferredDouyinPlayback} from './playback-selector.ts';
import type {DouyinItem,DouyinVideoVariant} from './types.ts';

/** Only existing authorized HTTP candidates may reach native registration.
 * Do not rewrite signatures, create URLs or request another endpoint. */
export function validatedDouyinPlaybackItem<T extends DouyinItem>(item:T):T {
 if(!item.awemeId||item.awemeId.length>2048)return {...item,playUrl:'',variants:[]};
 const admitted=admitDouyinItem(item);
 if(!admitted)return {...item,playUrl:'',variants:[]};
 item=admitted;
 let changed=false,blockedFallback=false;
 const variants:DouyinVideoVariant[]=[];
 for(const variant of item.variants??[]){
  const urls=[...new Set([variant.playUrl,...(variant.playUrls??[])])].filter(directDouyinMediaUrl);
  const invalidAudio=variant.format==='dash'&&(!variant.audioUrl||!directDouyinMediaUrl(variant.audioUrl));
  if(invalidAudio&&(variant.playUrl===item.playUrl||variant.playUrls?.includes(item.playUrl)))blockedFallback=true;
  if(!urls.length||invalidAudio){changed=true;continue;}
  const identical=urls[0]===variant.playUrl&&(!variant.playUrls||urls.length===variant.playUrls.length&&urls.every((url,i)=>url===variant.playUrls![i]));
  if(!identical)changed=true;
  variants.push(identical?variant:{...variant,playUrl:urls[0],playUrls:urls});
 }
 const fallback=!blockedFallback&&directDouyinMediaUrl(item.playUrl)?item.playUrl:'';
 const source=changed||fallback!==item.playUrl?{...item,playUrl:fallback,variants}:item;
 const preferred=applyPreferredDouyinPlayback(source);
 // Feed parsing precedes runtime HEVC size admission. Preserve valid HTTP
 // metadata for that probe; this does not grant decoder admission.
 return preferred.playUrl?preferred:{...source,playUrl:source.playUrl||variants[0]?.playUrl||''};
}
