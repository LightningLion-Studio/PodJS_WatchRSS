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
  const client=new DouyinClient({auth403:{sleep:async()=>{}},transport,signer:{sign:()=> 'PRIVATE_SIGNATURE'},secureStorage:{get:async key=>key==='douyin.cookie'?'sessionid=PRIVATE_COOKIE':null,set:async()=>{},remove:async()=>{}}});
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
  expect(await f.client.fetchFeedPage()).toEqual({ok:false,code:'REQUEST_FAILED',message:'网络请求失败',networkFailure:true});
  expect(f.removed).toHaveLength(2);
});

test('foreground media reads the existing response after byte bridge pressure without another download',async()=>{
  const body=Uint8Array.from({length:70_000},(_,i)=>i%251);
  const downloads:string[]=[],removed:string[]=[],reads:Array<[string,number]>=[];
  const transport=createMediaTransport({
    download:async args=>{downloads.push(String(args.path));return {path:String(args.path),size:body.length,status:200,headers:{}} as DownloadResult;},
    read:async(_path,offset)=>{
      reads.push(['binary',offset]);
      if(offset>0)throw Object.assign(Error('Byte bridge full'),{code:'busy'});
      return body.slice(0,32768);
    },
    readPortable:async(_path,offset)=>{reads.push(['portable',offset]);return body.slice(offset,offset+16384);},
    remove:async path=>{removed.push(path);},base64:()=> '',
  });
  const response=await transport.request({method:'POST',url:'https://media.test/feed',headers:{}});
  expect(response.status).toBe(200);
  expect(response.body).toEqual(body);
  expect(reads).toEqual([['binary',0],['binary',32768],['portable',32768],['portable',49152],['portable',65536]]);
  expect(downloads).toHaveLength(1);
  expect(removed).toEqual(downloads);
});

test('a failed local read preserves completed HTTP metadata and stays out of network recovery',async()=>{
  const previous=(globalThis as any).pod;
  const events:any[]=[];
  (globalThis as any).pod={...previous,benchmark:(event:string)=>{events.push(JSON.parse(event));return 1;}};
  try{
    const download=async(args:Record<string,unknown>)=>({path:String(args.path),size:48,status:200,headers:{}} as DownloadResult);
    let portableReads=0;
    const transport=createMediaTransport({download,read:async()=>{throw Object.assign(Error('Byte bridge full'),{code:'busy'});},
      readPortable:async()=>{portableReads++;throw Object.assign(Error('file_not_found'),{code:'host_error'});},
      remove:async()=>{},base64:()=>''});
    const client=new DouyinClient({transport,signer:{sign:()=>''},secureStorage:{get:async key=>key==='douyin.cookie'?'sessionid=test':null,set:async()=>{},remove:async()=>{}}});
    expect(await client.fetchFeedPage()).toEqual({ok:false,code:'REQUEST_FAILED',message:'网络请求失败'});
    expect(portableReads).toBe(1);
    expect(events.find(event=>event.code==='douyin_request')).toMatchObject({category:'feed',http_status:200,response_bytes:48,error_code:'decode'});
  }finally{(globalThis as any).pod=previous;}
});

test('the portable path is limited to foreground byte bridge backpressure',async()=>{
  const readPortable=async()=>{throw Error('Unexpected portable read');};
  const transport=createMediaTransport({
    download:async args=>({path:String(args.path),size:5,status:200,headers:{}} as DownloadResult),
    read:async()=>{throw Object.assign(Error('Byte bridge full'),{code:'busy'});},
    readPortable,remove:async()=>{},base64:()=> '',
  });
  await expect(transport.request({method:'GET',url:'https://media.test/feed',headers:{},background:{
    isCurrent:()=>true,onCancel:()=>()=>{},
  }})).rejects.toMatchObject({httpStatus:200,responseBytes:5,cause:{code:'busy',message:'Byte bridge full'}});
});

test('request logs retain status and error category without raw signing, token, cookie or query text',async()=>{
  let log='';const logger=new AppLogger({read:async()=>log,size:async()=>log.length,replace:async value=>{log=value;},append:async value=>{log+=value;}});installAppLogger(logger);
  const f=fixture();
  f.setStatus(403);await f.client.fetchFeedPage();
  const timedOut=fixture();timedOut.setError({code:'host_error',message:'SocketTimeoutException: https://www.douyin.com/?a_bogus=PRIVATE_SIGNATURE&msToken=PRIVATE_TOKEN Cookie: sessionid=PRIVATE_COOKIE'});await timedOut.client.fetchFeedPage();
  const signerFailure=new DouyinClient({transport:f.transport,signer:{sign(){throw Error('SIGNER_PRIVATE_DETAIL');}},secureStorage:{get:async key=>key==='douyin.cookie'?'sessionid=PRIVATE_COOKIE':null,set:async()=>{},remove:async()=>{}}});
  await signerFailure.fetchFeedPage();await logger.flush();
  expect(log).toContain('category=http status=403');expect(log).toContain('category=timeout');expect(log).toContain('category=signing');
  expect(log).not.toMatch(/PRIVATE|a_bogus|msToken|sessionid|Cookie:/);
});
