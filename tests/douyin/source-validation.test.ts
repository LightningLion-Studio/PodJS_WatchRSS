import {expect,test} from 'bun:test';
import {parseDouyinFeed} from '../../src/douyin/parser.ts';
import {DouyinClient} from '../../src/douyin/client.ts';
const wire=(id:string,urls:string[])=>({aweme_id:id,video:{play_addr:{url_list:urls,width:960,height:540},duration:1000}});
test('invalid DASH companion cannot turn the video-only source into a muxed fallback',()=>{
 const row={aweme_id:'dash',video:{duration:1000,play_addr:{url_list:['https://fixture.invalid/video-only']},bit_rate:[{format:'dash',codec_type:'h264',play_addr:{url_list:['https://fixture.invalid/video-only'],width:960,height:540}}],bit_rate_audio:[{audio_meta:{codec_type:'aac',url_list:{main_url:'https://PRIVATE@fixture.invalid/audio'}}}]}};
 expect(parseDouyinFeed(JSON.stringify({aweme_list:[row]})).items).toEqual([]);
});
test('feed selects an existing valid mirror before publishing a cache source',()=>{
 const first='podjs-media-cache://play/not-a-network-source';
 const page=parseDouyinFeed(JSON.stringify({aweme_list:[wire('source',[first,'https://fixture.invalid/video?signature=opaque'])]}));
 expect(page.items).toHaveLength(1);expect(page.items[0].playUrl).toBe('https://fixture.invalid/video?signature=opaque');
 expect(page.items[0].variants[0].playUrls).toEqual(['https://fixture.invalid/video?signature=opaque']);
});
test('feed rejects native-invalid sources and oversized registration keys without requests',()=>{
 const invalid=['https://user:PRIVATE@fixture.invalid/video','https://:443/video','https:///video','HTTPS://fixture.invalid/video','https://fixture.invalid/'+ 'x'.repeat(32768),'file:///PRIVATE'];
 expect(parseDouyinFeed(JSON.stringify({aweme_list:invalid.map((url,i)=>wire(String(i),[url]))})).items).toEqual([]);
 expect(parseDouyinFeed(JSON.stringify({aweme_list:[wire('x'.repeat(2049),['https://fixture.invalid/video'])]})).items).toEqual([]);
});
test('persisted queue metadata is validated before native registration without a detail request',async()=>{
 let requests=0;
 const client=new DouyinClient({secureStorage:{get:async()=>null,set:async()=>{},remove:async()=>{}},signer:{sign:()=> 'offline'},transport:{request:async()=>{requests++;throw Error('no request authorized by this test');}}});
 const item={awemeId:'source',description:'',createdAtSeconds:0,authorId:'',authorName:'',likeCount:0,commentCount:0,shareCount:0,collectCount:0,durationMs:1000,playUrl:'podjs-media-cache://play/stale',variants:[{playUrl:'podjs-media-cache://play/stale',playUrls:['podjs-media-cache://play/stale','https://fixture.invalid/video'],codec:'h264' as const,width:960,height:540,bitrate:100000}]};
 const valid=await client.resolvePlayback('source',{feedItem:item,allowDetail:false});expect(valid.ok).toBe(true);if(valid.ok)expect(valid.data.playUrl).toBe('https://fixture.invalid/video');
 const invalid=await client.resolvePlayback('source',{feedItem:{...item,variants:[]},allowDetail:false});expect(invalid.ok).toBe(false);if(!invalid.ok)expect(invalid.code).toBe('UNSUPPORTED');expect(requests).toBe(0);
});

test('persisted HTTP validation cannot restore an over-limit source before runtime probing',async()=>{
 const {validatedDouyinPlaybackItem}=await import('../../src/douyin/playback-source.ts');
 const high={playUrl:'https://fixture.invalid/4k',codec:'h264' as const,width:3840,height:2160,bitrate:1,gearName:'avc_480'};
 const safe={playUrl:'https://fixture.invalid/480',codec:'h264' as const,width:480,height:854,bitrate:100};
 const item={awemeId:'cap',playUrl:high.playUrl,variants:[high,safe]};
 const selected=validatedDouyinPlaybackItem(item as any);
 expect(selected.playUrl).toBe(safe.playUrl);expect(selected.variants).toEqual([safe]);
 const rejected=validatedDouyinPlaybackItem({...item,variants:[high]} as any);
 expect(rejected.playUrl).toBe('');expect(rejected.variants).toEqual([]);
});

test('a timed-out player reuses its valid feed source without fetching random recommendations',async()=>{
 const {reloadDouyinPlayback}=await import('../../src/douyin/reload-playback.ts');let requests=0;
 const client=new DouyinClient({secureStorage:{get:async key=>key==='douyin.cookie'?'fixture':null,set:async()=>{},remove:async()=>{}},signer:{sign:()=> 'offline'},transport:{request:async()=>{requests++;throw Error('unexpected network refresh');}}});
 const url='https://fixture.invalid/current?x-expires=4102444800';
 const item={awemeId:'current',playUrl:url,variants:[{playUrl:url,codec:'h264',width:960,height:540,bitrate:1000}]};
 expect((await reloadDouyinPlayback(client,item.awemeId,()=>true,item as any,true))?.item.playUrl).toBe(url);expect(requests).toBe(0);
});
test('retrying the current source still rejects an explicitly expired URL',async()=>{
 const {reloadDouyinPlayback}=await import('../../src/douyin/reload-playback.ts');let requests=0;
 const client=new DouyinClient({secureStorage:{get:async key=>key==='douyin.cookie'?'fixture':null,set:async()=>{},remove:async()=>{}},signer:{sign:()=> 'offline'},transport:{request:async()=>{requests++;return {status:200,headers:{},body:new TextEncoder().encode(JSON.stringify({aweme_list:[],has_more:0}))};}}});
 const url='https://fixture.invalid/expired?x-expires=1000000000',item={awemeId:'expired',playUrl:url,variants:[{playUrl:url,codec:'h264',width:960,height:540,bitrate:1000}]};
 await expect(reloadDouyinPlayback(client,item.awemeId,()=>true,item as any,true)).rejects.toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});expect(requests).toBe(1);
});
