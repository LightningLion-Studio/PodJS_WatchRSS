import { expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type {SqlDatabase} from '../src/core/types.ts';
import {createDouyinRssArchive} from '../src/douyin/rss-archive.ts';
import { DouyinRssFeedController } from '../src/douyin/rss-feed.ts';
import { DouyinActionsController } from '../src/douyin/actions.ts';
import { captureActivityNavigation, restoreActivityNavigation } from '../src/navigation/activity-navigation.ts';
import type { DouyinItem, DouyinFeedPage, DouyinResult, DouyinContent } from '../src/douyin/types.ts';
const item = (awemeId: string): DouyinItem => ({awemeId, description:`title ${awemeId}`, authorName:'author', authorId:'u', playUrl:'signed-url', coverUrl:'cover', createdAtSeconds:1, likeCount:2, commentCount:3, shareCount:4, collectCount:5, durationMs:6, variants:[]});
const deferred = <T>() => { let resolve!: (value:T)=>void; const promise = new Promise<T>(r=>resolve=r); return {promise,resolve}; };

test('RSS deduplicates within/across pages, retains earliest rows beyond 40 and refresh replaces', async () => {
 let page=0; const cursors:unknown[]=[];
 const c=new DouyinRssFeedController({fetchFeedPage:async input=>{cursors.push(input?.cursor);const start=page++*15;return {ok:true,data:{items:Array.from({length:20},(_,i)=>item(String(start+i))).concat(item(String(start))),nextCursor:String(page),hasMore:page<4}};}});
 await c.refresh(); await c.loadMore(); await c.loadMore(); await c.loadMore(); await c.loadMore();
 expect(c.state.items).toHaveLength(65);expect(c.state.items[0]!.awemeId).toBe('0');expect(new Set(c.state.items.map(i=>i.awemeId)).size).toBe(65);
 expect(cursors).toEqual([undefined,'1','2','3']);expect(c.hasMore).toBe(false);
 await c.refresh();expect(c.state.items).toHaveLength(20);expect(c.state.items[0]!.awemeId).toBe('60');
});
test('RSS concurrent loads coalesce; errors unlock retry; disposal ignores responses',async()=>{
 const pending=deferred<DouyinResult<DouyinFeedPage>>();let calls=0,saves=0;
 const c=new DouyinRssFeedController({fetchFeedPage:()=>{calls++;return pending.promise;}},undefined,()=>{},()=>{saves++;});
 const work=c.refresh();await c.loadMore();expect(c.loading).toBe(true);expect(calls).toBe(1);
 c.dispose();pending.resolve({ok:true,data:{items:[item('a')],nextCursor:null,hasMore:false}});await work;expect(saves).toBe(0);expect(c.state.items).toEqual([]);
 const fail=new DouyinRssFeedController({fetchFeedPage:async()=>{throw Error('offline');}});await fail.refresh();expect(fail.loading).toBe(false);expect(fail.state.error).toContain('offline');
});
test('actions save existing item before network finishes and retain title on failure; late state cannot undo toggle',async()=>{
 const remote=deferred<DouyinResult<DouyinContent>>(),savedState=deferred<{favorite:boolean;watchLater:boolean}>();const done:string[]=[],saved:DouyinItem[]=[];
 const c=new DouyinActionsController({fetchDetail:()=>remote.promise,getSavedState:()=>savedState.promise,toggleSaved:async value=>{saved.push(value);return true;}},'a',item('a'),()=>{},kind=>done.push(kind));
 const load=c.load();await c.toggle('favorite');expect(saved[0]!.description).toBe('title a');expect(done).toEqual(['favorite']);
 savedState.resolve({favorite:false,watchLater:false});remote.resolve({ok:false,code:'REQUEST_FAILED',message:'offline'});await load;
 expect(c.state.favorite).toBe(true);expect(c.state.item!.description).toBe('title a');await c.toggle('watchLater');c.shared();expect(done).toEqual(['favorite','watchLater','share']);
});
test('actions ID-only fallback fetches; failed mutation does not notify; disposed response ignored',async()=>{
 const remote=deferred<DouyinResult<DouyinContent>>();let done=0;
 const c=new DouyinActionsController({fetchDetail:()=>remote.promise,getSavedState:async()=>({favorite:false,watchLater:false}),toggleSaved:async()=>{throw Error('disk');}},'a',item('wrong'),()=>{},()=>done++);
 expect(c.state.item).toBeUndefined();const load=c.load();remote.resolve({ok:true,data:{kind:'video',item:item('a')}});await load;await c.toggle('favorite');expect(done).toBe(0);expect(c.state.message).toContain('disk');
 const late=deferred<DouyinResult<DouyinContent>>();const disposed=new DouyinActionsController({fetchDetail:()=>late.promise,getSavedState:async()=>({favorite:false,watchLater:false}),toggleSaved:async()=>true},'a');const work=disposed.load();disposed.dispose();late.resolve({ok:true,data:{kind:'video',item:item('a')}});await work;expect(disposed.state.item).toBeUndefined();
});
test('M1 process restoration retains action save metadata without signed URLs; malformed item falls back to ID',()=>{
 const state=captureActivityNavigation({saved:{},retained:{}},[{page:'home'},{page:'douyin',douyinRoute:{name:'actions',awemeId:'a',item:item('a')}}]);
 const restored=restoreActivityNavigation(JSON.parse(JSON.stringify(state)))!;
 expect(restored[1]!.douyinRoute).toMatchObject({name:'actions',awemeId:'a',item:{description:'title a',authorName:'author',likeCount:2,coverUrl:'cover',playUrl:''}});
 expect(JSON.stringify(state)).not.toContain('signed-url');
 const bad=captureActivityNavigation({saved:{},retained:{}},[{page:'home'},{page:'douyin',douyinRoute:{name:'actions',awemeId:'a',item:item('b')}}]);
 expect(restoreActivityNavigation(bad)![1]!.douyinRoute).toEqual({name:'actions',awemeId:'a'});
});

test('detail star waits for durable success, ignores stale reads and does not flip on failure',async()=>{
 const {DouyinFavoriteController}=await import('../src/douyin/favorite.ts');
 const read=deferred<{favorite:boolean;watchLater:boolean}>(),write=deferred<boolean>();let writes=0;
 const c=new DouyinFavoriteController({getSavedState:()=>read.promise,toggleSaved:()=>{writes++;return write.promise;}},'a');
 const refresh=c.refresh(),toggle=c.toggle(item('a'));await c.toggle(item('a'));expect(writes).toBe(1);expect(c.state.favorite).toBe(false);
 write.resolve(true);await toggle;read.resolve({favorite:false,watchLater:false});await refresh;expect(c.state.favorite).toBe(true);
 const failure=new DouyinFavoriteController({getSavedState:async()=>({favorite:true,watchLater:false}),toggleSaved:async()=>{throw Error('disk full');}},'a');await failure.refresh();await failure.toggle(item('a'));expect(failure.state.favorite).toBe(true);expect(failure.state.message).toContain('disk full');
});

test('long RSS sessions keep every item selectable while older codec and mirror lists leave the guest rows',async()=>{
 const stored=new Map<string,DouyinItem>(),released:number[]=[];
 const archive={write:async(_group:number,items:DouyinItem[])=>{for(const row of items)stored.set(row.awemeId,structuredClone(row));},read:async(_group:number,id:string)=>stored.get(id),drop:async(group:number)=>{released.push(group);}};
 let page=0;
 const originals=Array.from({length:90},(_,i)=>({...item(String(i)),variants:[{playUrl:'https://cdn/'+i,codec:'h264',bitrate:100,width:320,height:240,playUrls:['https://mirror/'+i]}]} as DouyinItem));
 const c=new DouyinRssFeedController({fetchFeedPage:async()=>({ok:true,data:{items:originals.slice(page*10,++page*10),nextCursor:String(page),hasMore:true}})},undefined,()=>{},()=>{},archive);
 for(let i=0;i<9;i++)await c.loadMore();
 expect(c.state.items).toHaveLength(90);expect(stored.has('0')).toBe(true);expect(c.state.items[0]).not.toHaveProperty('variants');
 expect(await c.item('0')).toEqual(originals[0]);expect(await c.item('89')).toEqual(originals[89]);
});

test('existing RSS rows are not measured again when another page arrives; width and content invalidate layout',async()=>{
 const {createFeedCardLayouts}=await import('../src/ui/feed-card-layout.ts');
 const first={id:'1',title:'retained title',content:'',read:true,excerpt:'summary'};
 let calls=0;const measure=(_slot:number)=>(text:string)=>{calls++;return 8*text.length;};
 const layout=createFeedCardLayouts(measure);
 const before=layout.get(first,197,0,15);expect(calls).toBeGreaterThan(0);
 layout.get({...first,id:'2'},197,0,15);calls=0;
 expect(layout.get(first,197,0,15)).toBe(before);expect(calls).toBe(0);
 expect(layout.get(first,204,0,15)).not.toBe(before);expect(calls).toBeGreaterThan(0);
 first.title='a new title';calls=0;layout.get(first,204,0,15);expect(calls).toBeGreaterThan(0);
});

test('RSS SQLite archive batches a page, isolates retained lists and clears retired or stale rows',async()=>{
 const raw=new Database(':memory:');let writes=0;
 const db:SqlDatabase={
  query:async(q,p=[])=>raw.query(q).all(...p as SQLQueryBindings[]) as Record<string,unknown>[],
  execute:async(q,p=[])=>{writes++;raw.run(q,p as SQLQueryBindings[]);},
  transaction:async statements=>{writes++;raw.transaction(()=>{for(const {sql,params=[]} of statements){
    if(params.some(v=>typeof v==='string'&&v.length>12*1024))throw Error('oversized test bridge message');
    raw.run(sql,params as SQLQueryBindings[]);
   }})();},
 };
 try{
  const archive=createDouyinRssArchive(async()=>db),first=Array.from({length:12},(_,i)=>({...item(String(i)),description:'中文 😀 '+i}));
  await archive.write(1,first);expect(writes).toBe(2);expect(await archive.read(1,'0')).toEqual(first[0]);
  const large={...item('large'),description:'😀'.repeat(20000)};
  await archive.write(1,[large]);expect(await archive.read(1,'large')).toEqual(large);
  await archive.write(2,[{...first[0]!,description:'another feed'}]);await archive.drop(1);
  expect(await archive.read(1,'0')).toBeUndefined();expect((await archive.read(2,'0'))?.description).toBe('another feed');
  const restarted=createDouyinRssArchive(async()=>db);expect(await restarted.read(2,'0')).toBeUndefined();
 }finally{raw.close();}
});
test('an archive write failure leaves every complete row available in the RSS list',async()=>{
 let calls=0;
 const original=Array.from({length:40},(_,i)=>item('id'+i));
 const c=new DouyinRssFeedController({fetchFeedPage:async()=>({ok:true,data:{items:original,nextCursor:null,hasMore:false}})},undefined,undefined,undefined,
 {write:async()=>{calls++;throw Error('storage offline');},read:async()=>undefined,drop:async()=>{}});
 await c.refresh();expect(calls).toBe(1);expect(await c.item('id0')).toEqual(original[0]);expect(c.state.items).toHaveLength(40);
});
