import {test,expect} from 'bun:test';
import {douyinPreloadAllowed} from '../../src/douyin/preload.ts';
import {douyinProxyWindow,douyinPreviewBytes,douyinPrefetchBytes,douyinPrefetchBandwidth,DOUYIN_PROXY} from '../../src/douyin/proxy-policy.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';
const item=(id:string)=>({awemeId:id,playUrl:'https://example.test/'+id}) as DouyinItem;
test('watch proxy window retains current, six forward, three backward without wrapping at end',()=>{
 const items=['a','b','c','d','e','f','g','h','i'].map(item);
 expect(douyinProxyWindow(items,'f','active').map(x=>x.awemeId)).toEqual(['f','g','e','d','c','h','i']);
 expect(douyinProxyWindow(items,'i','active').map(x=>x.awemeId)).toEqual(['i','h','g','f']);
 expect(douyinProxyWindow(items,'b','entry').map(x=>x.awemeId)).toEqual(['b','c','d','e','f','g','h']);
 expect(douyinProxyWindow(Array.from({length:20},(_,i)=>item(String(i))),'10','active').map(x=>x.awemeId)).toEqual(['10','11','9','8','7','12','13','14','15','16']);
 expect(douyinProxyWindow([item('a'),item('a'),item('b')],'a','entry').map(x=>x.awemeId)).toEqual(['a','b']);
});
test('watch 1.5s sample budgets and foreground bandwidth reserve',()=>{
 expect(douyinPreviewBytes(10*1024*1024,60000)).toBe(393216);
 expect(douyinPreviewBytes(1024*1024,60000)).toBe(157287);
 expect(douyinPreviewBytes(undefined,1000)).toBe(229376);
 expect(douyinPreviewBytes(undefined,0)).toBe(229376);
 expect([0,1,2,3,4,7].map(i=>douyinPrefetchBytes(undefined,60000,i))).toEqual(Array(6).fill(229376));
 expect(douyinPrefetchBandwidth(undefined,undefined)).toBe(Infinity);expect(douyinPrefetchBandwidth(1000000,undefined)).toBe(0);expect(douyinPrefetchBandwidth(1000000,200000)).toBe(37500);expect(douyinPrefetchBandwidth(1000000,100000)).toBe(0);
 expect(DOUYIN_PROXY.maxTotalBytes).toBe(16*1024*1024);
});
test('preload policy requires validated allowed transport; Bluetooth needs route consent',()=>{
 const n={active:true,internet:true,validated:true,wifi:false,cellular:false,bluetooth:false};
 expect(douyinPreloadAllowed({...n,wifi:true})).toBe(true);expect(douyinPreloadAllowed({...n,cellular:true})).toBe(true);expect(douyinPreloadAllowed({...n,bluetooth:true})).toBe(false);expect(douyinPreloadAllowed({...n,bluetooth:true},true)).toBe(true);expect(douyinPreloadAllowed({...n,wifi:true,validated:false},true)).toBe(false);
});

import nativePolicy from './proxy-native-fixture.json';
test('legacy native vectors obey bounded watch budgets at every prefetch order',()=>{
 for(const c of nativePolicy.cases){const bytes=douyinPreviewBytes(c.length??undefined,c.duration);expect(bytes).toBeGreaterThan(0);expect(bytes).toBeLessThanOrEqual(DOUYIN_PROXY.maxEntryBytes);expect(douyinPrefetchBytes(c.length??undefined,c.duration,c.order)).toBe(douyinPrefetchBytes(c.length??undefined,c.duration,0));}
});
