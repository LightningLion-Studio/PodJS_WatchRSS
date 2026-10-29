import {md5} from './portable.ts';
import type {BiliItem,BiliSession} from './types.ts';
import type {BrowseStore} from './browse.ts';

export const RECOMMENDATION_LIMIT=512;
export const recommendationId=(item:Pick<BiliItem,'aid'|'bvid'>):string|undefined =>
 Number.isSafeInteger(item.aid)&&item.aid!>0?`aid:${item.aid}`:item.bvid?.trim()?`bvid:${item.bvid.trim()}`:undefined;
/** Account IDs survive Cookie rotation. An incomplete session never shares anonymous history. */
export function biliFeedScope(session:BiliSession|null|undefined):string {
 if(!session?.cookies.SESSDATA)return 'anonymous';
 const uid=session.cookies.DedeUserID?.trim();
 return uid&&/^\d+$/.test(uid)&&!/^0+$/.test(uid)?`account:${uid.replace(/^0+/,'')}`:`session:${md5(session.cookies.SESSDATA)}`;
}
export const feedCacheKey=(scope='anonymous')=>`watchrss.bili.feed-cache.v2:${encodeURIComponent(scope)}`;
export const feedSeenKey=(scope='anonymous')=>`watchrss.bili.feed-seen.v1:${encodeURIComponent(scope)}`;
/** Oldest to newest insertion order; only displayed items advance recency. */
export class BiliRecommendationHistory {
 constructor(private store:BrowseStore,private scope:string){}
 read():string[] {
  const raw=this.store.get<unknown>(feedSeenKey(this.scope));
  if(!Array.isArray(raw))return [];
  const valid=raw.filter((id):id is string=>typeof id==='string'&&id.length<=256&&/^(aid:[1-9]\d*|bvid:\S+)$/.test(id));
  return [...new Set(valid)].slice(-RECOMMENDATION_LIMIT);
 }
 remember(items:readonly BiliItem[]) {
  const ids=new Set(this.read());
  for(const item of items){const id=recommendationId(item);if(id){ids.delete(id);ids.add(id);}}
  this.store.set(feedSeenKey(this.scope),[...ids].slice(-RECOMMENDATION_LIMIT));
 }
}
