import {test,expect} from 'bun:test';
import {fixture,sha} from './ble-v2-fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
test('large imported libraries resolve persisted save bindings with linear work',async()=>{
 const f=await fixture();const count=500;let stateIdReads=0;
 try{
  const source='https://watchrss.local/import-txt-novel/0123456789abcdef0123456789abcdef';
  f.sql.query("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,'书',10,1)").run(source);
  f.sql.transaction(()=>{for(let i=1;i<=count;i++){
   const url=source+'/chapter/'+String(i).padStart(4,'0')+'-0123456789abcdef';
   f.sql.query("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(?,1,?,'body',?,?,100)").run(i,'章'+i,url,'local'+i);
   f.sql.query("INSERT INTO sync_saved_states(article_id,save_type,item_id,url,saved,changed_at,sort_order,source_device_id,source_order) VALUES(?,'favorite',?,?,0,0,0,'watch','watch')").run(sha(url),i,url);
  }})();
  const db={...f.db,query:async(q:string,p:readonly unknown[]=[])=>{const rows=await f.db.query(q,p);return q.startsWith('SELECT * FROM sync_saved_states ORDER BY')?rows.map(row=>new Proxy(row,{get(target,key){if(key==='article_id')stateIdReads++;return Reflect.get(target,key);}})):rows;}};
  const window=await new SqlLibrarySessionRepository(db,f.ports).prepareWindow('phone',0);
  expect(window.fullArticleManifest).toHaveLength(count);expect(window.fullArticleManifest.every(a=>a.bodyAvailable&&!a.deleted)).toBe(true);
  console.log('SNAPSHOT_STATE_LOOKUPS',JSON.stringify({articles:count,stateIdReads}));expect(stateIdReads).toBeLessThan(count*20);
 }finally{f.sql.close();}
});
