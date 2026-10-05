import { expect, test } from 'bun:test';
import { DouyinClient } from '../../src/douyin/client.ts';
import { DouyinPlaybackQueue } from '../../src/douyin/playback-queue.ts';
import { loadDouyinDetail, douyinDetailBlocks } from '../../src/douyin/detail.ts';
import { douyinPlayerNetwork } from '../../src/ui/douyin/player-network.ts';
import { DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT } from '../../src/media/douyin-login.ts';
import type { DouyinItem } from '../../src/douyin/types.ts';
const item = (id:string):DouyinItem => ({awemeId:id,description:`title ${id}`,authorName:'作者',authorId:'author',createdAtSeconds:0,likeCount:3,commentCount:0,shareCount:0,collectCount:0,playUrl:`https://video/${id}`,durationMs:100,variants:[]});
function fixture() {
  const values = new Map<string,string>(); let requests = 0;
  const store = { async get(k:string) { return values.get(k) ?? null; }, async set(k:string,v:string) { values.set(k,v); }, async remove(k:string) { values.delete(k); } };
  let now=1000;
  const make = () => new DouyinClient({now:()=>now,secureStorage:store,signer:{sign:()=>''},transport:{async request(){requests++;throw Error('offline');}}});
  return {values,make,advance:()=>now++,requests:()=>requests};
}
test('passed detail is rendered without even reading storage; mismatched IDs do not leak metadata',async()=>{
  const client={listHistory:async()=>{throw Error('must not read');}} as unknown as DouyinClient;
  expect(await loadDouyinDetail(client,'1',item('1'))).toMatchObject({ok:true,data:{item:{awemeId:'1'}}});
  const f=fixture();expect(await loadDouyinDetail(f.make(),'2',item('1'))).toMatchObject({ok:false});
});
test('history and saved detail survive restart offline without promoting expired playback URLs',async()=>{
  const f=fixture(),client=f.make();await client.recordHistory(item('1'));await client.setSaved(item('2'),'favorite',true);
  const restarted=f.make();
  for(const id of ['1','2']) expect(await loadDouyinDetail(restarted,id)).toMatchObject({ok:true,data:{item:{awemeId:id}}});
  expect(f.requests()).toBe(0);expect(await restarted.resolvePlayback('1')).toMatchObject({ok:false});
  expect(douyinDetailBlocks({kind:'video',item:item('1')})).toMatchObject([{style:'title',text:'title 1'},{style:'subtitle',text:'作者：作者'},{style:'body',text:'点赞 3'},{type:'video',url:'https://video/1'},{style:'quote',text:'点击视频卡片即可播放。'}]);
});
test('200-history queue retains order, selected index and previous items across client restart; only settled records',async()=>{
  const f=fixture(),client=f.make(),items=Array.from({length:200},(_,i)=>item(String(i)));
  // Resolution is mocked, persistence is the real client/storage implementation.
  client.resolvePlayback=async id=>({ok:true,data:item(id)});
  const queue=new DouyinPlaybackQueue(client,{items,selectedAwemeId:'100',hasMore:false});
  await queue.next();expect(await client.listHistory()).toEqual([]);await queue.settled();
  await queue.next();await queue.settled();
  const restarted=f.make(),snapshot=await restarted.restorePlaybackQueue();
  expect(snapshot.items).toHaveLength(200);expect(snapshot.anchorAwemeId).toBe('102');expect(snapshot.hasMore).toBe(false);
  restarted.resolvePlayback=async id=>({ok:true,data:item(id)});
  const restored=new DouyinPlaybackQueue(restarted,{...snapshot,selectedAwemeId:snapshot.anchorAwemeId!});
  expect(restored.snapshot().index).toBe(102);expect(await restored.previous()).toMatchObject({ok:true,data:{item:{awemeId:'101'}}});
  expect((await restarted.listHistory()).map(e=>e.item.awemeId)).toEqual(['102','101']);
  await restarted.logout();expect((await restarted.restorePlaybackQueue()).items).toEqual([]);
});
test('corrupt persistent queue falls back to empty',async()=>{
  const f=fixture();f.values.set('douyin.playback-queue.v1','{');expect((await f.make().restorePlaybackQueue()).items).toEqual([]);
});
test('network mask preserves running video and allows explicit Bluetooth continuation',()=>{
  expect(douyinPlayerNetwork('checking',false,false)).toBeNull();
  expect(douyinPlayerNetwork('available',false,false)).toBeNull();
  expect(douyinPlayerNetwork('unavailable',true,false)).toBeNull();
  expect(douyinPlayerNetwork('unavailable',false,true)?.action).toBe('重试');
  expect(douyinPlayerNetwork('bluetooth',false,false)?.action).toBe('继续');
  expect(douyinPlayerNetwork('bluetooth',false,true)).toBeNull();
});
test('real QR extraction script drops PNG overlay on second verification and JPEG challenges, then recovers',()=>{
  let second=false,images: string[]=['data:image/png;base64,login'];
  const document={getElementById:()=>second?{tagName:'DIV'}:null,querySelectorAll:()=>images.map(src=>({getAttribute:(key:string)=>key==='aria-label'?'二维码':src}))};
  const extract=()=>new Function('document',`return ${DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT.trim()}`)(document);
  expect(extract()).toBe(images[0]);second=true;expect(extract()).toBeNull();second=false;
  images.push('data:image/jpeg;base64,challenge');expect(extract()).toBeNull();images.shift();expect(extract()).toBeNull();
  images=['data:image/png;base64,new-login'];expect(extract()).toBe(images[0]);images=[];expect(extract()).toBeNull();
});

test('detail-entry then ready/settled refreshes one native history entry and one watched ID',async()=>{
  const f=fixture(),client=f.make();
  await client.recordHistory(item('older'));f.advance();await client.recordHistory(item('selected'));
  const entered=(await client.listHistory())[0].watchedAtMillis;
  f.advance();client.resolvePlayback=async id=>({ok:true,data:{...item(id),description:'fresh metadata'}});
  const queue=new DouyinPlaybackQueue(client,{items:[item('selected'),item('next')],selectedAwemeId:'selected',hasMore:false});
  await queue.current();await queue.settled();
  const history=await client.listHistory();expect(history.map(e=>e.item.awemeId)).toEqual(['selected','older']);
  expect(history[0].watchedAtMillis).toBeGreaterThan(entered);expect(history[0].item.description).toBe('fresh metadata');
  expect(await client.listWatchedIds()).toEqual(['older','selected']);
  await queue.next();await queue.settled();expect((await client.listHistory()).map(e=>e.item.awemeId)).toEqual(['next','selected','older']);
});
test('concurrent entry and playback writes do not lose items or duplicate IDs, invalid metadata is ignored',async()=>{
  const f=fixture(),client=f.make();
  await Promise.all([client.recordHistory(item('a')),client.recordHistory(item('b')),client.recordHistory({...item('a'),description:'updated'})]);
  expect((await client.listHistory()).map(e=>[e.item.awemeId,e.item.description])).toEqual([['a','updated'],['b','title b']]);
  expect(await client.listWatchedIds()).toEqual(['b','a']);
  await client.recordHistory({...item('invalid'),playUrl:' '});await client.recordHistory({...item('invalid'),awemeId:' '});
  expect(await client.listHistory()).toHaveLength(2);
  await Promise.all([client.recordHistory(item('c')),client.clearHistory()]);expect(await client.listHistory()).toEqual([]);expect(await client.listWatchedIds()).toEqual([]);
});
