import {RECENT_RECOMMENDATION_LIMIT,recentRecommendationIds,rememberRecommendationIds} from '../media/recommendation-history.ts';
import {md5} from './portable.ts';
import type {BiliItem,BiliSession} from './types.ts';
import type {BrowseStore} from './browse.ts';

export const RECOMMENDATION_LIMIT=RECENT_RECOMMENDATION_LIMIT;
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
  return recentRecommendationIds(raw,id=>/^(aid:[1-9]\d*|bvid:\S+)$/.test(id));
 }
 remember(items:readonly BiliItem[]) {
  this.store.set(feedSeenKey(this.scope),rememberRecommendationIds(this.read(),items.map(recommendationId).filter((id):id is string=>!!id)));
 }
}
