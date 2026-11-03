import {test,expect} from 'bun:test';
import {completeDouyinRendition,douyinPrestoreConfig,storedDouyinMetadata,restoredDouyinItem} from '../../src/douyin/prestore-policy.ts';
import {douyinProxyWindow} from '../../src/douyin/proxy-policy.ts';
import {DouyinClient} from '../../src/douyin/client.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';
test('disk window includes twenty ahead while config bounds all new budgets',()=>{
 const items=Array.from({length:40},(_,i)=>({awemeId:String(i),playUrl:'https://fixture.invalid/'+i}) as DouyinItem);
 const window=douyinProxyWindow(items,'10','active');expect(window).toHaveLength(24);expect(window.filter(v=>Number(v.awemeId)>10)).toHaveLength(20);expect(window[0].awemeId).toBe('10');
 expect(douyinProxyWindow(items,'10','active',6)).toHaveLength(10);
 expect(douyinPrestoreConfig({entryBytes:1e12,totalBytes:1e12,ahead:1e12,frameBytes:1e12})).toMatchObject({entryBytes:32*1024*1024,totalBytes:128*1024*1024,ahead:20,frameBytes:10*1024*1024});expect(douyinPrestoreConfig({enabled:false}).enabled).toBe(false);
});
test('stored render metadata excludes credentials, remote covers and expired source URLs',()=>{
 const item={awemeId:'42',description:'title',authorName:'author',authorAvatar:'https://avatar.invalid',coverUrl:'https://cover.invalid',playUrl:'https://media.invalid?expires=1000000000',durationMs:5000,variants:[]} as unknown as DouyinItem;
 const metadata=storedDouyinMetadata(item);expect(JSON.stringify(metadata)).not.toContain('https:');expect(restoredDouyinItem(metadata,'file:///movie.mp4')).toMatchObject({awemeId:'42',playUrl:'file:///movie.mp4',description:'title'});expect(restoredDouyinItem(metadata,item.playUrl)).toBeUndefined();
});
test('strict pre-store traffic policy stops after one 403 and prevents detail request',async()=>{
 let requests=0;const client=()=>new DouyinClient({secureStorage:{get:async()=> 'fixture',set:async()=>{},remove:async()=>{throw Error('credentials must survive');}},signer:{sign:()=> 'fixture'},transport:{request:async()=>{requests++;return {status:403,headers:{},body:new Uint8Array()};}}});
 const feed=client();feed.usePrestoreTrafficPolicy();expect((await feed.fetchFeedPage()).ok).toBe(false);expect((await feed.fetchFeedPage()).ok).toBe(false);expect(requests).toBe(1);
 const detail=client();detail.usePrestoreTrafficPolicy();expect((await detail.fetchDetail('42')).ok).toBe(false);expect((await detail.fetchFeedPage()).ok).toBe(false);expect(requests).toBe(1);
});

test('complete storage selects the smallest acceptable rendition with its audio companion',()=>{
 const v=(format:'mp4'|'dash',width:number,bitrate:number)=>({format,playUrl:`https://media.invalid/${format}/${width}`,audioUrl:format==='dash'?'https://media.invalid/audio':undefined,width,height:width,bitrate,codec:'h264' as const});
 const variants=[v('dash',480,100),v('mp4',720,300),v('mp4',480,200)];
 const item={playUrl:variants[0].playUrl,variants} as DouyinItem;
 expect(completeDouyinRendition(item)?.playUrl).toBe(variants[0].playUrl);
 expect(completeDouyinRendition(item)?.variants).toEqual([variants[0]]);
 expect(completeDouyinRendition({...item,variants:[variants[0]]})?.playUrl).toBe(variants[0].playUrl);
 expect(completeDouyinRendition({...item,variants:[{...variants[0],audioUrl:undefined}]})).toBeUndefined();
});


test('DYWAIT-C complete defaults fit three large clips while all budgets remain configurable',()=>{
 expect(douyinPrestoreConfig(undefined)).toMatchObject({count:3,entryBytes:32*1024*1024,totalBytes:128*1024*1024,minFreeBytes:512*1024*1024});
 expect(douyinPrestoreConfig({enabled:false,entryBytes:16*1024*1024,totalBytes:64*1024*1024,minFreeBytes:256*1024*1024})).toMatchObject({enabled:false,entryBytes:16*1024*1024,totalBytes:64*1024*1024,minFreeBytes:256*1024*1024});
});
test('DYWAIT-C prefers lowest bitrate 540p with audio over 480p, 720p and larger 540p',()=>{
 const v=(name:string,width:number,bitrate:number,format:'mp4'|'dash'='mp4')=>({playUrl:'https://fixture.invalid/'+name,width,height:width*16/9,bitrate,codec:'h264' as const,format,...(format==='dash'?{audioUrl:'https://fixture.invalid/aac'}:{})});
 const variants=[v('480',480,200),v('720',720,300),v('540-large',540,500),v('540-dash',540,250,'dash')];
 const selected=completeDouyinRendition({playUrl:variants[1].playUrl,variants} as DouyinItem);expect(selected?.playUrl).toBe(variants[3].playUrl);expect(selected?.variants[0].audioUrl).toBe('https://fixture.invalid/aac');
});
