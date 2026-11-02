import {test,expect} from 'bun:test';
import {selectPreferredDouyinVariant} from '../../src/douyin/playback-selector.ts';
import {douyinPrefetchBytes,douyinProxyWindow} from '../../src/douyin/proxy-policy.ts';
import {stockPreviewBytes} from '../../src/douyin/stock.ts';
import type {DouyinItem,DouyinVideoVariant} from '../../src/douyin/types.ts';
const variant=(width:number,bitrate:number):DouyinVideoVariant=>({playUrl:`https://fixture/${width}/${bitrate}`,codec:'h264',width,height:width*16/9,bitrate});
test('watch uses the least expensive rendition that covers 466 px',()=>{
 const choices=[variant(540,1200000),variant(480,800000),variant(480,400000),variant(360,200000)];
 expect(selectPreferredDouyinVariant(choices)).toBe(choices[2]);
 expect(selectPreferredDouyinVariant([choices[0]!,{...variant(480,100),codec:'unknown'}])).toBe(choices[0]);
 expect(selectPreferredDouyinVariant([choices[0]!,variant(540,600000)])?.bitrate).toBe(600000);
});
test('both directions and three ahead get complete equal-time prefix budgets',()=>{
 const items='abcdefg'.split('').map(awemeId=>({awemeId,playUrl:'https://fixture/'+awemeId,variants:[variant(480,400000)],durationMs:60000})) as DouyinItem[];
 expect(douyinProxyWindow(items,'c','active').slice(0,5).map(x=>x.awemeId)).toEqual(['c','d','b','e','f']);
 const expected=128*1024+75000;
 expect([0,1,2,3].map(i=>douyinPrefetchBytes(undefined,60000,i,400000))).toEqual(Array(4).fill(expected));
 const item={...items[0]!,playUrl:items[0]!.variants[0]!.playUrl};expect(stockPreviewBytes(item)).toBe(expected);
});
