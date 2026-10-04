import type {AppServices,Article} from "./service.ts";

// Keep each host SQLite reply well below its 512 KiB payload limit. A single
// 201-row query can exceed it when previews contain several KiB of HTML.
const QUERY_ROWS=24;

export async function loadFeedWindow(
  listArticles:AppServices["listArticles"],channelId:string,visibleCount:number,
):Promise<{items:Article[];hasMore:boolean}> {
  const limit=Math.max(1,Math.min(200,Math.floor(visibleCount)));
  const rows:Article[]=[];
  while(rows.length<=limit) {
    const count=Math.min(QUERY_ROWS,limit+1-rows.length);
    const chunk=await listArticles({channelId,offset:rows.length,pageSize:count});
    rows.push(...chunk);
    if(chunk.length<count)break;
  }
  return {items:rows.slice(0,limit),hasMore:rows.length>limit};
}
