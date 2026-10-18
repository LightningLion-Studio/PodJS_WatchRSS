import {test,expect} from 'bun:test';
import {douyinPreloadAllowed} from '../../src/douyin/preload.ts';
import {douyinProxyWindow,douyinPreviewBytes,douyinPrefetchBytes,douyinPrefetchBandwidth,DOUYIN_PROXY} from '../../src/douyin/proxy-policy.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';
const item=(id:string)=>({awemeId:id,playUrl:'https://example.test/'+id}) as DouyinItem;
test('native proxy window retains current, two forward, five backward without wrapping at end',()=>{
 const items=['a','b','c','d','e','f','g','h','i'].map(item);
 expect(douyinProxyWindow(items,'f','active').map(x=>x.awemeId)).toEqual(['f','g','h','e','d','c','b','a']);
 expect(douyinProxyWindow(items,'i','active').map(x=>x.awemeId)).toEqual(['i','h','g','f','e','d']);
 expect(douyinProxyWindow(items,'b','entry').map(x=>x.awemeId)).toEqual(['b','c','d']);
 expect(douyinProxyWindow([item('a'),item('a'),item('b')],'a','entry').map(x=>x.awemeId)).toEqual(['a','b']);
});
test('native 30s capture,16s prefix budgets, order and bandwidth reserve vectors',()=>{
 expect(douyinPreviewBytes(10*1024*1024,60000)).toBe(4*1024*1024);
 expect(douyinPreviewBytes(1024*1024,60000)).toBe(512*1024);
 expect(douyinPreviewBytes(undefined,1000)).toBe(512*1024);
 expect(douyinPreviewBytes(undefined,0)).toBe(4*1024*1024);
 expect([0,1,2,3,4,7].map(i=>douyinPrefetchBytes(undefined,60000,i))).toEqual([2097152,1572864,1048576,1048576,524288,524288]);
 expect(douyinPrefetchBandwidth(undefined,undefined)).toBe(Infinity);expect(douyinPrefetchBandwidth(1000000,undefined)).toBe(0);expect(douyinPrefetchBandwidth(1000000,200000)).toBe(37500);expect(douyinPrefetchBandwidth(1000000,100000)).toBe(0);
 expect(DOUYIN_PROXY.maxTotalBytes).toBe(16*1024*1024);
});
test('preload policy requires validated allowed transport; Bluetooth needs route consent',()=>{
 const n={active:true,internet:true,validated:true,wifi:false,cellular:false,bluetooth:false};
 expect(douyinPreloadAllowed({...n,wifi:true})).toBe(true);expect(douyinPreloadAllowed({...n,cellular:true})).toBe(true);expect(douyinPreloadAllowed({...n,bluetooth:true})).toBe(false);expect(douyinPreloadAllowed({...n,bluetooth:true},true)).toBe(true);expect(douyinPreloadAllowed({...n,wifi:true,validated:false},true)).toBe(false);
});

import nativePolicy from './proxy-native-fixture.json';
test('prefix budgets exactly match compiled native top-level functions over252 vectors',()=>{
 for(const c of nativePolicy.cases){expect(douyinPreviewBytes(c.length??undefined,c.duration)).toBe(c.preview);expect(douyinPrefetchBytes(c.length??undefined,c.duration,c.order)).toBe(c.prefetch);}
});
