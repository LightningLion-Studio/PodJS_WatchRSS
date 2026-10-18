import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {oracle} from './upstream-u8-loader.ts';
import {watchUiLines} from '../src/ui/text-layout.ts';
import {breakUnits,layoutUiText} from '../src/reader/line-break.ts';
import {measuredLines,normalizeWatchTitle,watchTitleMeasurements,watchTitleLines} from '../src/reader/measured-text.ts';
import {lazyRegExpTest} from '../src/core/lazy-regexp.ts';
import {updateSystemCarets} from '../src/reader/system-carets.ts';
import {querySyncPages} from '../src/sync/sql-pages.ts';
import {readSyncSqlText} from '../src/sync/sql-text.ts';
import {StreamFrameConnection} from '../src/sync/stream.ts';
import {encodeFrame} from '../src/sync/protocol.ts';
import {MAX_BODY_JSON_BYTES} from '../src/sync/article-body.ts';
const oldUI=await oracle('ui/text-layout.ts'),oldLine=await oracle('reader/line-break.ts'),oldText=await oracle('reader/measured-text.ts'),oldRegex=await oracle('core/lazy-regexp.ts'),oldCarets=await oracle('reader/system-carets.ts'),oldPages=await oracle('sync/sql-pages.ts'),oldSQL=await oracle('sync/sql-text.ts'),oldStream=await oracle('sync/stream.ts');
const measure=(s:string)=>Array.from(s).reduce((n,c)=>n+(/[a-zA-Z0-9 /]/.test(c)?3:c==='\u0301'?0:9),0);
const corpus=['','  whitespace  ','\r\na\r\nb\n\n尾','中文标题 （括号）：「测试」？！','https://example.test/a/b?q=中&c=1','cafe\u0301 👩‍👩‍👧‍👦 🇺🇸','ＡＢＣ\tあいうぁぃっァー','正文 阅读设置预览(后缀)'];
let seed=0x12345678;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
const chars=Array.from('中汉字あぁ가ABC009  \t/（）】「」.,?!’\u0301\u200d😀');
for(let i=0;i<100;i++)corpus.push(Array.from({length:rand()%64},()=>chars[rand()%chars.length]).join(''));
test('U8 both line profiles and measured ellipsis match frozen oracle',()=>{
 for(const text of corpus){expect(breakUnits(text)).toEqual(oldLine.breakUnits(text));expect(normalizeWatchTitle(text)).toBe(oldText.normalizeWatchTitle(text));
 for(const width of [0,1,9,27,54,150,233])for(const maxLines of [undefined,1,2,5]){
  const options={width,measure,maxLines};expect(watchUiLines(text,options)).toEqual(oldUI.watchUiLines(text,options));expect(layoutUiText(text,options)).toEqual(oldLine.layoutUiText(text,options));
  for(const indent of [0,8])expect(measuredLines(text,width,measure,maxLines,indent)).toEqual(oldText.measuredLines(text,width,measure,maxLines,indent));
 }}
});
test('U8 title generator measurement requests and suffix balancing match oracle',()=>{
 function run(fn:any,title:string,width:number,first?:number,other?:number){const plan=fn(title,width,first,other,'(后缀)',3),requests:string[]=[];let step=plan.next();while(!step.done){requests.push(step.value);step=plan.next(measure(step.value));}return {requests,lines:step.value};}
 for(const title of corpus)for(const width of [1,54,150,233])for(const limits of [[undefined,undefined],[40,65]]){
  expect(run(watchTitleMeasurements,title,width,...limits)).toEqual(run(oldText.watchTitleMeasurements,title,width,...limits));expect(watchTitleLines(title,width,measure,...limits as [number,number])).toEqual(oldText.watchTitleLines(title,width,measure,...limits));
 }
});
test('U8 lazy regexp preserves flags, state and deferred syntax errors',()=>{
 for(const [source,flags] of [['\\p{Script=Han}','u'],['a','g'],['a','y'],['[','u']]){
  const a=lazyRegExpTest(source,flags),b=oldRegex.lazyRegExpTest(source,flags);const outcome=(fn:any,v:string)=>{try{return fn(v);}catch(e){return (e as Error).name;}};
  for(const value of ['a','a','中','a','b',''])expect(outcome(a,value)).toEqual(outcome(b,value));
 }
});
test('U8 caret maps preserve values, row identity and unchanged result references',()=>{
 let a:ReadonlyMap<object,readonly number[]>=new Map(),b:ReadonlyMap<object,readonly number[]>=new Map();const keys=[{},{}];
 for(let i=0;i<400;i++){const key=keys[i%2],value=[undefined,[],[0,8],[0,8],[0,NaN]][i%5];const beforeA=a,beforeB=b;a=updateSystemCarets(a,key,value);b=oldCarets.updateSystemCarets(b,key,value);expect(a).toEqual(b);expect(a===beforeA).toBe(b===beforeB);}
});
const outcome=async(fn:()=>Promise<unknown>)=>{try{return {value:await fn()};}catch(e){return {error:String(e)};}};
test('U8 SQL paging query/parameter order, retries and unrelated errors match oracle',async()=>{
 async function run(fn:any,mode:string){const trace:any[]=[],values=Array.from({length:19},(_,id)=>({id}));let failures=0;const db={query:async(sql:string,params:any[])=>{trace.push([sql,params]);const size=params.at(-2),offset=params.at(-1);if(mode==='oversize'&&size>2)throw Error('Query result too large');if(mode==='failure'&&failures++===1)throw Error('I/O failed');return values.slice(offset,offset+size);}};return {result:await outcome(()=>fn(db,'SELECT value FROM data ORDER BY id',['arg'],8)),trace};}
 for(const mode of ['normal','oversize','failure'])expect(await run(querySyncPages,mode)).toEqual(await run(oldPages.querySyncPages,mode));
});
test('U8 SQL text exact bytes/query traces match oracle at all UTF-8 page edges',async()=>{
 async function run(fn:any,value:string|null,mode='normal'){
  const raw=new Database(':memory:');raw.exec('CREATE TABLE data(id INTEGER,value TEXT)');raw.query('INSERT INTO data VALUES(?,?)').run(7,value);const trace:any[]=[];let pages=0;
  const db={query:async(sql:string,params:any[]=[])=>{trace.push([sql,params]);const rows=raw.query(sql).all(...params) as any[];
   if(mode==='boundary'&&sql.startsWith('SELECT hex'))rows[0].boundary='80';
   if(mode==='short'&&sql.startsWith('SELECT CAST'))rows[0].bytes=0;
   if(mode==='missing'&&sql.startsWith('SELECT typeof'))return [];
   if(mode==='oversize'&&sql.startsWith('SELECT typeof'))rows[0].bytes=MAX_BODY_JSON_BYTES+1;
   if(mode==='kind'&&sql.startsWith('SELECT typeof'))rows[0].kind='blob';
   if(mode==='edit'&&sql.startsWith('SELECT CAST')&&++pages===1)raw.query('UPDATE data SET value=?').run('x');return rows;
  }};
  try{return {result:await outcome(()=>fn(db,'SELECT value FROM data WHERE id=?',[7])),trace};}finally{raw.close();}
 }
 for(const ch of ['a','中','😀','\0'])for(const n of [32765,32766,32767,32768,32769]){const value='a'.repeat(n)+ch.repeat(5);expect(await run(readSyncSqlText,value)).toEqual(await run(oldSQL.readSyncSqlText,value));}
 for(const mode of ['normal','boundary','short','missing','oversize','kind','edit'])for(const value of [null,'','中😀\0尾'.repeat(9000)])expect(await run(readSyncSqlText,value,mode)).toEqual(await run(oldSQL.readSyncSqlText,value,mode));
});
test('U8 frame stream reads, writes, progress, failure/close and deadlines match oracle',async()=>{
 async function run(C:any,mode:string){let clock=0,offset=0,closed=0;const trace:any[]=[],frame=encodeFrame({text:'中😀'.repeat(6000)});
  const conn=new C({read:async(max:number,timeout:number)=>{trace.push(['read',max,timeout]);clock++;if(mode==='eof')return null;if(mode==='empty')return new Uint8Array();if(mode==='oversized')return new Uint8Array(max+1);if(mode==='slow')clock+=500;const bytes=frame.slice(offset,offset+Math.min(max,57));offset+=bytes.length;return bytes;},write:async(bytes:Uint8Array)=>{trace.push(['write',Array.from(bytes)]);if(mode==='write-failure')throw Error('write failed');},close:async()=>{closed++;trace.push(['close']);}},()=>clock,16*1024);
  conn.setTransferProgress((p:any)=>trace.push(['progress',p]));const read=await outcome(()=>conn.readFrame(10000));const write=await outcome(()=>conn.writeFrame({ack:true}));await conn.close();await conn.close();return {read,write,closed,trace};
 }
 for(const mode of ['normal','eof','empty','oversized','slow','write-failure'])expect(await run(StreamFrameConnection,mode)).toEqual(await run(oldStream.StreamFrameConnection,mode));
});
test('U8 frame production default clock cancels large encoding before write',async()=>{
 async function run(C:any){const trace:any[]=[];const conn=new C({read:async()=>null,write:async(bytes:any)=>{trace.push([...bytes]);},close:async()=>{trace.push('close');}});const pending=outcome(()=>conn.writeFrame({text:'中😀'.repeat(20000)}));await conn.close();return {result:await pending,trace};}
 expect(await run(StreamFrameConnection)).toEqual(await run(oldStream.StreamFrameConnection));
});
