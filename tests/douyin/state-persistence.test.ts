import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import type {SqlDatabase} from '../../src/core/types.ts';
import {DouyinSqlStateStorage,type DouyinStateChange} from '../../src/douyin/state-storage.ts';
import {DouyinHistoryStore,HISTORY_INDEX_KEY,historyRowKey,compactDouyinHistory} from '../../src/douyin/history-store.ts';
import {DouyinFeedStore,FEED_KEY,RECENT_KEY,QUEUE_KEY,PLAYBACK_ITEMS_KEY,snapshotRecordKey,normalizeItems} from '../../src/douyin/feed-store.ts';
import {DouyinClient} from '../../src/douyin/client.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';
const item=(id:string):DouyinItem=>({awemeId:id,description:'title '+id,authorName:'作者🙂',authorId:'discard',createdAtSeconds:9,likeCount:3,commentCount:4,shareCount:5,collectCount:6,playUrl:'https://video/'+id,coverUrl:'https://cover/'+id,durationMs:100,variants:[{playUrl:'https://selected/'+id,codec:'h264',width:960,height:540,bitrate:10}]});
function fixture(){
 const raw=new Database(':memory:'),legacy=new Map<string,string>();let transactions=0,failAt=0,removeFailures=0;const reads:string[]=[],changes:DouyinStateChange[][]=[];
 const db:SqlDatabase={query:async(sql,params=[])=>raw.query(sql).all(...params as any[]) as any,execute:async(sql,params=[])=>{raw.query(sql).run(...params as any[]);},transaction:async statements=>{transactions++;if(failAt===transactions)throw Error('disk failure');raw.transaction(()=>{for(const s of statements)raw.query(s.sql).run(...(s.params??[]) as any[]);})();}};
 const storage=new DouyinSqlStateStorage(async()=>db,{get:async key=>{reads.push(key);return legacy.get(key)??null;},set:async()=>{throw Error('legacy is read-only');},remove:async key=>{if(removeFailures-->0)throw Error('cleanup failure');legacy.delete(key);}});
 const apply=storage.apply.bind(storage);storage.apply=async c=>{changes.push(c.map(x=>({...x})));await apply(c);};
 return {raw,legacy,storage,reads,changes,failNext:()=>failAt=transactions+1,failAfter:(n:number)=>failAt=transactions+n,failCleanup:()=>removeFailures=1};
}
test('migrates complete legacy history to native display fields and native 200/1000 bounds, preserving order, selected URL and times',async()=>{
 const f=fixture();try{
 const entries:{item:DouyinItem&{unneeded?:string};watchedAtMillis:number}[]=Array.from({length:240},(_,i)=>({item:{...item(String(i)),unneeded:'x'.repeat(4000)},watchedAtMillis:1000-i}));entries.splice(2,0,entries[0]!,{item:{...item('invalid'),playUrl:'',variants:[]},watchedAtMillis:1});
 f.legacy.set('douyin.history.v1',JSON.stringify(entries));f.legacy.set('douyin.watched.v1',JSON.stringify([...Array.from({length:1020},(_,i)=>String(i)),'20']));
 const h=new DouyinHistoryStore(f.storage);const actual=await h.list();expect(actual).toHaveLength(200);expect(actual.map(e=>e.item.awemeId)).toEqual(Array.from({length:200},(_,i)=>String(i)));expect(actual[0]).toMatchObject({watchedAtMillis:1000,item:{description:'title 0',authorName:'作者🙂',playUrl:'https://selected/0',variants:[],authorId:'',durationMs:0}});
 const persisted=JSON.parse((await f.storage.get(historyRowKey(0)))!);expect(Object.keys(persisted).sort()).toEqual(['awemeId','title','author','coverUrl','playUrl','likeCount','watchedAt'].sort());expect(JSON.stringify(persisted)).not.toContain('unneeded');expect((await h.watched()).length).toBe(1000);expect((await h.watched()).at(-1)).toBe('20');expect(f.legacy.size).toBe(0);
 const restart=new DouyinHistoryStore(f.storage);expect(await restart.list()).toEqual(actual);expect(await restart.watched()).toEqual(await h.watched());
 }finally{f.raw.close();}
});
test('one playback write updates just one compact row and the index, not old history or other rows; revisits and watched-only keep native semantics',async()=>{
 const f=fixture();try{let h=new DouyinHistoryStore(f.storage);await h.initialize();for(let i=0;i<205;i++)await h.record(item(String(i)),i);
 expect((await h.list()).map(e=>e.item.awemeId)).toEqual(Array.from({length:200},(_,i)=>String(204-i)));
 f.changes.length=0;f.reads.length=0;await h.record({...item('10'),description:'updated'},999);expect(f.changes).toHaveLength(1);expect(f.changes[0]).toHaveLength(2);expect(f.changes[0]![0]!.key).toStartWith('douyin.history.row.v2.');expect(f.changes[0]![0]!.value!.length).toBeLessThan(500);expect(f.reads).toEqual([]);expect((await h.list())[0]).toMatchObject({watchedAtMillis:999,item:{awemeId:'10',description:'updated'}});
 for(let i=0;i<1005;i++)await h.mark('watched-'+i);expect(await h.watched()).toHaveLength(1000);expect((await h.watched())[0]).toBe('watched-5');expect(await h.list()).toHaveLength(200);
 h=new DouyinHistoryStore(f.storage);expect((await h.list())[0]!.item.awemeId).toBe('10');await h.clear();expect(await h.list()).toEqual([]);expect(await h.watched()).toEqual([]);expect(f.raw.query("SELECT count(*) n FROM douyin_local_state WHERE key LIKE 'douyin.history.row.v2.%'").get()).toEqual({n:0});
 }finally{f.raw.close();}
});
test('migration interruption never publishes partial rows or removes legacy input; retry is idempotent',async()=>{
 const f=fixture();try{const input=JSON.stringify(Array.from({length:25},(_,i)=>({item:item(String(i)),watchedAtMillis:i})));f.legacy.set('douyin.history.v1',input);f.failAfter(2);
 await expect(new DouyinHistoryStore(f.storage).initialize()).rejects.toThrow('disk failure');expect(await f.storage.get(HISTORY_INDEX_KEY)).toBeNull();expect(f.legacy.get('douyin.history.v1')).toBe(input);
 const h=new DouyinHistoryStore(f.storage);expect(await h.list()).toHaveLength(25);expect(f.legacy.has('douyin.history.v1')).toBe(false);
 }finally{f.raw.close();}
});
test('cleanup interruption retries the published migration, never reimports stale legacy over new history',async()=>{
 const f=fixture();try{f.legacy.set('douyin.history.v1',JSON.stringify([{item:item('old'),watchedAtMillis:1}]));f.failCleanup();await expect(new DouyinHistoryStore(f.storage).initialize()).rejects.toThrow('cleanup failure');expect(await f.storage.get(HISTORY_INDEX_KEY)).not.toBeNull();
 const h=new DouyinHistoryStore(f.storage);await h.record(item('new'),2);expect((await h.list()).map(e=>e.item.awemeId)).toEqual(['new','old']);expect(f.legacy.size).toBe(0);
 }finally{f.raw.close();}
});
test('failed update rolls back row and index together; concurrent clear is ordered and cannot resurrect history',async()=>{
 const f=fixture();try{const h=new DouyinHistoryStore(f.storage);await h.record(item('a'),1);f.failNext();await expect(h.record({...item('a'),description:'wrong'},2)).rejects.toThrow('disk failure');expect((await h.list())[0]!.item.description).toBe('title a');
 await Promise.all([h.record(item('b'),3),h.record(item('c'),4),h.clear()]);expect(await h.list()).toEqual([]);expect(await h.watched()).toEqual([]);
 f.legacy.set('douyin.history.v1','broken');await h.clear();expect(await new DouyinHistoryStore(f.storage).list()).toEqual([]);
 }finally{f.raw.close();}
});
test('invalid old history is retained on migration failure; no empty success marker hides it',async()=>{
 const f=fixture();try{f.legacy.set('douyin.history.v1','{');await expect(new DouyinHistoryStore(f.storage).initialize()).rejects.toThrow();expect(f.legacy.get('douyin.history.v1')).toBe('{');expect(await f.storage.get(HISTORY_INDEX_KEY)).toBeNull();}finally{f.raw.close();}
});
test('playback snapshots incrementally share full item records, retain fresher variants and anchor/order across restart, and collect only unreferenced rows',async()=>{
 const f=fixture();try{let feed=new DouyinFeedStore(f.storage);const items=Array.from({length:40},(_,i)=>item(String(i))),snapshot={items,cursor:'tail',hasMore:true,anchorAwemeId:'10',savedAtMillis:100,resolved:Object.fromEntries(items.map(x=>[x.awemeId,100]))};await feed.save(QUEUE_KEY,snapshot);
 f.changes.length=0;await feed.save(QUEUE_KEY,{...snapshot,anchorAwemeId:'11'});expect(f.changes.flat().some(c=>c.key.startsWith('douyin.playback-item.v2.'))).toBe(false);
 items[2]!.description='in-place update';await feed.save(QUEUE_KEY,{...snapshot,anchorAwemeId:'11'});expect((await feed.read(QUEUE_KEY)).items[2]!.description).toBe('in-place update');
 const newer={...items[0]!,playUrl:'https://new',variants:[]};await feed.save(FEED_KEY,{...snapshot,items:[newer],resolved:{'0':200}});await feed.save(RECENT_KEY,{...snapshot,items:[items[0]!],anchorAwemeId:'0',resolved:{'0':100}});
 feed=new DouyinFeedStore(f.storage);expect((await feed.bootstrap()).items[0]!.playUrl).toBe('https://new');const restored=await feed.read(QUEUE_KEY);expect(restored.items.slice(1)).toEqual(items.slice(1).map(x=>({...x,playUrl:'https://selected/'+x.awemeId})));expect(restored).toMatchObject({anchorAwemeId:'11',cursor:'tail',hasMore:true});
 await feed.save(QUEUE_KEY,{...snapshot,items:[items[1]!],anchorAwemeId:'1'});expect(JSON.parse((await f.storage.get(PLAYBACK_ITEMS_KEY))!).sort()).toEqual(['0','1']);await feed.clear();expect((await feed.read(QUEUE_KEY)).items).toEqual([]);expect(f.raw.query('SELECT count(*) n FROM douyin_local_state').get()).toEqual({n:0});
 }finally{f.raw.close();}
});
test('legacy queue migration keeps complete playback metadata and refuses cleanup until the new snapshot commits',async()=>{
 const f=fixture();try{const legacy={items:[item('a'),item('b')],anchorAwemeId:'b',cursor:'c',hasMore:false,savedAtMillis:1,resolved:{a:1,b:1}};f.legacy.set(QUEUE_KEY,JSON.stringify(legacy));f.failNext();await expect(new DouyinFeedStore(f.storage).read(QUEUE_KEY)).rejects.toThrow('disk failure');expect(f.legacy.has(QUEUE_KEY)).toBe(true);expect(await f.storage.get(snapshotRecordKey(QUEUE_KEY))).toBeNull();
 const feed=new DouyinFeedStore(f.storage),restored=await feed.read(QUEUE_KEY);expect(restored.items.map(x=>x.playUrl)).toEqual(['https://selected/a','https://selected/b']);expect(restored.items[0]!.variants).toEqual(item('a').variants);expect(restored).toMatchObject({anchorAwemeId:'b',cursor:'c',hasMore:false,resolved:{a:1,b:1}});expect(f.legacy.has(QUEUE_KEY)).toBe(false);
 }finally{f.raw.close();}
});
test('production-default client uses incremental worker storage without a clock/signer injection or remote history request',async()=>{
 const f=fixture();try{let requests=0;const secure={get:async()=>null,set:async()=>{},remove:async()=>{}};const client=new DouyinClient({secureStorage:secure,historyStorage:f.storage,transport:{request:async()=>{requests++;throw Error('no network');}}});await client.prepareHistory();const start=Date.now();await client.recordHistory(item('default'));expect((await client.listHistory())[0]!.watchedAtMillis).toBeGreaterThanOrEqual(start);expect(requests).toBe(0);expect(compactDouyinHistory(item('default'),1)!.playUrl).toBe('https://selected/default');}finally{f.raw.close();}
});

test('native validity rejects an empty selected playUrl; unsupported old HEVC does not erase display history',()=>{
 expect(compactDouyinHistory({...item('invalid'),playUrl:' '},1)).toBeNull();
 const hevc={...item('old'),variants:[{playUrl:'https://video/old',codec:'h265' as const,width:960,height:540,bitrate:10}]};
 expect(compactDouyinHistory(hevc,1)).toMatchObject({awemeId:'old',playUrl:'https://video/old'});
});

test('preferred playback memo retains unchanged DTO identity, but scalar or in-place variant changes invalidate it',()=>{
 const video=item('memo');const selected=normalizeItems([video])[0]!;expect(normalizeItems([video])[0]).toBe(selected);
 video.description='new';expect(normalizeItems([video])[0]!.description).toBe('new');
 video.variants[0]!.playUrl='https://new-selected';expect(normalizeItems([video])[0]!.playUrl).toBe('https://new-selected');
 video.variants.push({codec:'h264',playUrl:'https://better',width:960,height:540,bitrate:20});expect(normalizeItems([video])[0]!.playUrl).toBe('https://better');
 video.awemeId='  trim  ';expect(normalizeItems([video])[0]!.awemeId).toBe('trim');
});
