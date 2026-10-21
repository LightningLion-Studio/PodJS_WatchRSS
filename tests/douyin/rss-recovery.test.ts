import {expect,test} from "bun:test";
import {DouyinRssRecovery} from "../../src/douyin/rss-recovery.ts";
import {DouyinClient} from "../../src/douyin/client.ts";
import {utf8Encode} from "../../src/cloud/types.ts";
import type {PlaybackSource} from "../../src/ui/VideoPlayerScreen.tsx";
const source:PlaybackSource={url:"https://video/stale",platform:"rss",title:"RSS title",webUrl:"https://www.douyin.com/video/7",backgroundPlayback:true,digitalCrownVolume:true};
function fixture(){
  let calls=0,fail=false;const options:boolean[]=[];
  const client=new DouyinClient({secureStorage:{get:async()=>"sessionid=test",set:async()=>{},remove:async()=>{}},signer:{sign:()=>"signed"},transport:{async request(){calls++;return {status:fail?503:200,headers:{},body:utf8Encode(JSON.stringify({aweme_detail:{aweme_id:"7",desc:"Remote title",video:{play_addr:{url_list:[`https://video/fresh-${calls}`]}}}}))};}}});
  const resolve=client.resolvePlayback.bind(client);client.resolvePlayback=async(id,opts)=>{options.push(!!opts?.forceRefresh);return resolve(id,opts);};
  return {client,options,calls:()=>calls,fail:()=>{fail=true;},restore:()=>{fail=false;}};
}
test("RSS failure forces network beyond fresh C3 cache and preserves RSS player settings",async()=>{
  const f=fixture();await f.client.resolvePlayback("7");const recovery=new DouyinRssRecovery(f.client,"7");
  const result=await recovery.recover(source,()=>true);
  expect(result).toMatchObject({...source,url:"https://video/fresh-2"});expect(result?.headers).toBeDefined();expect(f.options).toEqual([false,true]);
  expect(await recovery.recover(result!,()=>true)).toBeUndefined();expect(f.calls()).toBe(2);
  expect(await recovery.recover(result!,()=>true,true)).toMatchObject({url:"https://video/fresh-3"});
});
test("failed forced resolution never reuses cached/failed URL; manual retry can recover",async()=>{
  const f=fixture();await f.client.resolvePlayback("7");f.fail();const recovery=new DouyinRssRecovery(f.client,"7");
  await expect(recovery.recover(source,()=>true)).rejects.toThrow("503");expect(f.calls()).toBe(2);
  expect(await recovery.recover(source,()=>true)).toBeUndefined();f.restore();
  expect(await recovery.recover(source,()=>true,true)).toMatchObject({url:"https://video/fresh-3"});
});
test("coalesces errors and ignores completion after navigating away",async()=>{
  const f=fixture();let release!:()=>void,current=true;const gate=new Promise<void>(r=>release=r),resolve=f.client.resolvePlayback.bind(f.client);
  f.client.resolvePlayback=async(id,options)=>{await gate;return resolve(id,options);};
  const recovery=new DouyinRssRecovery(f.client,"7"),pending=recovery.recover(source,()=>current);
  expect(await recovery.recover(source,()=>current,true)).toBeUndefined();current=false;release();
  expect(await pending).toBeUndefined();expect(f.calls()).toBe(1);
  expect(await recovery.recover(source,()=>current,true)).toBeUndefined();expect(f.calls()).toBe(1);
});
