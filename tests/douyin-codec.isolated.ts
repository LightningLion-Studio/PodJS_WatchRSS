import {expect,mock,test} from 'bun:test';
let supported:boolean|undefined,capable=true,calls:any[]=[];
mock.module('@podjs/framework/watch',()=>({hasCapability:()=>capable,kv:{get:()=>undefined}}));
mock.module('@podjs/framework/services',()=>({videoSessions:{capabilities:async(options:any)=>{calls.push(options);return {decoderSizeSupported:supported};}}}));
const {decodableDouyinItem,preserveSelectedDouyinItem}=await import('../src/media/video-opt.ts');
const {applyPreferredDouyinPlayback,douyinCodecRuntimePolicy}=await import('../src/douyin/playback-selector.ts');
const item=(width=540)=>({awemeId:'hevc',playUrl:'',variants:[{playUrl:'https://fixture/hevc',codec:'h265' as const,bitrate:100,width,height:960}]}) as any;
test('DYFIX absent/unknown/false codec capability never enables HEVC',async()=>{
 for(const value of [undefined,false]){supported=value;const result=await decodableDouyinItem(item());expect(result.playUrl).toBe('');}
 capable=false;supported=true;expect((await decodableDouyinItem(item())).playUrl).toBe('');expect(applyPreferredDouyinPlayback({...item(),playUrl:'https://fixture/hevc'}).playUrl).toBe('');
});
test('DYFIX explicit HEVC size support enables fallback without the adaptive feature flag',async()=>{
 capable=true;supported=true;calls=[];const result=await decodableDouyinItem(item());expect(result.playUrl).toBe('https://fixture/hevc');expect(calls).toEqual([{videoMime:'video/hevc',videoWidth:540,videoHeight:960}]);expect(preserveSelectedDouyinItem(result).playUrl).toBe(result.playUrl);
 expect(applyPreferredDouyinPlayback({...item(720),playUrl:'https://fixture/hevc'}).playUrl).toBe('');
 douyinCodecRuntimePolicy.confirmHevcSize({width:540,height:960},false);
});
