import type {SqlDatabase} from '../core/types.ts';
import type {DouyinRssArchive} from './rss-feed.ts';
import type {DouyinItem} from './types.ts';

// A part and a page of small rows each fit a single portable SQL bridge message.
const PART_CHARS=8192, BATCH_BYTES=48*1024;
const INSERT='INSERT OR REPLACE INTO douyin_rss_session_items(feed,id,part,last,item) VALUES(?,?,?,?,?)';

/** Keep full playback data for any visible list row until that feed session ends. */
export function createDouyinRssArchive(database:()=>Promise<SqlDatabase>):DouyinRssArchive {
  let ready:Promise<SqlDatabase>|undefined;
  function open(){
    return ready??=(async()=>{
      const db=await database();
      await db.transaction([
        {sql:'CREATE TABLE IF NOT EXISTS douyin_rss_session_items (feed INTEGER NOT NULL,id TEXT NOT NULL,part INTEGER NOT NULL,last INTEGER NOT NULL,item TEXT NOT NULL,PRIMARY KEY(feed,id,part))'},
        {sql:'DELETE FROM douyin_rss_session_items'},
      ]);
      return db;
    })().catch(error=>{ready=undefined;throw error;});
  }
  return {
    async write(group,items){
      const db=await open();
      let batch:Parameters<SqlDatabase['transaction']>[0]=[],bytes=0;
      for(const item of items){
        const json=JSON.stringify(item);
        for(let start=0,part=0;start<json.length;part++){
          let end=Math.min(start+PART_CHARS,json.length);
          const lastUnit=json.charCodeAt(end-1);
          if(end<json.length&&lastUnit>=0xd800&&lastUnit<=0xdbff)end--;
          const data=json.slice(start,end);
          // At most three UTF-8 bytes per JS code unit, including quoted JSON escaping.
          const size=INSERT.length+128+3*(data.length+item.awemeId.length);
          if(batch.length&&bytes+size>BATCH_BYTES){await db.transaction(batch);batch=[];bytes=0;}
          batch.push({sql:INSERT,params:[group,item.awemeId,part,Number(end===json.length),data]});
          bytes+=size;start=end;
        }
      }
      if(batch.length)await db.transaction(batch);
    },
    async read(group,id){
      const db=await open(),parts:string[]=[];
      for(let part=0;;part++){
        const [row]=await db.query('SELECT item,last FROM douyin_rss_session_items WHERE feed=? AND id=? AND part=?',[group,id,part]);
        if(!row)return undefined;
        parts.push(String(row.item));
        if(Number(row.last))return JSON.parse(parts.join('')) as DouyinItem;
      }
    },
    async drop(group){await (await open()).execute('DELETE FROM douyin_rss_session_items WHERE feed=?',[group]);},
  };
}
