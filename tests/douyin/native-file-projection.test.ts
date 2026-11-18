import {expect,test} from 'bun:test';
import {CString,dlopen,FFIType,ptr} from 'bun:ffi';
import {mkdtempSync,openSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectJsonValue} from '@podjs/framework/json';
import type {DownloadResult,FileJsonProjection} from '@podjs/framework/services';
import {createMediaTransport,readProjectedRows} from '../../src/media/transport.ts';
import {DouyinClient} from '../../src/douyin/client.ts';
import {douyinFeedSelection,mapProjectedDouyinFeed,parseDouyinFeedAsync,parseDouyinItem} from '../../src/douyin/parser.ts';

const library=process.env.PODJS_FILE_JSON_TEST_LIB;
const fixture={
 status_code:0,max_cursor:42,has_more:1,
 unused:'x'.repeat(2_100_000),
 aweme_list:[
  {aweme_id:'offline-1',desc:'测试🙂',author:{nickname:'fixture',unused:'hidden'},raw_ad_data:null,
   video:{duration:1234,width:480,height:854,play_addr:{url_list:['https://fixture.invalid/video'],width:480,height:854}}},
  {aweme_id:'offline-ad',raw_ad_data:{discard:'hidden'},video:{play_addr:{url_list:['https://fixture.invalid/ad']}}},
 ],
};

test.skipIf(!library)('Rust file projector matches the old projection and map on the same synthetic 2 MB reply',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pod-json-test-'));
 const path=join(dir,'feed.json');
 const raw=JSON.stringify(fixture),selection=Buffer.from(JSON.stringify(douyinFeedSelection)),tokens=Buffer.from('[]');
 const {symbols,close}=dlopen(library!,{
   pod_file_project_json:{args:[FFIType.i32,FFIType.ptr,FFIType.u64,FFIType.ptr,FFIType.u64],returns:FFIType.ptr},
   pod_file_project_json_free:{args:[FFIType.ptr],returns:FFIType.void},
 });
 try{
  writeFileSync(path,raw);
  // Rust closes the transferred descriptor.
  const result=symbols.pod_file_project_json(openSync(path,'r'),ptr(selection),BigInt(selection.length),ptr(tokens),BigInt(tokens.length));
  expect(result).not.toBeNull();
  let json:string;
  try{json=new CString(result!).toString();}finally{symbols.pod_file_project_json_free(result);}
  expect(json.length).toBeLessThan(1024);
  const projected=JSON.parse(json);
  expect(projected).toEqual(projectJsonValue(JSON.parse(raw),douyinFeedSelection));
  expect(await mapProjectedDouyinFeed(projected)).toEqual(await parseDouyinFeedAsync(raw));
 }finally{close();rmSync(dir,{recursive:true,force:true});}
});

test.skipIf(!library)('Streams >256 KiB of selected rows with the same projection and feed result',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pod-json-rows-test-'));
 const input=join(dir,'feed.json'),spool=join(dir,'rows.ndjson');
 const base=fixture.aweme_list[0]!;
 const rows=Array.from({length:8},(_,index)=>({...base,aweme_id:`fixture-${index}`,desc:('测试🙂\n').repeat(5800)}));
 const raw=JSON.stringify({...fixture,aweme_list:[...rows,fixture.aweme_list[1]]},null,1);
 const selection=Buffer.from(JSON.stringify(douyinFeedSelection)),tokens=Buffer.from('[]'),field=Buffer.from('aweme_list');
 const {symbols,close}=dlopen(library!,{
  pod_file_project_json_rows:{args:[FFIType.i32,FFIType.i32,FFIType.ptr,FFIType.u64,FFIType.ptr,FFIType.u64,FFIType.ptr,FFIType.u64],returns:FFIType.ptr},
  pod_file_project_json_free:{args:[FFIType.ptr],returns:FFIType.void},
 });
 try{
  writeFileSync(input,raw);
  const result=symbols.pod_file_project_json_rows(openSync(input,'r'),openSync(spool,'w'),ptr(selection),BigInt(selection.length),ptr(tokens),BigInt(tokens.length),ptr(field),BigInt(field.length));
  expect(result).not.toBeNull();
  let json:string;
  try{json=new CString(result!).toString();}finally{symbols.pod_file_project_json_free(result);}
  const header=JSON.parse(json);
  expect(json.length).toBeLessThan(256);
  expect(header.aweme_list).toEqual([]);
  const lines=readFileSync(spool,'utf8');
  expect(Buffer.byteLength(lines)).toBeGreaterThan(256*1024);
  const stream=(map:(row:unknown)=>unknown)=>{
   let offset=0;
   return readProjectedRows(async()=>{
    const text=lines.slice(offset,offset+4093);
    offset+=text.length;
    return {text,eof:offset===lines.length,invalidUtf8:false};
   },map);
  };
  expect({...header,aweme_list:await stream(row=>row)}).toEqual(projectJsonValue(JSON.parse(raw),douyinFeedSelection));
  const mapped=await stream(row=>parseDouyinItem(row,'feed')) as ReturnType<typeof parseDouyinItem>[];
  expect(await mapProjectedDouyinFeed(header,undefined,mapped.filter(item=>item!==null))).toEqual(await parseDouyinFeedAsync(raw));
 }finally{close();rmSync(dir,{recursive:true,force:true});}
});

test('row reader rejects incomplete or invalid input and honours cancellation',async()=>{
 await expect(readProjectedRows(async()=>({text:'{}',eof:true,invalidUtf8:false}),x=>x)).rejects.toThrow('incomplete');
 await expect(readProjectedRows(async()=>({text:'{}\n',eof:true,invalidUtf8:true}),x=>x)).rejects.toThrow('UTF-8');
 let active=true;
 await expect(readProjectedRows(async()=>{active=false;return {text:'{}\n',eof:true,invalidUtf8:false};},
  ()=>{throw Error('stale row mapped');},{isCurrent:()=>active,onCancel:()=>()=>{}})).rejects.toThrow('cancelled');
});

function transportFixture(project:(path:string,size:number)=>Promise<FileJsonProjection>){
 const sizes={download:0,read:0,remove:0},bytes=new TextEncoder().encode('{"aweme_list":[]}');
 const transport=createMediaTransport({
  download:async args=>{sizes.download++;return {path:String(args.path),size:bytes.length,status:200,headers:{}} as DownloadResult;},
  read:async(_path,offset)=>{sizes.read++;return bytes.subarray(offset);},
  remove:async()=>{sizes.remove++;},base64:()=>'',project,
 });
 const client=new DouyinClient({transport,signer:{sign:()=>''},secureStorage:{get:async key=>key==='douyin.cookie'?'sessionid=fixture':null,set:async()=>{},remove:async()=>{}}});
 return {client,sizes};
}

test('feed maps the compact result and releases the response file without reading it into the guest',async()=>{
 const f=transportFixture(async(path,size)=>{
  expect(path).toStartWith('media-json/');
  expect(size).toBe(17);
  return {kind:'object',json:'{"status_code":0,"aweme_list":[],"max_cursor":9,"has_more":1}'};
 });
 expect(await f.client.fetchFeedPage()).toMatchObject({ok:true,data:{items:[],nextCursor:'9',hasMore:true}});
 expect(f.sizes).toEqual({download:1,read:0,remove:1});
});

test('only missing framework support falls back to reading the same file',async()=>{
 const old=transportFixture(async()=>{throw Object.assign(Error('unsupported_method:file.projectJson'),{code:'invalid_argument'});});
 expect(await old.client.fetchFeedPage()).toMatchObject({ok:true});
 expect(old.sizes).toEqual({download:1,read:1,remove:1});
 const invalid=transportFixture(async()=>({kind:'invalid'}));
 expect(await invalid.client.fetchFeedPage()).toMatchObject({ok:false,code:'PARSE_FAILED'});
 expect(invalid.sizes).toEqual({download:1,read:0,remove:1});
});
