import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {routeRemoteExportHttp,serveRemoteHttp} from '../src/remote-input/http.ts';
import {EXPORT_ABILITIES,type HttpExportMode,type HttpExportSource} from '../src/remote-input/exports.ts';
import {readSavedLinks} from '../src/sync/saved-links.ts';
import {BiliClient} from '../src/bili/client.ts';
import {BiliError,type BiliHistoryCursor} from '../src/bili/types.ts';
import {readBiliPlaybackProgress} from '../src/bili/playback.ts';
import {stringToUtf8,utf8ToString} from '@podjs/framework/bytes';
import type {SyncByteStream} from '../src/sync/stream.ts';
import {RemoteInputServer} from '../src/remote-input/server.ts';
const empty:HttpExportSource={readSavedLinks:async()=>[],history:async()=>({items:[]}),playbackProgress:async()=>[]};
const route=(target:string,mode:HttpExportMode,source=empty,onComplete?:()=>void)=>routeRemoteExportHttp({target,headers:{},body:''},{mode,source,onComplete});
const body=(response:{body:string})=>JSON.parse(response.body);

test('native mode abilities and exact paths isolate every export, with no pairing token or method gate',async()=>{
 const paths={favorite:['/getFavorites'],watchLater:['/getWatchlaterList'],bili:['/getBiliWatchHistory','/getBiliPlaybackProgress']};
 for(const mode of Object.keys(paths) as HttpExportMode[]){
  expect(body(await route('/getAbilities',mode))).toEqual({status:'ok',abilities:[EXPORT_ABILITIES[mode]]});
  expect(body(await route('/getCurrentActivationAbility',mode))).toEqual(EXPORT_ABILITIES[mode]);
  expect(body(await route('/health',mode))).toEqual({status:'ok'});
  for(const target of [...Object.values(paths).flat(),'/getWatchLaterList','/remoteEnterRSSURL','/getTtsConfig'])expect((await route(target,mode)).status).toBe(paths[mode].includes(target)?200:404);
  expect((await route('/setLLMSummaryConfig',mode)).status).toBe(410);
  expect((await route('/',mode)).type).toContain('text/html');
 }
 expect(body(await routeRemoteExportHttp({method:'POST',target:'/getFavorites?token=wrong',headers:{authorization:'invalid'},body:''},{mode:'favorite',source:empty}))).toEqual({success:true,data:[]});
});

test('HTTP saved export reads unified SQL rows in saved order, including RSS, Bili and Douyin; no content leaks',async()=>{
 const db=new Database(':memory:');
 try{
 db.exec(`CREATE TABLE articles(id INTEGER PRIMARY KEY,link TEXT,content TEXT);
 CREATE TABLE article_saved_states(article_id INTEGER,save_type TEXT,saved INTEGER,sort_order INTEGER,changed_at INTEGER);
 CREATE TABLE article_saved_entry_times(article_id INTEGER,save_type TEXT,created_at INTEGER);
 INSERT INTO articles VALUES(1,' https://rss.test/中文 ','private'),(2,'https://www.bilibili.com/video/BV1?cid=2','private'),(3,'https://www.douyin.com/video/3','private'),(4,'  ','private'),(5,'https://cancelled','private');
 INSERT INTO article_saved_states VALUES(1,'favorite',1,1,20),(2,'favorite',1,0,10),(3,'favorite',1,1,10),(4,'favorite',1,0,100),(5,'favorite',0,0,100),(3,'watchLater',1,0,10),(2,'watchLater',0,0,100);
 INSERT INTO article_saved_entry_times VALUES(3,'favorite',30);`);
 const source={...empty,readSavedLinks:(type:'favorite'|'watchLater')=>readSavedLinks({query:async(sql,p=[])=>db.query(sql).all(...p as (string|number|null)[]) as Record<string,unknown>[]},type)};
 expect(body(await route('/getFavorites','favorite',source))).toEqual({success:true,data:[{link:'https://www.bilibili.com/video/BV1?cid=2'},{link:'https://www.douyin.com/video/3'},{link:'https://rss.test/中文'}]});
 expect(body(await route('/getWatchlaterList','watchLater',source))).toEqual({success:true,data:[{link:'https://www.douyin.com/video/3'}]});
 }finally{db.close();}
});

test('native history cursor precedence, numeric parsing, blank omission and wire field names',async()=>{
 const cursors:(BiliHistoryCursor|undefined)[]=[];
 const source={...empty,history:async(cursor?:BiliHistoryCursor)=>{cursors.push(cursor);return {cursor:{max:0,viewAt:2,business:' ',pageSize:20},items:[{title:' 标题 ',cover:'',viewAt:0,duration:20,progress:-1,authorName:'作者',authorMid:0,history:{oid:1,bvid:'BV1',cid:0,page:1,part:'\u001c',business:'archive'}},{history:{oid:2}},{title:'\ufeff'},{}]};}};
 const result=body(await route('/getBiliWatchHistory?max=1&max=9&view_at=2&viewAt=3&business=+archive+&ps=99','bili',source));
 expect(cursors[0]).toEqual({max:1,viewAt:2,business:'archive'});
 expect(result).toEqual({success:true,data:{cursor:{max:0,viewAt:2,ps:20},items:[{aid:1,bvid:'BV1',cid:0,page:1,business:'archive',title:' 标题 ',viewAt:0,durationSeconds:20,progressSeconds:-1,authorName:'作者',authorMid:0,link:'https://www.bilibili.com/video/BV1?cid=0'},{aid:2,link:'https://www.bilibili.com/video/av2'},{title:'\ufeff'},{}]}});
 await route('/getBiliWatchHistory?max=9223372036854775808&view_at=x&viewAt=%2B42&business=%20','bili',source);
 expect(cursors[1]).toEqual({max:undefined,viewAt:42,business:undefined});
 for(const q of ['','?max=1.5&view_at=+2','?max=1e2&business=%20']){await route('/getBiliWatchHistory'+q,'bili',source);expect(cursors.at(-1)).toBeUndefined();}
 expect(body(await route('/getBiliWatchHistory','bili'))).toEqual({success:true,data:{cursor:null,items:[]}});
});

test('local playback exports newest-first resume records using native milliseconds and links',async()=>{
 const source={...empty,playbackProgress:()=>readBiliPlaybackProgress({get:async key=>{expect(key).toBe('watchrss.bili.playback-progress.v1');return JSON.stringify([{aid:1,cid:2,positionMs:3000,durationMs:10000,updatedAt:10},{bvid:' BV2 ',cid:3,positionMs:5000,durationMs:9000,updatedAt:20}]);}})};
 expect(body(await route('/getBiliPlaybackProgress','bili',source))).toEqual({success:true,data:[{bvid:'BV2',cid:3,positionMs:5000,durationMs:9000,updatedAtMillis:20,link:'https://www.bilibili.com/video/BV2?cid=3'},{aid:1,cid:2,positionMs:3000,durationMs:10000,updatedAtMillis:10,link:'https://www.bilibili.com/video/av1?cid=2'}]});
});

test('Bili client to HTTP export preserves native upstream business errors, invalid JSON and network failures',async()=>{
 for(const [wire,code,message,status] of [
  ['{"code":-101}',-101,'登录已失效',200],['{"code":-412,"message":"blocked"}',-412,'blocked',412],
  ['{"code":0,"data":null}',-1,'empty_data',200],['bad json',-1,'响应解析失败',503],['{}',-1,'加载失败(-1)',200],
 ] as const){
  const client=new BiliClient({transport:{request:async()=>({status,headers:{},body:stringToUtf8(wire)})}});
  let completed=0;const response=await route('/getBiliWatchHistory','bili',{...empty,history:cursor=>client.history({cursor})},()=>completed++);
  expect(response.status).toBe(200);expect(body(response)).toEqual({success:false,code,message,data:null});expect(completed).toBe(0);
 }
 for(const error of [new BiliError('transport','failed'),new BiliError('timeout','timeout')])expect(body(await route('/getBiliWatchHistory','bili',{...empty,history:async()=>{throw error;}}))).toEqual({success:false,code:9001,message:'网络不可用',data:null});
});

test('local errors use 500 and data:null only for Bili, and callback failures match native handlers',async()=>{
 const fail=async()=>{throw Error('读取失败');};
 for(const [path,mode,bili] of [['/getFavorites','favorite',false],['/getWatchlaterList','watchLater',false],['/getBiliPlaybackProgress','bili',true]] as const){
  const response=await route(path,mode,{readSavedLinks:fail,history:fail,playbackProgress:fail});
  expect(response.status).toBe(500);expect(body(response)).toEqual({success:false,message:'读取失败',...(bili?{data:null}:{})});
 }
 const result=await route('/getBiliWatchHistory','bili',empty,()=>{throw Error('callback');});expect(result.status).toBe(500);expect(body(result)).toEqual({success:false,message:'callback',data:null});
});

function wire(target:string){let bytes:Uint8Array|null=stringToUtf8(`GET ${target} HTTP/1.1\r\n\r\n`),closed=false;const chunks:Uint8Array[]=[];const stream:SyncByteStream={read:async()=>{const b=bytes;bytes=null;return b;},write:async b=>{chunks.push(b);},close:async()=>{closed=true;}};return {stream,text:()=>chunks.map(utf8ToString).join(''),closed:()=>closed};}
test('wire export uses UTF-8 byte lengths, closes connection and never delivers RSS input',async()=>{
 const w=wire('/getFavorites');let complete=0;
 await serveRemoteHttp(w.stream,()=>true,()=>{throw Error('RSS delivered');},{mode:'favorite',source:{...empty,readSavedLinks:async()=>['https://中文.test']},onComplete:()=>complete++});
 const [header,payload]=w.text().split('\r\n\r\n');expect(header).toContain('HTTP/1.1 200 OK');expect(header).toContain('Content-Length: '+stringToUtf8(payload).length);expect(complete).toBe(1);expect(w.closed()).toBe(true);
});

test('export listener survives repeated pulls and dispose suppresses completion of an in-flight read',async()=>{
 let resolveRead!:(value:string[])=>void;const requests=[wire('/getFavorites'),wire('/getFavorites')];let accepted=0,completed=0;
 const operation=<T>(value:T)=>({result:Promise.resolve(value),cancel:()=>{}});
 const server=new RemoteInputServer(()=>{throw Error('unexpected URL');},()=>{}, {
  tcp:{listen:()=>operation({id:'listener',port:123}),addresses:async()=>({addresses:['127.0.0.1']}),accept:()=>operation({id:String(accepted++),remoteAddress:'127.0.0.1'}),close:async()=>({closed:true})},
  streams:{read:(id:string)=>({result:requests[Number(id)].stream.read(4096,100).then(b=>({eof:!b,dataBase64:b?Buffer.from(b).toString('base64'):''})),cancel:()=>{}}),write:(id:string,b:Uint8Array)=>({result:requests[Number(id)].stream.write(b),cancel:()=>{}}),close:async()=>({closed:true})} as never,
 },'127.0.0.1',undefined,{mode:'favorite',source:{...empty,readSavedLinks:async()=>accepted===1?[]:new Promise(r=>resolveRead=r)},onComplete:()=>completed++});
 await server.ready;
 for(let i=0;i<100&&!resolveRead;i++)await Promise.resolve();
 expect(accepted).toBe(2);expect(completed).toBe(1);
 const stopping=server.dispose();resolveRead(['https://late']);await stopping;
 expect(completed).toBe(1);expect(requests[1].text()).toBe('');
});
