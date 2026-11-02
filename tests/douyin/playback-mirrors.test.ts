import {test,expect} from 'bun:test';
import {douyinPlaybackMirrors} from '../../src/douyin/playback-mirrors.ts';
import type {DouyinItem,DouyinVideoVariant} from '../../src/douyin/types.ts';
const variant=(url:string,urls:string[],codec='h264'):DouyinVideoVariant=>({playUrl:url,playUrls:urls,codec:codec as any,bitrate:100000,width:480,height:480});
const item=(playUrl:string,variants:DouyinVideoVariant[])=>({playUrl,variants}as DouyinItem);
test('only the selected rendition contributes one distinct same-scheme mirror',()=>{
 expect(douyinPlaybackMirrors(item('https://a.test/low',[variant('https://a.test/high',['https://b.test/high']),variant('https://a.test/low',['https://a.test/low','http://b.test/low','https://b.test/low','https://c.test/low'])]))).toEqual(['https://b.test/low']);
});
test('an alternate selected for playback retains only its own track candidates',()=>{
 expect(douyinPlaybackMirrors(item('https://b.test/hevc',[variant('https://a.test/avc',['https://b.test/avc']),variant('https://a.test/hevc',['https://b.test/hevc'],'h265')]))).toEqual(['https://a.test/hevc']);
});
test('old snapshots and unmatched sources do not race unrelated tracks',()=>{
 expect(douyinPlaybackMirrors({playUrl:'https://a.test/old'}as DouyinItem)).toEqual([]);
 expect(douyinPlaybackMirrors(item('https://a.test/new',[variant('https://a.test/old',['https://b.test/old'])]))).toEqual([]);
});
