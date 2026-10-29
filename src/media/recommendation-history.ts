export const RECENT_RECOMMENDATION_LIMIT=512;
/** Oldest-to-newest displayed IDs. A filtered hit never updates recency. */
export function recentRecommendationIds(value:unknown,valid:(id:string)=>boolean):string[] {
  if(!Array.isArray(value))return [];
  return [...new Set(value.filter((id):id is string=>typeof id==='string'&&id.length<=256&&valid(id)))].slice(-RECENT_RECOMMENDATION_LIMIT);
}
export function rememberRecommendationIds(previous:readonly string[],displayed:readonly string[]):string[] {
  const ids=new Set(previous);for(const id of displayed){ids.delete(id);ids.add(id);}
  return [...ids].slice(-RECENT_RECOMMENDATION_LIMIT);
}
