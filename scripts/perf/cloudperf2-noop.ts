import {defineBackgroundHandler} from '@podjs/framework/background-handler';
import {fixture,diagnostics} from './cloudperf2-service-fixture';
import {createBackgroundLibrary} from '../../src/cloud/background-library';
import {createCloudHostPorts} from '../../src/cloud/host-ports';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {WatchCloudRecords} from '../../src/cloud/records';
import {legacyWebArticleId} from '../../src/cloud/rss-identity';
async function run(ctx:any){
 const guard={require(){}},host=async<T>(method:string,args:Record<string,unknown>):Promise<T>=>ctx.request('debug.cloudHost',{method,args}).catch(async(error:any)=>{await ctx.request('perf',{event:'diagnostic',method,error:String(error)});throw error;});
 const ports=createCloudHostPorts(host,guard),repo=await createBackgroundLibrary(host,async()=>undefined,guard),f=await fixture(ports.crypto),s=f.session;
 const foundation=ports.foundation('user','watch',f.transport,{baseUrl:'https://backend.invalid',accessToken:'fixture-token'});
 s.state=foundation.state;s.cache=foundation.cache;s.codec=foundation.codec;s.restoreCheckpoint={state:s.state,cache:s.cache,codec:s.codec};
 const library=new WatchCloudLibraryAdapter(repo,'watch',{...ports.crypto,stableId:(url:string)=>legacyWebArticleId(url,ports.crypto.sha256)},guard);s.library=library;for(const name of ['publicSources','exportPayloads','exportRecords','applyReadingStates']){const action=(library as any)[name].bind(library);(library as any)[name]=async(...a:any[])=>{try{return await action(...a);}catch(error){await ctx.request('perf',{event:'diagnostic',method:name,error:String(error),stack:(error as Error).stack});throw error;}};}
 s.records=async(bootstrap,current)=>new WatchCloudRecords({userId:s.userId,epoch:bootstrap.libraryEpoch,anchorVersion:1,version:1,key:async()=>new Uint8Array(32).fill(41),crypto:{...ports.crypto,hmac:ports.v2Crypto.hmac},current,assertUpload:async()=>{},
  readStateObject:()=>s.cache.recordsValue(s.userId),writeStateObject:value=>s.cache.storeRecordsValue(s.userId,value),lazyProjections:true,
  readState:()=>s.cache.records(s.userId),writeState:value=>s.cache.storeRecords(s.userId,value),checkpoint:value=>s.cache.storeRecords(s.userId,value),readPreparation:()=>s.cache.recordPreparation(s.userId),writePreparation:value=>s.cache.storeRecordPreparation(s.userId,value),
  get:after=>s.client.records(after,s.deviceId),push:items=>s.client.pushRecords(items),project:(doc,basis)=>library.projectRecord(doc,basis),bookReplacement:doc=>library.bookReplacement(doc),hydrate:docs=>library.hydrateRecords(docs),apply:(docs,work)=>library.applyRecords(docs,false,work),reapply:()=>library.applyReadingStates(),export:work=>library.exportRecords(work),inventoryLookups:inventory=>library.inventoryRecordLookups(inventory)});
 await ctx.request('perf',{event:'start',stage:'noop-prime',bytes:0,items:0});
 if(!await f.service.syncNow(true,'all'))throw Error('prime '+JSON.stringify(f.service.status)+' diagnostics '+JSON.stringify(diagnostics));
 await ctx.request('perf',{event:'end',stage:'noop-prime',bytes:0,items:0});
 for(let n=0;n<3;n++){
  const at=f.calls.length,rows:any[]=await host('sql.query',{sql:'SELECT count(*) n FROM articles',params:[]});
  await ctx.request('perf',{event:'start',stage:'unchanged-sync',bytes:0,items:Number(rows[0].n),run:n});
  if(!await f.service.syncNow(true,'all'))throw Error('noop '+JSON.stringify(f.service.status));
  const calls=f.calls.slice(at),uploads=calls.filter(c=>c.method==='PUT'||c.method==='PATCH');if(uploads.length)throw Error('unchanged upload');
  await ctx.request('perf',{event:'end',stage:'unchanged-sync',bytes:0,items:Number(rows[0].n),run:n,httpCalls:calls.length,uploads:uploads.length});
 }
 return 'success';
}
(globalThis as any).backgroundHandler=defineBackgroundHandler(async(ctx:any)=>{try{return await run(ctx);}catch(error){await ctx.request('perf',{event:'end',stage:'failure',error:String(error),stack:(error as Error).stack});throw error;}},{yieldTurn:async ctx=>{await ctx.request!('debug.cloudHost',{method:'runtime.delay',args:{milliseconds:1}});}});
