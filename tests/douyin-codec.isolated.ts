import {expect,mock,test} from 'bun:test';
let supported:boolean|undefined,capable=true,calls:any[]=[];
mock.module('@podjs/framework/watch',()=>({hasCapability:()=>capable,kv:{get:()=>undefined}}));
mock.module('@podjs/framework/services',()=>({videoSessions:{capabilities:async(options:any)=>{calls.push(options);return {decoderSizeSupported:supported};}}}));
const {decodableDouyinItem}=await import('../src/media/video-opt.ts');
const {applyPreferredDouyinPlayback,douyinCodecRuntimePolicy}=await import('../src/douyin/playback-selector.ts');
const item=(width=540)=>({awemeId:'hevc',playUrl:'',variants:[{playUrl:'https://fixture/hevc',codec:'h265' as const,bitrate:100,width,height:960}]}) as any;
test('DYFIX absent/unknown/false codec capability never enables HEVC',async()=>{
 for(const value of [undefined,false]){supported=value;const result=await decodableDouyinItem(item(542));expect(result.playUrl).toBe('');}
 capable=false;supported=true;expect((await decodableDouyinItem(item(542))).playUrl).toBe('');expect(applyPreferredDouyinPlayback({...item(542),playUrl:'https://fixture/hevc'}).playUrl).toBe('');
});
test('DYFIX explicit HEVC size support enables fallback without the adaptive feature flag',async()=>{
 capable=true;supported=true;calls=[];const result=await decodableDouyinItem(item());expect(result.playUrl).toBe('https://fixture/hevc');expect(calls).toEqual([{videoMime:'video/hevc',videoWidth:540,videoHeight:960}]);
 for(let i=0;i<20;i++)expect((await decodableDouyinItem(item())).playUrl).toBe(result.playUrl);
 expect(calls).toHaveLength(1);
 expect(applyPreferredDouyinPlayback({...item(720),playUrl:'https://fixture/hevc'}).playUrl).toBe('');
 douyinCodecRuntimePolicy.confirmHevcSize({width:540,height:960},false);
});
test('confirmed unsupported geometry is shared by successive recommendations',async()=>{
 const clock=Date.now,base=Date.now();capable=true;supported=false;calls=[];
 try{
  Date.now=()=>base;
  for(let i=0;i<6;i++)expect((await decodableDouyinItem(item(478))).playUrl).toBe('');
  expect(calls).toHaveLength(1);
  Date.now=()=>base+60_001;supported=true;
  expect((await decodableDouyinItem(item(478))).playUrl).toBe('https://fixture/hevc');
  expect(calls).toHaveLength(2);
 }finally{Date.now=clock;}
});
