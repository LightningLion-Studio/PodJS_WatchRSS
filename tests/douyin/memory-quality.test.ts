import {afterEach,expect,test} from 'bun:test';
import {dispatchMemoryPressure} from '@podjs/framework/memory';
import {normalizeItems} from '../../src/douyin/feed-store.ts';
import {parseDouyinItem} from '../../src/douyin/parser.ts';
import {selectPreferredDouyinVariant} from '../../src/douyin/playback-selector.ts';
import type {DouyinVideoVariant} from '../../src/douyin/types.ts';
const saved=(globalThis as any).pod;
afterEach(()=>{(globalThis as any).pod=saved;dispatchMemoryPressure({t:'memory.pressure',level:0});});
const variant=(width:number):DouyinVideoVariant=>({playUrl:`http://127.0.0.1/${width}.mp4`,codec:'h264',bitrate:width,width,height:Math.round(width*16/9)});
test('128 MB pressure selects a lower tier for a future source and recovers without sticky codec failure',()=>{
 (globalThis as any).pod={memoryBudgetBytes:()=>128000000};const variants=[variant(720),variant(480),variant(320)];
 expect(selectPreferredDouyinVariant(variants)?.width).toBe(480);
 dispatchMemoryPressure({t:'memory.pressure',level:2});expect(selectPreferredDouyinVariant(variants)?.width).toBe(320);
 dispatchMemoryPressure({t:'memory.pressure',level:0});expect(selectPreferredDouyinVariant(variants)?.width).toBe(480);
});
test('one source and unknown dimensions remain eligible; legacy projects keep their quality selection',()=>{
 (globalThis as any).pod={memoryBudgetBytes:()=>128000000};dispatchMemoryPressure({t:'memory.pressure',level:3});
 expect(selectPreferredDouyinVariant([variant(720)])?.width).toBe(720);
 const unknown={...variant(0),height:0};expect(selectPreferredDouyinVariant([unknown])).toBe(unknown);
 (globalThis as any).pod=undefined;expect(selectPreferredDouyinVariant([variant(480),variant(320)])?.width).toBe(480);
});
test('feed ingress keeps the 720P cap while a reused item follows memory pressure',()=>{
 (globalThis as any).pod={memoryBudgetBytes:()=>128000000};
 const rows=[1080,720,480,320].map(width=>{
  const v=variant(width);
  return {width:v.width,height:v.height,codec_type:'h264',bit_rate:v.bitrate,play_addr:{url_list:[v.playUrl]}};
 });
 const item=parseDouyinItem({aweme_id:'memory-pressure',video:{bit_rate:rows}});
 expect(item?.variants.map(v=>v.width)).toEqual([720,480,320]);
 if(!item)throw new Error('Expected an admitted Douyin item');
 expect(normalizeItems([item])[0]?.playUrl).toBe(variant(480).playUrl);
 dispatchMemoryPressure({t:'memory.pressure',level:2});
 expect(normalizeItems([item])[0]?.playUrl).toBe(variant(320).playUrl);
 dispatchMemoryPressure({t:'memory.pressure',level:0});
 expect(normalizeItems([item])[0]?.playUrl).toBe(variant(480).playUrl);
});
