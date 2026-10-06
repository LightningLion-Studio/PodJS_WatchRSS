import { expect, test } from 'bun:test';
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
