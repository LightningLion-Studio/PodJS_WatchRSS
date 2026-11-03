import {expect,test} from 'bun:test';
import {parseDouyinFeed,parseDouyinFeedAsync} from '../../src/douyin/parser.ts';
import {douyinDecoderProfile} from '../../src/ui/douyin/video-sessions.ts';
import {DouyinFeedStore,FEED_KEY} from '../../src/douyin/feed-store.ts';
import {DouyinRssRecovery} from '../../src/douyin/rss-recovery.ts';
import {DouyinPlaybackRecovery} from '../../src/douyin/playback-recovery.ts';

// Same schema observed in a live web feed. All addresses and IDs are synthetic.
const row={aweme_id:'sound-fixture',video:{play_addr:{url_list:['https://fixture/muxed.mp4'],width:1920,height:1080},
 bit_rate:[{format:'dash',gear_name:'h264_540',bit_rate:200000,play_addr:{url_list:['https://fixture/video-only.mp4','https://mirror/video-only.mp4'],width:960,height:540}}],
 bit_rate_audio:[{audio_quality:1,audio_meta:{codec_type:'mp4a',bitrate:64000,url_list:{main_url:'https://fixture/audio.m4a',backup_url:'https://mirror/audio.m4a'}}}]}};
test('feed projection retains DASH companion audio from the same video',async()=>{
 const raw=JSON.stringify({aweme_list:[row]});
 const sync=parseDouyinFeed(raw),asyncPage=await parseDouyinFeedAsync(raw);
 expect(asyncPage).toEqual(sync);
 const item=asyncPage.items[0]!;
 expect(item.playUrl).toBe('https://fixture/video-only.mp4');
 expect(douyinDecoderProfile(item)).toMatchObject({audioUrl:'https://fixture/audio.m4a',videoMime:'video/avc'});
 // A CDN retry retains the same audio companion.
 expect(douyinDecoderProfile(item,'https://mirror/video-only.mp4')).toMatchObject({audioUrl:'https://fixture/audio.m4a'});
});
test('a DASH rendition without companion audio yields to the muxed source',()=>{
 const item=parseDouyinFeed(JSON.stringify({aweme_list:[{...row,video:{...row.video,bit_rate_audio:[]}}]})).items[0]!;
 expect(item.playUrl).toBe('https://fixture/muxed.mp4');
 expect(douyinDecoderProfile(item).audioUrl).toBeUndefined();
});
test('cold feed restoration preserves the selected video/audio pair',async()=>{
 const item=parseDouyinFeed(JSON.stringify({aweme_list:[row]})).items[0]!;
 const values=new Map<string,string>();const storage={get:async(k:string)=>values.get(k)??null,set:async(k:string,v:string)=>{values.set(k,v);},remove:async(k:string)=>{values.delete(k);}};
 await new DouyinFeedStore(storage).save(FEED_KEY,{items:[item],anchorAwemeId:item.awemeId,cursor:null,hasMore:false,savedAtMillis:1,resolved:{[item.awemeId]:1}});
 const restored=(await new DouyinFeedStore(storage).read(FEED_KEY)).items[0]!;
 expect(douyinDecoderProfile(restored).audioUrl).toBe('https://fixture/audio.m4a');
});
test('switching from DASH to muxed playback removes the previous companion',()=>{
 const item=parseDouyinFeed(JSON.stringify({aweme_list:[row]})).items[0]!;
 const outgoing={audioUrl:'https://fixture/previous.m4a'};
 const next={...outgoing,...douyinDecoderProfile({...item,playUrl:'https://fixture/muxed.mp4'})};
 expect(next.audioUrl).toBeUndefined();
});
test('RSS detail recovery adopts companion audio from the refreshed Douyin item',async()=>{
 const item=parseDouyinFeed(JSON.stringify({aweme_list:[row]})).items[0]!;
 const recovery=new DouyinRssRecovery({resolvePlayback:async()=>({ok:true,data:item}),buildPlaybackHeaders:async()=>({Referer:'https://www.douyin.com/'})},item.awemeId);
 const source=await recovery.recover({url:'https://fixture/expired.mp4',title:'fixture',audioUrl:'https://fixture/expired.m4a'},()=>true);
 expect(source).toMatchObject({url:item.playUrl,audioUrl:'https://fixture/audio.m4a'});
});
test('CDN and metadata refreshes keep the audio companion bound to the selected video',async()=>{
 const item=parseDouyinFeed(JSON.stringify({aweme_list:[row]})).items[0]!;
 const recovery=new DouyinPlaybackRecovery(item,async()=>({...item,playUrl:'https://fixture/fresh.mp4',variants:[]}));
 const first=await recovery.recover({url:item.playUrl,title:'fixture'},()=>true);
 expect(first).toMatchObject({url:'https://mirror/video-only.mp4',audioUrl:'https://fixture/audio.m4a'});
 const second=await recovery.recover(first!,()=>true);
 expect(second?.audioUrl).toBeUndefined();
});
