import {expect,test} from 'bun:test';
import {douyinVariantSummary} from '../../src/douyin/playback-diagnostics.ts';
import {parseDouyinFeed} from '../../src/douyin/parser.ts';
import {applyPreferredDouyinPlayback} from '../../src/douyin/playback-selector.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';

test('real feed shape: unconfirmed HEVC and over-limit AVC leave no playable source',()=>{
 const item=parseDouyinFeed(JSON.stringify({aweme_list:[{aweme_id:'fixture',video:{bit_rate:[
  {is_h265:1,gear_name:'hevc_540',bit_rate:350000,play_addr:{url_list:['https://fixture.invalid/hevc540'],width:1024,height:576}},
  {is_h265:1,gear_name:'hevc_720',bit_rate:500000,play_addr:{url_list:['https://fixture.invalid/hevc720'],width:1280,height:720}},
 ],play_addr_h264:{url_list:['https://fixture.invalid/avc1080'],width:1920,height:1080},play_addr:{url_list:['https://fixture.invalid/avc1080'],width:1920,height:1080}}}]})).items[0]!;
 expect(item.playUrl).toBe('');expect(douyinVariantSummary(item)).toMatchObject({count:2,selected:-1});
 expect(applyPreferredDouyinPlayback({...item,playUrl:'https://fixture.invalid/hevc540'}).playUrl).toBe('');
});
test('variant summaries never export identity, URL, arbitrary codec/label values or headers',()=>{
 const item={awemeId:'PRIVATE_ID',title:'PRIVATE_TITLE',headers:{Cookie:'PRIVATE_COOKIE'},variants:[{playUrl:'https://private.example/?secret=PRIVATE_URL',codec:'PRIVATE_CODEC',width:1920,height:1080,bitrate:0,definition:'PRIVATE_LABEL 1080p'}]}as unknown as DouyinItem;
 const summary=douyinVariantSummary(item),text=JSON.stringify(summary);
 expect(summary.variants[0]).toMatchObject({codec:'unknown',resolution:1080});expect(text).not.toContain('PRIVATE');expect(text).not.toContain('https');
});


test('variant diagnostic identifies the actual source URL instead of recomputing its preference',()=>{
 const item={playUrl:'actual-alt',variants:[
  {playUrl:'preferred',codec:'h264',width:960,height:540,bitrate:100},
  {playUrl:'actual',playUrls:['actual-alt'],codec:'h264',width:3840,height:2160,bitrate:1000},
 ]} as DouyinItem;
 expect(douyinVariantSummary(item).selected).toBe(1);
 expect(douyinVariantSummary({...item,playUrl:'outside-variants'}).selected).toBe(-1);
});

test('detailed variant inspection stays dormant in ordinary releases',async()=>{
 const {traceDouyinVariants}=await import('../../src/douyin/playback-diagnostics.ts');
 const item={get variants(){throw Error('eager candidate traversal');}} as unknown as DouyinItem;
 expect(()=>traceDouyinVariants(item,'feed')).not.toThrow();
});

test('release metrics can enable and disable detailed variant events without per-item setting reads',async()=>{
 const {traceDouyinVariants}=await import('../../src/douyin/playback-diagnostics.ts');
 const originalNow=Date.now,pod=Object.getOwnPropertyDescriptor(globalThis,'pod');
 let enabled=false,reads=0,events=0,now=originalNow()+10_000;
 Date.now=()=>now;Object.defineProperty(globalThis,'pod',{configurable:true,value:{
  takeEvents:()=>[],kvGet:(key:string)=>{if(key==='watchrss.video-opt.v1'){reads++;return JSON.stringify({metrics:enabled,percent:100});}return '0';},
  benchmark:(raw:string)=>{if(JSON.parse(raw).code==='media_variant')events++;return 1;},
 }});
 const item={playUrl:'fixture',variants:[{playUrl:'fixture',width:360,height:640,bitrate:100,codec:'h264'}]} as DouyinItem;
 try{
  traceDouyinVariants(item,'detail');traceDouyinVariants(item,'detail');expect([reads,events]).toEqual([1,0]);
  enabled=true;now+=1100;traceDouyinVariants(item,'detail');traceDouyinVariants(item,'feed');expect([reads,events]).toEqual([2,2]);
  enabled=false;now+=1100;traceDouyinVariants(item,'feed');expect([reads,events]).toEqual([3,2]);
 }finally{Date.now=originalNow;if(pod)Object.defineProperty(globalThis,'pod',pod);else Reflect.deleteProperty(globalThis,'pod');}
});
