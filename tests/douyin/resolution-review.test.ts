import {expect,test} from 'bun:test';
import {parseDouyinItem,parseDouyinFeedAsync} from '../../src/douyin/parser.ts';
import {douyinPlaybackCandidates} from '../../src/douyin/playback-recovery.ts';
import {completeDouyinRendition} from '../../src/douyin/prestore-policy.ts';
import {DouyinFeedStore,QUEUE_KEY,PLAYBACK_ITEMS_KEY,playbackItemKey,snapshotRecordKey} from '../../src/douyin/feed-store.ts';
import {DouyinSavedStore} from '../../src/douyin/saved.ts';
import {DouyinHistoryStore} from '../../src/douyin/history-store.ts';

const root='https://review.invalid/';
function randomCases(seed:number) {
 let state=seed>>>0;
 return (n:number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return (state>>>8)%n;};
}
const fakeStorage=(rows:Map<string,string>)=>({
 get:async(k:string)=>rows.get(k)??null,set:async(k:string,v:string)=>{rows.set(k,v);},remove:async(k:string)=>{rows.delete(k);},
});

test('generated ingress keeps independent safe sources and removes all oversized transport aliases',async()=>{
 for(const seed of [0x7202026,0x31a7cafe,0x4ca551,0x105f0cafe]){
  const rand=randomCases(seed);
  const cases=Array.from({length:80},(_,n)=>{
   const bad=root+'high'+n,safe=root+'safe'+n,blocked=root+'high-mirror'+n;
   const spelling=(path:string)=>['https://REVIEW.invalid:443/'+path,' '+root+path+' ',root+'junk/../'+path,root+path+'#video',
     'https://%72eview%2einvalid:443/'+path][rand(5)]!;
   const high=[721,722,1080,1440,2160][rand(5)]!,low=[240,360,480,540,720][rand(5)]!;
   const oversized={gear_name:rand(2)?low+'p':high+'p',play_addr:{url_list:[spelling('high'+n),blocked],width:high,height:high*2}};
   const aliasLow={gear_name:low+'p',play_addr:{url_list:[bad,spelling('safe'+n)],width:low,height:low*2}};
   const independent={gear_name:low+'p',play_addr:{url_list:[safe,spelling('high'+n),spelling('high-mirror'+n)],width:low,height:low*2}};
   const rows=rand(2)?[aliasLow,independent,oversized]:[oversized,independent,aliasLow];
   if(rand(2))for(const row of rows)[row.play_addr.width,row.play_addr.height]=[row.play_addr.height,row.play_addr.width];
   return {payload:{aweme_id:'generated'+n,video:{bit_rate:rows}},safe,low};
  });
  const asyncPage=await parseDouyinFeedAsync(JSON.stringify({aweme_list:cases.map(value=>value.payload)}));
  for(const [index,{payload,safe,low}] of cases.entries()){
   const item=parseDouyinItem(payload,'feed')!;
   expect(asyncPage.items[index]).toEqual(item);
   expect(item.playUrl,`seed ${seed}, case ${index}`).toBe(safe);
   expect(item.variants.map(v=>[Math.min(v.width,v.height),v.playUrl,v.playUrls])).toEqual([[low,safe,[safe]]]);
   expect(completeDouyinRendition(item)?.playUrl).toBe(safe);
   expect(douyinPlaybackCandidates(item)).toEqual([safe]);
  }
 }
});

test('generated legacy and versioned snapshots publish only admitted variants',async()=>{
 const rand=randomCases(0x05f0cafe);
 for(let n=0;n<24;n++){
  const id='seed-'+n,bad=root+'old-'+n,safe=root+'safe-'+n;
  const high={codec:'h264',width:720+1+rand(700),height:1920,bitrate:1,playUrl:bad,playUrls:[root+'mirror-'+n]};
  const low={codec:'h264' as const,width:[360,480,540,720][rand(4)]!,height:854,bitrate:1,playUrl:safe};
  const item={awemeId:id,playUrl:rand(2)?bad:high.playUrls[0],variants:rand(2)?[high,low]:[low,high]};
  const meta={anchorAwemeId:id,resolved:{[id]:8},cursor:null,hasMore:false,savedAtMillis:8},rows=new Map<string,string>();
  const layout=n%3;
  if(layout!==1)rows.set(QUEUE_KEY,JSON.stringify({...meta,items:[item]}));
  if(layout!==0){
   rows.set(snapshotRecordKey(QUEUE_KEY),JSON.stringify({...meta,ids:[id]}));
   rows.set(PLAYBACK_ITEMS_KEY,JSON.stringify([id]));
   rows.set(playbackItemKey(id),JSON.stringify({item,resolvedAtMillis:8}));
  }
  const store=new DouyinFeedStore(fakeStorage(rows));
  const restored=await store.read(QUEUE_KEY);
  expect(restored.items.map(value=>[value.playUrl,value.variants])).toEqual([[safe,[low]]]);
  expect(restored.anchorAwemeId).toBe(id);
  expect([...rows.values()].some(text=>text.includes(bad)||text.includes(high.playUrls[0]!))).toBe(false);
  expect(await new DouyinFeedStore(fakeStorage(rows)).read(QUEUE_KEY)).toEqual(restored);
 }
});

test('old history and favorites discard high-only DTOs and keep an independent compliant source',async()=>{
 const high={playUrl:root+'high',width:1080,height:1920,bitrate:100,codec:'h264'};
 const safe={playUrl:root+'safe',width:480,height:864,bitrate:100,codec:'h264'};
 const old={awemeId:'mixed',playUrl:high.playUrl,variants:[high,safe]};
 const bad={awemeId:'high-only',playUrl:high.playUrl,variants:[high]};
 const rows=new Map<string,string>([
  ['douyin.history.v1',JSON.stringify([old,bad].map(item=>({item,watchedAtMillis:1})))],
  ['douyin.saved.v1',JSON.stringify([old,bad].map(item=>({platform:'douyin',awemeId:item.awemeId,item,kind:'favorite',savedAtMillis:1,shareUrl:root+item.awemeId})))],
 ]);
 const storage=fakeStorage(rows);
 expect((await new DouyinHistoryStore(storage).list()).map(value=>value.item.playUrl)).toEqual([safe.playUrl]);
 expect((await new DouyinSavedStore(storage).list()).map(value=>value.item.playUrl)).toEqual([safe.playUrl]);
});
