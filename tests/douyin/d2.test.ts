import { expect, test } from 'bun:test';
import { DouyinClient } from '../../src/douyin/client.ts';
import { DouyinPlaybackQueue } from '../../src/douyin/playback-queue.ts';
import { restoreDouyinQueue } from '../../src/douyin/resume.ts';
import { QUEUE_KEY } from '../../src/douyin/feed-store.ts';
import { AppResumeStore, resumeTargetForStack } from '../../src/navigation/resume-state.ts';
import { douyinPlayerNetwork, douyinSourceNeedsInternet, douyinNetworkFailure } from '../../src/ui/douyin/player-network.ts';
import { loginError } from '../../src/ui/douyin/login-state.ts';
import type { DouyinItem } from '../../src/douyin/types.ts';
const item=(id:string):DouyinItem=>({awemeId:id,description:`title ${id}`,createdAtSeconds:0,authorId:'',authorName:`author ${id}`,likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:`https://video/${id}?expires=old`,coverUrl:`https://cover/${id}`,durationMs:100,variants:[]});
function fixture(){
  const values=new Map<string,string>();let requests=0;
  const storage={get:async(k:string)=>values.get(k)??null,set:async(k:string,v:string)=>{values.set(k,v);},remove:async(k:string)=>{values.delete(k);}};
  const client=()=>new DouyinClient({secureStorage:storage,transport:{request:async()=>{requests++;throw Error('offline');}}});
  return {values,client,requests:()=>requests};
}
test('D2 cold reconstruction keeps exact ordered secure queue, URL metadata and current page without network or history writes',async()=>{
  const f=fixture(),client=f.client(),items=Array.from({length:55},(_,i)=>item(String(i)));
  const queue=new DouyinPlaybackQueue(client,{items,selectedAwemeId:'43',hasMore:false});
  await queue.persist();
  const target=resumeTargetForStack([{page:'home'},{page:'video',playback:{platform:'douyin'},queue}]);
  const values=new Map<string,unknown>(),store=new AppResumeStore({get:<T>(k:string)=>values.get(k) as T,set:(k,v)=>{values.set(k,v);},delete:k=>{values.delete(k);}});
  store.save(target);const read=store.read();expect(read?.kind).toBe('douyin');
  expect(JSON.stringify(read)).not.toContain('https://');expect(JSON.stringify(read)).not.toContain('headers');
  if(read?.kind!=='douyin')throw Error('missing target');
  const restored=await restoreDouyinQueue(f.client(),read.route.awemeId);
  expect(restored?.queue.snapshot()).toMatchObject({playlist:items,index:43,item:items[43],hasMore:false,cursor:null});
  expect(await client.listHistory()).toEqual([]);expect(f.requests()).toBe(0);
  await restored!.queue.prefetch();
  expect(await restored!.queue.previous()).toMatchObject({ok:true,data:{item:items[42],index:42}});
  expect(await restored!.queue.next()).toMatchObject({ok:true,data:{item:items[43],index:43}});
  expect(await restored!.queue.recover()).toMatchObject({ok:true,data:{item:items[43],index:43}});
  expect(f.requests()).toBe(0);
  const moved=restored!.queue.commitPreview('44');expect(moved.ok).toBe(true);await restored!.queue.persist();
  const again=await restoreDouyinQueue(f.client(),'44');expect(again?.queue.snapshot().index).toBe(44);
  expect(f.requests()).toBe(0);
});
test('D2 missing, corrupt or mismatched snapshot never substitutes another video or feed',async()=>{
  const f=fixture();expect(await restoreDouyinQueue(f.client(),'1')).toBeNull();
  f.values.set(QUEUE_KEY,'broken');expect(await restoreDouyinQueue(f.client(),'1')).toBeNull();
  await f.client().savePlaybackQueue([item('1'),item('2')],'2',null,false);
  expect(await restoreDouyinQueue(f.client(),'1')).toBeNull();expect(await restoreDouyinQueue(f.client(),'gone')).toBeNull();expect(f.requests()).toBe(0);
});
test('D2 persists pre-playback navigation and keeps feed cursor/order when restoring',async()=>{
  const f=fixture(),items=Array.from({length:50},(_,i)=>item(String(i)));
  await f.client().savePlaybackQueue(items,'7','tail',true);
  const restored=await restoreDouyinQueue(f.client(),'7',true);expect(restored?.queue.snapshot()).toMatchObject({playlist:items,index:7,cursor:'tail',hasMore:true});
  expect(f.requests()).toBe(0);
});
test('D2 player native network copy and local/playing exemptions, no invented weak-network state',()=>{
  expect(douyinPlayerNetwork('unavailable',false,false)).toEqual({title:'未检测到可用互联网',detail:'请连接 WiFi 或移动网络',action:'重试'});
  expect(douyinPlayerNetwork('bluetooth',false,false)?.detail).toBe('当前使用蓝牙网络，网速较慢，建议连接 WiFi 或移动网络');
  for(const status of ['available','checking','unavailable','bluetooth'] as const){
    expect(douyinPlayerNetwork(status,true,false)).toBeNull();expect(douyinPlayerNetwork(status,false,false,false,true)).toBeNull();
  }
  expect(douyinPlayerNetwork('available',false,false,true,true)?.action).toBe('重试');
  expect(douyinPlayerNetwork('available',false,false)).toBeNull();
  expect(douyinPlayerNetwork('bluetooth',false,true)).toBeNull();
  for(const url of ['file:///video','content://media/1','/data/video',''])expect(douyinSourceNeedsInternet(url)).toBe(false);
  expect(douyinSourceNeedsInternet('https://video/1')).toBe(true);
  expect(douyinNetworkFailure({code:'network_error'})).toBe(true);
  for(const error of [{code:'timeout'},{code:'prepare_failed'},Error('network timeout')])expect(douyinNetworkFailure(error)).toBe(false);
});
test('D2 WebView main-frame failures map native messages without raw text and remain retryable',()=>{
  expect(loginError({code:'webview_load_-2',message:'SECRET'})).toEqual({unavailable:false,message:'无法找到服务器，请检查网络连接'});
  expect(loginError({code:'webview_load_-8'}).message).toBe('连接超时，请检查网络后重试');
  expect(loginError({code:'webview_load_-16'}).message).toBe('页面存在安全风险，已被拦截');
  expect(loginError({code:'webview_load_999'}).message).toBe('加载失败，请重试');
});

// Device regression: the network mask previously prevented autoplay at position 0.
test('offline stock can prepare and autoplay its cached prefix, then show the actual gap',()=>{
 const local={cacheBacked:true,hasRenderedFirstFrame:false,buffering:true,hasError:false};
 expect(douyinPlayerNetwork('unavailable',false,false,true,false,local)).toBeNull();
 expect(douyinPlayerNetwork('unavailable',false,false,true,false,{...local,hasRenderedFirstFrame:true,buffering:false})).toBeNull();
 expect(douyinPlayerNetwork('unavailable',false,false,true,true,{...local,hasError:true})?.title).toBe('未检测到可用互联网');
 expect(douyinPlayerNetwork('unavailable',false,false,true,false,{...local,cacheBacked:false})?.action).toBe('重试');
});
