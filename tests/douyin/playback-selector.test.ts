import {test,expect} from 'bun:test';
import fixture from './selector-native-fixture.json';
import {applyPreferredDouyinPlayback,selectPreferredDouyinUrl,DouyinCodecRuntimePolicy} from '../../src/douyin/playback-selector.ts';
import {parseDouyinFeed,parseDouyinDetail} from '../../src/douyin/parser.ts';
import {normalizeItems} from '../../src/douyin/feed-store.ts';
import {DouyinPlaybackQueue} from '../../src/douyin/playback-queue.ts';
import type {DouyinVideoVariant,DouyinItem} from '../../src/douyin/types.ts';

test('same input vectors produce byte-identical URLs to actual compiled native selector',()=>{
 for(const c of fixture.cases)expect(selectPreferredDouyinUrl(c.variants as DouyinVideoVariant[],c.fallback)??null,c.name).toBe(c.expected);
});
test('native codec policy vectors: minimum two, strictly more than half, session-sticky',()=>{
 const p=new DouyinCodecRuntimePolicy();p.recordAutoHevcAttempt();p.recordAutoHevcFailure();expect(p.shouldPreferH264InAutoMode()).toBe(false);expect(p.snapshot()).toEqual({autoHevcAttempts:1,autoHevcFailures:1,autoForceH264:false});p.recordAutoHevcAttempt();expect(p.shouldPreferH264InAutoMode()).toBe(false);expect(p.recordAutoHevcFailure()).toBe(true);p.recordAutoHevcAttempt();p.recordAutoHevcAttempt();expect(p.snapshot()).toEqual({autoHevcAttempts:4,autoHevcFailures:2,autoForceH264:true});
});
test('feed, detail and old persisted queue converge on selected URL without mutating original',()=>{
 const raw={aweme_id:'selection',video:{play_addr:{url_list:['https://example.com/original']},bit_rate:[{codec_type:'h264',bit_rate:1000,video_extra:{definition:'540p'},play_addr:{url_list:['https://example.com/selected'],width:960,height:540}},{codec_type:'h265',bit_rate:2000,play_addr:{url_list:['https://example.com/hevc']}}]}};
 const feed=parseDouyinFeed(JSON.stringify({aweme_list:[raw]})).items[0]!;const detail=parseDouyinDetail(JSON.stringify({aweme_detail:raw}));expect(feed.playUrl).toBe('https://example.com/selected');expect(detail).toMatchObject({kind:'video',item:{playUrl:feed.playUrl}});
 const old={...feed,playUrl:'https://example.com/original'};expect(normalizeItems([old])[0]!.playUrl).toBe(feed.playUrl);expect(new DouyinPlaybackQueue({} as any,{items:[old],selectedAwemeId:old.awemeId}).snapshot().item?.playUrl).toBe(feed.playUrl);expect(old.playUrl).toBe('https://example.com/original');
 expect(applyPreferredDouyinPlayback({...old,playUrl:'https://example.com/hevc',variants:[{playUrl:'https://example.com/hevc',codec:'h265',bitrate:1,width:1,height:1}]} as DouyinItem).playUrl).toBe('');
});

test('history, favorites, saved queues and concurrent TTL refresh all retain native selection',async()=>{
 const {DouyinClient}=await import('../../src/douyin/client.ts');const video={awemeId:'saved',playUrl:'https://example.com/old',variants:[{playUrl:'https://example.com/h264-540.mp4',codec:'h264',bitrate:1000,width:960,height:540,definition:'540p'}]} as DouyinItem;
 let release!:()=>void,calls=0;const gate=new Promise<void>(r=>release=r);const values=new Map([['douyin.cookie','fixture'],['douyin.history.v1',JSON.stringify([{item:video,watchedAtMillis:1}])],['douyin.playback-queue.v1',JSON.stringify({items:[video],anchorAwemeId:'saved'})]]);
 const client=new DouyinClient({secureStorage:{get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}},savedStore:{list:async()=>[{item:video}] as any,state:async()=>({favorite:true,watchLater:false}),set:async()=>true,toggle:async()=>false},signer:{sign:()=>''},transport:{request:async()=>{calls++;await gate;return {status:200,headers:{},body:new TextEncoder().encode(JSON.stringify({aweme_detail:{aweme_id:'saved',video:{play_addr:{url_list:['https://example.com/default']},bit_rate:[{codec_type:'h264',video_extra:{definition:'540p'},play_addr:{url_list:['https://example.com/h264-540.mp4'],width:960,height:540}}]}}}))};}}});
 expect((await client.listHistory())[0]!.item.playUrl).toBe('https://example.com/h264-540.mp4');expect((await client.listSaved())[0]!.item.playUrl).toBe('https://example.com/h264-540.mp4');expect((await client.restorePlaybackQueue()).items[0]!.playUrl).toBe('https://example.com/h264-540.mp4');
 const a=client.resolvePlayback('saved'),b=client.resolvePlayback('saved');release();const both=await Promise.all([a,b]);expect(calls).toBe(1);expect(both).toMatchObject([{ok:true,data:{playUrl:'https://example.com/h264-540.mp4'}},{ok:true,data:{playUrl:'https://example.com/h264-540.mp4'}}]);
});
