import {recentRecommendationIds,rememberRecommendationIds} from '../media/recommendation-history.ts';
import {sm3} from './signing.ts';
import type {DouyinItem,DouyinSecureStorage} from './types.ts';

export const douyinFeedSeenKey=(cookie:string)=>{
  const uid=cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('uid_tt='))?.slice(7);
  const identity=uid&&/^\d+$/.test(uid)?`uid:${uid}`:`session:${cookie}`;
  return `douyin.feed-seen.v1.${sm3(identity).map(v=>v.toString(16).padStart(2,'0')).join('')}`;
};
export async function readDouyinSeenIds(store:DouyinSecureStorage,key:string):Promise<string[]>{
  try{const raw=await store.get(key);return raw&&raw.length<=140_000?recentRecommendationIds(JSON.parse(raw),id=>!!id.trim()&&!/\s/.test(id)):[];}catch{return [];}
}
export function filterDouyinRecommendations(items:readonly DouyinItem[],previous:readonly string[]) {
  const seen=new Set(previous),fresh:DouyinItem[]=[];let filteredCount=0;
  for(const item of items){if(seen.has(item.awemeId)){filteredCount++;continue;}seen.add(item.awemeId);fresh.push(item);}
  return {items:fresh,ids:rememberRecommendationIds(previous,fresh.map(item=>item.awemeId)),filteredCount};
}
