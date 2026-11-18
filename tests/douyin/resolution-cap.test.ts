import {expect,test} from 'bun:test';
import {applyPreferredDouyinPlayback,douyinCodecRuntimePolicy,normalizedDouyinResolution,selectPreferredDouyinUrl} from '../../src/douyin/playback-selector.ts';
import {completeDouyinRendition,restoredDouyinItem} from '../../src/douyin/prestore-policy.ts';
import {DouyinPlaybackRecovery,douyinPlaybackCandidates} from '../../src/douyin/playback-recovery.ts';
import {admitDouyinItem} from '../../src/douyin/playback-ingress.ts';
import {parseDouyinDetail} from '../../src/douyin/parser.ts';
import type {DouyinItem,DouyinVideoVariant} from '../../src/douyin/types.ts';

const variant=(name:string,width:number,height:number,extra:Partial<DouyinVideoVariant>={}):DouyinVideoVariant=>({
  playUrl:'https://fixture.invalid/'+name,width,height,bitrate:200,codec:'h264',...extra,
});
const high=variant('portrait',1080,1920);
const old=(variants:DouyinVideoVariant[],playUrl=high.playUrl):DouyinItem=>({
  awemeId:'clip',description:'clip',authorId:'',authorName:'fixture',createdAtSeconds:0,durationMs:1000,
  likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl,variants,
});

test('4K HEVC is rejected even after HEVC capability confirmation',()=>{
  const fourK=variant('4k',3840,2160,{codec:'h265'});
  const low=variant('480',480,854);
  douyinCodecRuntimePolicy.confirmHevcSize(fourK,true);
  try{
    expect(admitDouyinItem(old([fourK],fourK.playUrl))).toBeUndefined();
    expect(applyPreferredDouyinPlayback(admitDouyinItem(old([fourK,low],fourK.playUrl))!).playUrl).toBe(low.playUrl);
  }finally{douyinCodecRuntimePolicy.confirmHevcSize(fourK,false);}
});

test('portrait short edge overrides misleading labels and rejects a stale mirror and legacy fallback',()=>{
  expect(normalizedDouyinResolution(high)).toBe(1080);
  const misleading={...high,definition:'480p',playUrls:['https://fixture.invalid/high-mirror']};
  expect(admitDouyinItem(old([misleading],misleading.playUrls[0]))).toBeUndefined();
  expect(admitDouyinItem(old([high],'https://fixture.invalid/unclassified'))).toBeUndefined();
  expect(admitDouyinItem(old([variant('721',721,1280,{definition:'720p'})]))).toBeUndefined();
  expect(parseDouyinDetail(JSON.stringify({aweme_detail:{aweme_id:'raw',video:{
    width:1080,height:1920,play_addr:{url_list:['https://fixture.invalid/raw']},
  }}}))).toBeNull();
});

test('playback and storage share 480, 360, 540, 720, low and unknown ordering',()=>{
  const tiers=[
    variant('480',0,0,{definition:'480p',codec:'unknown'}),variant('360',0,0,{gearName:'normal_360p'}),
    variant('540',540,960),variant('720',720,1280),variant('240',240,426),variant('unknown',0,0),
  ];
  for(let i=0;i<tiers.length;i++){
    const variants=tiers.slice(i).reverse();
    expect(selectPreferredDouyinUrl(variants)).toBe(tiers[i]?.playUrl);
    expect(completeDouyinRendition(old(variants))?.playUrl).toBe(tiers[i]?.playUrl);
  }
  const hevc=variant('hevc',480,854,{codec:'h265',bitrate:50});
  const avc=variant('avc',480,854,{bitrate:50});
  const higher=variant('high-rate',480,854);
  douyinCodecRuntimePolicy.confirmHevcSize(hevc,true);
  try{expect(selectPreferredDouyinUrl([hevc,higher,avc])).toBe(avc.playUrl);}
  finally{douyinCodecRuntimePolicy.confirmHevcSize(hevc,false);}
  expect(selectPreferredDouyinUrl([hevc],hevc.playUrl)).toBeUndefined();
  expect(selectPreferredDouyinUrl([],'https://fixture.invalid/legacy')).toBe('https://fixture.invalid/legacy');
});

test('restored snapshots and history discard high-only sources, and stock rejects old portrait metadata',()=>{
  expect(admitDouyinItem(old([high]))).toBeUndefined();
  expect(restoredDouyinItem({...old([]),width:1080,height:1920},'file:///stock.mp4')).toBeUndefined();
  const low=variant('360',360,640);
  expect(applyPreferredDouyinPlayback(admitDouyinItem(old([high,low]))!).playUrl).toBe(low.playUrl);
});

test('recovery excludes old high mirrors and rejects a high-only refreshed source',async()=>{
  const highMirror=variant('high',1080,1920,{playUrls:['https://fixture.invalid/high-mirror']});
  const low=variant('low',360,640,{playUrls:['https://fixture.invalid/low-mirror']});
  expect(douyinPlaybackCandidates(applyPreferredDouyinPlayback(admitDouyinItem(old([highMirror,low],highMirror.playUrl))!))).toEqual([low.playUrl,low.playUrls![0]]);
  const timer=()=>({result:new Promise<never>(()=>{}),cancel(){}});
  const recovery=new DouyinPlaybackRecovery(old([low],low.playUrl),async()=>{const found=admitDouyinItem(old([highMirror],highMirror.playUrl));if(!found)throw Error('playback_recovery_exhausted');return found;},Date.now,timer);
  const source={url:low.playUrls![0],title:'fixture'};
  await expect(recovery.recover(source,()=>true,false,{status:410})).rejects.toThrow('exhausted');
});

test('reads and removes an old versioned snapshot and its over-limit row',async()=>{
  const {DouyinFeedStore,QUEUE_KEY,PLAYBACK_ITEMS_KEY,playbackItemKey,snapshotRecordKey}=await import('../../src/douyin/feed-store.ts');
  const bad=old([high]),safe={...old([],'https://fixture.invalid/safe'),awemeId:'safe'};
  const rows=new Map<string,string>([
    [snapshotRecordKey(QUEUE_KEY),JSON.stringify({ids:[bad.awemeId,safe.awemeId],anchorAwemeId:bad.awemeId,resolved:{clip:7,safe:8},savedAtMillis:8,cursor:'resume',hasMore:true})],
    [PLAYBACK_ITEMS_KEY,JSON.stringify([bad.awemeId,safe.awemeId])],
    [playbackItemKey(bad.awemeId),JSON.stringify({item:bad,resolvedAtMillis:7})],
    [playbackItemKey(safe.awemeId),JSON.stringify({item:safe,resolvedAtMillis:8})],
  ]);
  const storage={get:async(k:string)=>rows.get(k)??null,set:async(k:string,v:string)=>{rows.set(k,v);},remove:async(k:string)=>{rows.delete(k);}};
  const store=new DouyinFeedStore(storage);
  const result=await store.read(QUEUE_KEY);
  expect(result).toMatchObject({items:[safe],anchorAwemeId:null,resolved:{safe:8},cursor:'resume'});
  expect(rows.has(playbackItemKey(bad.awemeId))).toBe(false);
});

test('an actual resolution rejection ejects the current item before resolving the next entry',async()=>{
  const {DouyinPlaybackQueue}=await import('../../src/douyin/playback-queue.ts');
  const unknown=old([],'https://fixture.invalid/legacy');
  const next={...old([],'https://fixture.invalid/next'),awemeId:'next'};
  const client={resolvePlayback:async(id:string)=>{
    expect(id).toBe(next.awemeId);
    expect(queue.snapshot().playlist.map(item=>item.awemeId)).toEqual([next.awemeId]);
    return {ok:true as const,data:next};
  }};
  const queue=new DouyinPlaybackQueue(client as never,{items:[unknown,next],selectedAwemeId:unknown.awemeId});
  expect(await queue.discardResolution()).toMatchObject({ok:true,data:{item:next}});
  expect(queue.diagnostics().quarantinedAwemeIds).toEqual([unknown.awemeId]);
});

test('a feed-only refresh cannot use an over-limit recommendation',async()=>{
  const {DouyinClient}=await import('../../src/douyin/client.ts');
  const values=new Map([['douyin.cookie','offline']]);
  const client=new DouyinClient({
    secureStorage:{get:async key=>values.get(key)??null,set:async(key,value)=>{values.set(key,value);},remove:async key=>{values.delete(key);}},
    signer:{sign:()=>''},transport:{request:async()=>({status:200,headers:{},body:new TextEncoder().encode(JSON.stringify({
      aweme_list:[{aweme_id:'clip',video:{play_addr:{url_list:[high.playUrl],width:1080,height:1920}}}],
    }))})},
  });
  expect(await client.resolvePlayback('clip',{forceRefresh:true,allowDetail:false,feedItem:old([],'https://fixture.invalid/legacy')}))
    .toMatchObject({ok:false,code:'TEMPORARILY_UNAVAILABLE'});
});
