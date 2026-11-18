import {expect,test} from 'bun:test';
import {parseDouyinDetail,parseDouyinFeed,parseDouyinFeedAsync,parseDouyinItem} from '../../src/douyin/parser.ts';
import {douyinPlaybackMirrors} from '../../src/douyin/playback-mirrors.ts';
import {douyinPlaybackCandidates} from '../../src/douyin/playback-recovery.ts';
import {DouyinClient} from '../../src/douyin/client.ts';
import {QUEUE_KEY,PLAYBACK_ITEMS_KEY,playbackItemKey,snapshotRecordKey} from '../../src/douyin/feed-store.ts';

const root='https://review.invalid/';
const row=(width:number,height:number,urls:string[],codec='h264',definition=width+'p')=>({
 width,height,codec_type:codec,bit_rate:width,video_extra:{definition},
 play_addr:{uri:'shared',url_key:'shared',url_list:urls},
});
const video=(id:string,bit_rate:ReturnType<typeof row>[])=>({aweme_id:id,video:{bit_rate}});
const storage=(rows=new Map<string,string>())=>({get:async(k:string)=>rows.get(k)??null,set:async(k:string,v:string)=>{rows.set(k,v);},remove:async(k:string)=>{rows.delete(k);}});
const transport={request:async()=>{throw Error('unexpected network');}};

test('RVRESCAP3-01 ingress strips encoded hosts, oversized addresses and mirrors',async()=>{
 const escaped='https://%72eview%2einvalid:443/bad';
 const fixture=video('clip',[row(480,854,[root+'safe',escaped,root+'high-mirror']),row(1080,1920,[root+'bad',root+'high-mirror'])]);
 const direct=video('direct',[row(480,854,[escaped]),row(1080,1920,[root+'bad'])]);
 const raw=JSON.stringify({aweme_list:[fixture,direct]});
 expect(parseDouyinItem(direct)).toBeNull();
 const items=parseDouyinFeed(raw).items;
 expect((await parseDouyinFeedAsync(raw)).items).toEqual(items);
 expect(items).toHaveLength(1);
 expect(items[0]!.variants.map(v=>[v.playUrl,v.playUrls])).toEqual([[root+'safe',[root+'safe']]]);
 expect(douyinPlaybackMirrors(items[0]!)).toEqual([]);
 expect(douyinPlaybackCandidates(items[0]!)).toEqual([root+'safe']);
 expect(parseDouyinDetail(JSON.stringify({aweme_detail:direct}))).toBeNull();
});

test('RVRESCAP3-02 shared provider keys cannot turn independent HEVC into an AVC mirror',()=>{
 const h264=root+'avc',hevc=root+'hevc';
 const item=parseDouyinItem(video('encodings',[row(480,854,[h264,hevc]),row(480,854,[hevc],'hevc')]))!;
 expect(item.playUrl).toBe(h264);
 expect(item.variants[0]?.playUrls).toEqual([h264]);
 expect(douyinPlaybackMirrors(item)).toEqual([]);
 expect(douyinPlaybackCandidates(item)).toEqual([h264]);
});

test('RVRESCAP3-03 snapshot ingress removes any number of oversized mirror references',async()=>{
 for(const count of [198,199,200,201,207,256]){
  const rejected=root+'large',safe=root+'good',id='clip-'+count;
  const high={width:1080,height:1920,bitrate:1,codec:'h264',playUrl:rejected,playUrls:Array.from({length:count},(_,i)=>root+'mirror-'+i)};
  const low={width:360,height:640,bitrate:1,codec:'h264',playUrl:safe,playUrls:[safe,high.playUrls[0]]};
  const item={awemeId:id,playUrl:rejected,variants:[high,low]};
  const metadata={anchorAwemeId:id,cursor:'next',hasMore:true,resolved:{[id]:7},savedAtMillis:7};
  const rows=new Map<string,string>([
   [QUEUE_KEY,JSON.stringify({...metadata,items:[item]})],
   [snapshotRecordKey(QUEUE_KEY),JSON.stringify({...metadata,ids:[id]})],
   [PLAYBACK_ITEMS_KEY,JSON.stringify([id])],
   [playbackItemKey(id),JSON.stringify({item,resolvedAtMillis:7})],
  ]);
  const client=new DouyinClient({secureStorage:storage(rows),transport});
  const actual=await client.restorePlaybackQueue();
  expect(actual.items.map(value=>[value.playUrl,value.variants.map(v=>v.playUrl)])).toEqual([[safe,[safe]]]);
  expect(actual.anchorAwemeId).toBe(id);
  expect([...rows.values()].some(value=>value.includes(rejected)||value.includes(root+'mirror-'))).toBe(false);
 }
});
