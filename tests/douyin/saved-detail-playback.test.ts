import {afterEach,expect,test} from 'bun:test';
import {prepareSavedDetailPlayback} from '../../src/douyin/saved-detail-playback.ts';
import {installSavedIssueSink} from '../../src/douyin/saved-issue-events.ts';
import {DouyinClient} from '../../src/douyin/client.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';
const item={awemeId:'7',description:'private',playUrl:'https://cdn.invalid/old',variants:[]} as unknown as DouyinItem;
function fixture(){
 const client=new DouyinClient({secureStorage:{get:async()=> 'sessionid=fixture',set:async()=>{},remove:async()=>{}},transport:{request:async()=>({status:410,headers:{},body:new Uint8Array()})},signer:{sign:()=> 'fixture'}});
 client.listSaved=async()=>[{platform:'douyin',awemeId:'7',kind:'favorite',savedAtMillis:Date.now()-15*86400000,shareUrl:'',item}];
 return client;
}
afterEach(()=>installSavedIssueSink(undefined));
test('detail entry preserves old-media fallback and reports once only when playback fails',async()=>{
 const issues:unknown[]=[];installSavedIssueSink((c,e)=>issues.push({c,e}));
 const ready=await prepareSavedDetailPlayback(fixture(),item,()=>true);expect(ready?.playback).toBe(item);expect(issues).toHaveLength(0);
 ready!.diagnostic.playbackFailure({code:'source_expired'});ready!.diagnostic.playbackFailure({code:'network_error'});expect(issues).toHaveLength(1);
});
test('detail entry failure before player navigation reports parse failure; route departure is excluded',async()=>{
 const issues:unknown[]=[];installSavedIssueSink((c,e)=>issues.push({c,e}));
 await expect(prepareSavedDetailPlayback(fixture(),{...item,playUrl:'https://www.douyin.com/video/7'},()=>true)).rejects.toThrow();expect(issues).toHaveLength(1);
 let current=true;const client=fixture();client.resolvePlayback=async()=>{current=false;return {ok:false,code:'PARSE_FAILED',message:'fixture'};};
 expect(await prepareSavedDetailPlayback(client,item,()=>current)).toBeUndefined();expect(issues).toHaveLength(1);
});
