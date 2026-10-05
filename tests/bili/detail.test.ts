import { expect, test } from 'bun:test';
import { BiliDetailController, initialPage, latestCid, localBiliDetail } from '../../src/bili/detail.ts';
import type { BrowseStore } from '../../src/bili/browse.ts';
import type { BiliClient } from '../../src/bili/client.ts';
import type { BiliVideoDetail } from '../../src/bili/types.ts';
const detail: BiliVideoDetail = { item: { aid: 7, bvid: 'BV7', title: '标题' }, pages: [{ cid: 10, part: '第一' }, { cid: 20, part: '第二' }] };
function fixture(overrides: Partial<BiliClient> = {}) {
 const data = new Map<string, unknown>();
 const store: BrowseStore = { get: <T>(key: string) => data.get(key) as T, set: (key, value) => { data.set(key, value); } };
 const calls: Array<[string, any]> = [];
 const client = { detail: async () => detail, getSession: async () => ({cookies:{SESSDATA:'s'},updatedAt:1}), relation: async () => ({}), like: async (x:any) => {calls.push(['like',x]);return {liked:x.liked};}, coin: async (x:any) => {calls.push(['coin',x]);return {liked:false};}, favoriteFolders: async () => [{id:1,favState:1},{id:2,favState:1},{id:3,favState:0}], favorite: async(x:any)=>{calls.push(['favorite',x]);return {prompt:false};}, ...overrides };
 const controller = new BiliDetailController(client,store,{aid:7,cid:10},async()=>undefined);
 return { controller, client, store, data, calls };
}
test('latest persisted cid wins route cid, missing/invalid progress falls back like native', async () => {
 const f=fixture(); f.store.set('watchrss.bili.playback-progress.v1',JSON.stringify([{aid:7,cid:10,updatedAt:1},{bvid:'bv7',cid:20,updatedAt:2},{aid:8,cid:99,updatedAt:3}]));
 await f.controller.load(); expect(f.controller.selectedCid()).toBe(20);
 f.controller.select(0); await f.controller.load(); expect(f.controller.selectedCid()).toBe(10);
 f.controller.select(-1);expect(f.controller.selectedCid()).toBe(10);
 expect(initialPage(detail,20,999)).toBe(0);expect(initialPage(detail,20)).toBe(1);
 f.store.set('watchrss.bili.playback-progress.v1','broken');expect(latestCid(f.store,{aid:7})).toBeUndefined();
});
test('merges native local/detail/relation booleans and keeps local state when relation fails',async()=>{
 const f=fixture({detail:async()=>({...detail,interaction:{coin:true}}),relation:async()=>({favorite:true,like:false})});
 f.store.set('watchrss.bili.interactions.v1',[{aid:7,like:true}]);await f.controller.load();expect(f.controller.state.interaction).toEqual({like:true,coin:true,favorite:true});
 f.client.relation=async()=>{throw Error('offline')};await f.controller.load();expect(f.controller.state.interaction.favorite).toBe(true);
});
test('anonymous state ignores detail interaction and never requests relation',async()=>{
 let requests=0;const f=fixture({getSession:async()=>null,detail:async()=>({...detail,interaction:{like:true}}),relation:async()=>{requests++;return {coin:true};}});
 await f.controller.load();expect(requests).toBe(0);expect(f.controller.state.interaction.like).toBe(false);
});
test('optimistic like toggles, coin only once, favorite removes all containing folders and includes selected cid',async()=>{
 const f=fixture({relation:async()=>({favorite:true})});await f.controller.load();f.controller.select(1);
 await f.controller.act('like');await f.controller.act('like');await f.controller.act('coin');await f.controller.act('coin');await f.controller.act('favorite');
 expect(f.calls.map(v=>v[0])).toEqual(['like','like','coin','favorite']);expect(f.calls[1][1].liked).toBe(false);
 expect(f.calls[3][1]).toMatchObject({removeMediaIds:[1,2],savedItem:{aid:7,bvid:'BV7',cid:20,title:'标题'}});expect(f.controller.state.interaction.favorite).toBe(false);
 await f.controller.act('favorite');expect(f.calls.at(-1)![1].addMediaIds).toEqual([1]);
});
test('remote failures retain native optimistic like/coin, but never flip favorite',async()=>{
 const fail=async()=>{throw Error('offline')};const f=fixture({like:fail,coin:fail,favorite:fail});await f.controller.load();
 await f.controller.act('like');await f.controller.act('coin');await f.controller.act('favorite');expect(f.controller.state.interaction).toEqual({like:true,coin:true,favorite:false});expect(f.controller.state.message).toContain('offline');expect(f.controller.state.busy).toBe(false);
});
test('duplicate mutation and disposed response cannot update UI',async()=>{
 let finish!:()=>void;const f=fixture({favorite:()=>new Promise(resolve=>finish=()=>resolve({prompt:false}))});await f.controller.load();
 const first=f.controller.act('favorite');await Promise.resolve();await f.controller.act('favorite');expect(f.controller.state.busy).toBe(true);
 f.controller.dispose();finish();await first;expect(f.controller.state.interaction.favorite).toBe(false);
});
test('offline detail is published before network resolves and preserves saved metadata/cid',async()=>{
 const f=fixture();let reject!:(reason:Error)=>void;
 const local=localBiliDetail({title:'保存的标题',link:'https://www.bilibili.com/video/BV7?cid=20',description:'UP主：作者',content:'简介',imageUrl:'https://cover'},{bvid:'BV7'})!;
 expect(local).toMatchObject({item:{title:'保存的标题',cid:20,owner:{name:'作者'},cover:'https://cover'},desc:'简介',pages:[]});
 const c=new BiliDetailController({...f.client,detail:()=>new Promise((_,r)=>reject=r)},f.store,{bvid:'BV7'},async()=>local);
 const load=c.load();await Promise.resolve();await Promise.resolve();expect(c.state.detail).toEqual(local);reject(Error('offline'));await load;expect(c.state.offline).toBe(true);expect(c.selectedCid()).toBe(20);expect(c.state.loading).toBe(false);
 expect(localBiliDetail({title:'wrong',link:'https://www.bilibili.com/video/BV70'},{bvid:'BV7'})).toBeUndefined();
});
test('late detail response after dispose is ignored',async()=>{
 let finish!:(value:BiliVideoDetail)=>void;const f=fixture({detail:()=>new Promise(resolve=>finish=resolve)});const load=f.controller.load();await Promise.resolve();await Promise.resolve();f.controller.dispose();finish(detail);await load;expect(f.controller.state.detail).toBeUndefined();
});
