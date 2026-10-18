import {expect,test} from 'bun:test';
import {douyinVariantSummary} from '../../src/douyin/playback-diagnostics.ts';
import {parseDouyinFeed} from '../../src/douyin/parser.ts';
import {applyPreferredDouyinPlayback} from '../../src/douyin/playback-selector.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';

test('real feed shape: HEVC-only 540 variants leave H2641080 as the native-compatible choice',()=>{
 const item=parseDouyinFeed(JSON.stringify({aweme_list:[{aweme_id:'fixture',video:{bit_rate:[
  {is_h265:1,gear_name:'hevc_540',bit_rate:350000,play_addr:{url_list:['hevc540'],width:1024,height:576}},
  {is_h265:1,gear_name:'hevc_720',bit_rate:500000,play_addr:{url_list:['hevc720'],width:1280,height:720}},
 ],play_addr_h264:{url_list:['avc1080'],width:1920,height:1080},play_addr:{url_list:['avc1080'],width:1920,height:1080}}}]})).items[0]!;
 expect(item.playUrl).toBe('avc1080');expect(douyinVariantSummary(item)).toMatchObject({count:3,selected:2});
 expect(applyPreferredDouyinPlayback({...item,playUrl:'hevc540'}).playUrl).toBe('avc1080');
});
test('variant summaries never export identity, URL, arbitrary codec/label values or headers',()=>{
 const item={awemeId:'PRIVATE_ID',title:'PRIVATE_TITLE',headers:{Cookie:'PRIVATE_COOKIE'},variants:[{playUrl:'https://private.example/?secret=PRIVATE_URL',codec:'PRIVATE_CODEC',width:1920,height:1080,bitrate:0,definition:'PRIVATE_LABEL 1080p'}]}as unknown as DouyinItem;
 const summary=douyinVariantSummary(item),text=JSON.stringify(summary);
 expect(summary.variants[0]).toMatchObject({codec:'unknown',resolution:1080});expect(text).not.toContain('PRIVATE');expect(text).not.toContain('https');
});
