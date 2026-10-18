import {expect,test} from 'bun:test';
import {createMediaTransport} from '../../src/media/transport.ts';
import {DouyinClient} from '../../src/douyin/client.ts';
import {AppLogger,installAppLogger} from '../../src/logs/app-logger.ts';
import {utf8Encode} from '../../src/cloud/types.ts';
import type {DownloadResult} from '@podjs/framework/services';

function fixture(){
  const args:Record<string,unknown>[]=[],removed:string[]=[];let status=200,error:unknown,body=utf8Encode('{"aweme_list":[]}');
  const transport=createMediaTransport({
    download:async value=>{args.push(value);if(error)throw error;return {path:value.path as string,size:body.length,status,headers:{}} as DownloadResult;},
    read:async(_path,offset)=>body.slice(offset,offset+3),remove:async path=>{removed.push(path);},base64:bytes=>Buffer.from(bytes).toString('base64'),
  });
  const client=new DouyinClient({transport,signer:{sign:()=> 'PRIVATE_SIGNATURE'},secureStorage:{get:async key=>key==='douyin.cookie'?'sessionid=PRIVATE_COOKIE':null,set:async()=>{},remove:async()=>{}}});
  return {transport,client,args,removed,setStatus:(value:number)=>status=value,setError:(value:unknown)=>error=value,setBody:(value:string)=>body=utf8Encode(value)};
}

test('real Douyin transport applies native 10s connection/read budgets and returns HTTP status to the client',async()=>{
  const f=fixture();f.setStatus(503);
  expect(await f.client.fetchFeedPage({count:16})).toEqual({ok:false,code:'REQUEST_FAILED',message:'请求失败，状态码：503（仅支持200）'});
  expect(f.args[0]).toMatchObject({method:'POST',bodyBase64:'',timeoutMs:10_000,readTimeoutMs:10_000,acceptHttpErrors:true,maxBytes:8*1024*1024});
  expect(f.removed).toEqual([f.args[0]!.path as string]);
});

test('media transport keeps other callers defaults and cleans partial downloads on timeout',async()=>{
  const f=fixture();
  await f.transport.request({method:'GET',url:'https://api.test/feed',headers:{}});
  expect(f.args[0]?.timeoutMs).toBe(30_000);expect(f.args[0]).not.toHaveProperty('readTimeoutMs');expect(f.args[0]).not.toHaveProperty('acceptHttpErrors');
  f.setError({code:'host_error',message:'SocketTimeoutException: timeout'});
  expect(await f.client.fetchFeedPage()).toEqual({ok:false,code:'REQUEST_FAILED',message:'网络请求失败'});
  expect(f.removed).toHaveLength(2);
});

test('request logs retain status and error category without raw signing, token, cookie or query text',async()=>{
  let log='';const logger=new AppLogger({read:async()=>log,size:async()=>log.length,replace:async value=>{log=value;},append:async value=>{log+=value;}});installAppLogger(logger);
  const f=fixture();
  f.setStatus(403);await f.client.fetchFeedPage();
  f.setError({code:'host_error',message:'SocketTimeoutException: https://www.douyin.com/?a_bogus=PRIVATE_SIGNATURE&msToken=PRIVATE_TOKEN Cookie: sessionid=PRIVATE_COOKIE'});await f.client.fetchFeedPage();
  const signerFailure=new DouyinClient({transport:f.transport,signer:{sign(){throw Error('SIGNER_PRIVATE_DETAIL');}},secureStorage:{get:async key=>key==='douyin.cookie'?'sessionid=PRIVATE_COOKIE':null,set:async()=>{},remove:async()=>{}}});
  await signerFailure.fetchFeedPage();await logger.flush();
  expect(log).toContain('category=http status=403');expect(log).toContain('category=timeout');expect(log).toContain('category=signing');
  expect(log).not.toMatch(/PRIVATE|a_bogus|msToken|sessionid|Cookie:/);
});
