import {expect,test} from 'bun:test';
import {parseDouyinDetail} from '../../src/douyin/parser.ts';
import {DouyinPlaybackRecovery,douyinPlaybackCandidates} from '../../src/douyin/playback-recovery.ts';
import type {DouyinItem} from '../../src/douyin/types.ts';
const timer=()=>({result:new Promise<unknown>(()=>{}),cancel(){}});
const item={awemeId:'fixture',playUrl:'https://fixture/a',variants:[{playUrl:'https://fixture/a',playUrls:['https://fixture/a','https://fixture/b','https://fixture/a'],codec:'h264',bitrate:200,width:640,height:360},{playUrl:'https://fixture/hevc',playUrls:['https://fixture/hevc'],codec:'h265',bitrate:100,width:640,height:360}]} as DouyinItem;
test('parser keeps the complete ordered same-track URL list, old snapshots still work',()=>{
 const parsed=parseDouyinDetail(JSON.stringify({aweme_detail:{aweme_id:'fixture',video:{play_addr_h264:{url_list:[' https://fixture/a ','https://fixture/b','https://fixture/a','',null]}}}}));
 expect(parsed).toMatchObject({kind:'video',item:{variants:[{playUrl:'https://fixture/a',playUrls:['https://fixture/a','https://fixture/b']}]}});
 expect(douyinPlaybackCandidates({...item,variants:[{...item.variants[0]!,playUrls:undefined}]})).toEqual(['https://fixture/a']);
});
test('same-track fallback precedes one refresh and keeps progress and settings',async()=>{
 let calls=0;const p=new DouyinPlaybackRecovery(item,async()=>{calls++;return {...item,playUrl:'https://fixture/fresh',variants:[]};});
 const first=await p.recover({url:item.playUrl,title:'fixture',resumePositionMs:12345,backgroundPlayback:true},()=>true);
 expect(first).toMatchObject({url:'https://fixture/b',resumePositionMs:12345,backgroundPlayback:true});expect(calls).toBe(0);
 const second=await p.recover(first!,()=>true);expect(second?.url).toBe('https://fixture/fresh');expect(calls).toBe(1);
 await expect(p.recover(second!,()=>true)).rejects.toThrow('exhausted');expect(calls).toBe(1);
});
test('stale generation, restricted response, concurrent failures and total deadline',async()=>{
 let calls=0,current=true,finish!:(v:DouyinItem)=>void,now=0;
 const p=new DouyinPlaybackRecovery({...item,variants:[]},()=>{calls++;return new Promise(r=>finish=r);},()=>now,timer);
 const work=p.recover({url:item.playUrl,title:'fixture'},()=>current);expect(await p.recover({url:item.playUrl,title:'fixture'},()=>current)).toBeUndefined();
 current=false;finish(item);expect(await work).toBeUndefined();expect(calls).toBe(1);
 await expect(p.recover({url:item.playUrl,title:'fixture'},()=>true,false,{status:403})).rejects.toThrow('not_retryable');
 const deadline=new DouyinPlaybackRecovery(item,async()=>item,()=>now);const first=await deadline.recover({url:item.playUrl,title:'fixture'},()=>true);now=30001;
 await expect(deadline.recover(first!,()=>true)).rejects.toThrow('deadline');
});


test('explicit manual retry starts a new round and permits a freshly resolved unchanged URL',async()=>{
 const original={...item,variants:[]};let calls=0;const policy=new DouyinPlaybackRecovery(original,async()=>{calls++;return original;},Date.now,timer);
 await expect(policy.recover({url:original.playUrl,title:'fixture'},()=>true)).rejects.toThrow('exhausted');
 expect((await policy.recover({url:original.playUrl,title:'fixture',resumePositionMs:42},()=>true,true))?.resumePositionMs).toBe(42);expect(calls).toBe(2);
});
