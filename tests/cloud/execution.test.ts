import {expect,test} from 'bun:test';
import {CloudForegroundExecution,CLOUD_SYNC_SUSPENDED,cloudRunHost} from '../../src/cloud/execution';
import {fixture} from './service-fixture';
import {WatchAccountStore} from '../../src/account/store';
import {createCloudRuntime} from '../../src/cloud/runtime';

test('a pause fences an existing foreground run permanently, while a new resumed run works',()=>{
 const gate=new CloudForegroundExecution(true),current=gate.begin();current();
 gate.foreground(false);expect(current).toThrow(CLOUD_SYNC_SUSPENDED);expect(()=>gate.begin()).toThrow(CLOUD_SYNC_SUSPENDED);
 gate.foreground(true);expect(current).toThrow(CLOUD_SYNC_SUSPENDED);gate.begin()();
});
test('suspending during account IO releases the writer lease without opening a library, refreshing or deleting credentials',async()=>{
 const gate=new CloudForegroundExecution(true),calls:string[]=[];
 const accounts=new WatchAccountStore({get:async()=>{gate.foreground(false);return null;},set:async()=>{throw Error('no writes');},remove:async()=>{throw Error('no deletion');}});
 const runtime=createCloudRuntime(async<T>(method:string)=>{calls.push(method);if(method==='cloud.acquire')return{acquired:true} as T;if(method==='cloud.release')return{} as T;if(method==='file.list')return{entries:[]} as T;if(method==='discovery.networkSnapshot')return{active:true,validated:true,wifi:true,metered:false} as T;throw Error('unexpected '+method);},async()=>{throw Error('repository must stay closed');},{require(){}},accounts,undefined,gate);
 expect(await runtime.service.syncNow()).toBe(false);expect(runtime.service.status.phase).toBe('waiting');expect(runtime.service.status.retryAtMillis).toBeGreaterThan(0);expect(calls.at(-1)).toBe('cloud.release');expect(calls).toHaveLength(4);
});
test('suspended records stop immediately and skip the secondary usage refresh; a resumed sync succeeds',async()=>{
 const f=await fixture(),gate=new CloudForegroundExecution(true),check=gate.begin(),original=f.session.assertCurrent;
 f.session.assertCurrent=async()=>{check();await original();check();};
 f.session.records=async()=>({pull:async()=>{gate.foreground(false);await f.session.assertCurrent();return 0;},reapply:async()=>0,flush:async()=>0}) as any;
 expect(await f.service.syncNow()).toBe(false);const count=f.calls.length;await Promise.resolve();expect(f.calls.length).toBe(count);expect(f.service.status.phase).toBe('waiting');
 const bootstrap=f.calls.filter(c=>c.url.endsWith('/bootstrap'));expect(bootstrap).toHaveLength(1);
 gate.foreground(true);const next=gate.begin();f.session.assertCurrent=async()=>{next();await original();};f.session.records=async()=>({pull:async()=>0,reapply:async()=>0,flush:async()=>0}) as any;
 expect(await f.service.syncNow()).toBe(true);
});

test('a pause during a cache chunk stops before the next chunk and still permits cleanup',async()=>{
 const gate=new CloudForegroundExecution(true),calls:string[]=[],assertRun=gate.begin();
 const host=cloudRunHost(async<T>(method:string)=>{calls.push(method);if(method==='file.read')gate.foreground(false);return {} as T;},assertRun);
 await host('file.read',{});await expect(host('file.read',{})).rejects.toThrow(CLOUD_SYNC_SUSPENDED);
 await host('file.delete',{});await host('secure.release',{});await host('cloud.release',{});
 expect(calls).toEqual(['file.read','file.delete','secure.release','cloud.release']);
 gate.foreground(true);await expect(host('file.read',{})).rejects.toThrow(CLOUD_SYNC_SUSPENDED);
});
test('the final cache chunk checks foreground before allocating or decoding its large result',async()=>{
 const {createCloudHostPorts}=await import('../../src/cloud/host-ports');const gate=new CloudForegroundExecution(true),check=gate.begin(),calls:string[]=[];
 const guard={require(){check();}};
 const p=createCloudHostPorts(async<T>(method:string)=>{calls.push(method);if(method==='file.stat')return {exists:true,file:true,size:32768} as T;if(method==='file.read'){gate.foreground(false);return {dataBase64:'not decoded',offset:0,size:32768} as T;}throw Error('unexpected');},guard);
 await expect(p.files.read('cache')).rejects.toThrow(CLOUD_SYNC_SUSPENDED);expect(calls).toEqual(['file.stat','file.read']);
});
test('a pause on the final HTTP response chunk skips decoding and cleans the reserved output',async()=>{
 const {createCloudTransport}=await import('../../src/cloud/transport');const gate=new CloudForegroundExecution(true),check=gate.begin(),calls:string[]=[];
 const host=cloudRunHost(async<T>(method:string)=>{calls.push(method);if(method==='file.createTemp')return {path:'cloud-http/reserved'} as T;if(method==='file.delete')return {} as T;if(method==='http.download')return {path:'cloud-http/reserved',status:200,headers:{},size:32768} as T;if(method==='file.read'){gate.foreground(false);return {offset:0,size:32768,dataBase64:'never decoded'} as T;}throw Error(method);},check);
 const transport=createCloudTransport(host,{require:check});await expect(transport.request({method:'GET',url:'https://fixture.invalid',headers:{}})).rejects.toThrow(CLOUD_SYNC_SUSPENDED);
 expect(calls).toEqual(['file.createTemp','file.delete','http.download','file.read','file.delete']);
});
test('pause after server token rotation still commits the new pair, then cancels library IO without clearing login',async()=>{
 const gate=new CloudForegroundExecution(true),values=new Map<string,string>(),calls:string[]=[],files=new Map<string,Uint8Array>();let next=0;
 values.set('state_json',JSON.stringify({userId:'user',installId:'watch',watchDeviceToken:'old-access',watchRefreshToken:'old-refresh',backendBaseUrl:'https://fixture.invalid',tokenExpiresAtMillis:1,refreshTokenExpiresAtMillis:Date.now()+3600000}));
 const accounts=new WatchAccountStore({get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},remove:async()=>{throw Error('must not clear login');}});
 const host=async<T>(method:string,args:any):Promise<T>=>{
  calls.push(method);
  if(method==='discovery.networkSnapshot')return {active:true,validated:true,wifi:true,metered:false} as T;
  if(method==='cloud.acquire')return {acquired:true} as T;if(method==='cloud.release')return {} as T;
  if(method==='file.list')return {entries:[]} as T;
  if(method==='file.createTemp'){const path='cloud-http/temp'+(++next);files.set(path,new Uint8Array());return {path} as T;}
  if(method==='file.write'){const old=files.get(args.path)!,part=Buffer.from(args.dataBase64,'base64'),out=new Uint8Array(old.length+part.length);out.set(old);out.set(part,old.length);files.set(args.path,out);return {size:out.length} as T;}
  if(method==='file.delete'){files.delete(args.path);return {} as T;}
  if(method==='http.download'){
   expect(args.url).toEndWith('/watch-token/refresh');gate.foreground(false);
   const body=new TextEncoder().encode(JSON.stringify({watchAccessToken:'new-access',watchRefreshToken:'new-refresh',accessTokenExpiresAt:Date.now()+3600000,refreshTokenExpiresAt:Date.now()+7200000}));files.set(args.path,body);return {path:args.path,status:200,headers:{},size:body.length} as T;
  }
  if(method==='file.read'){const body=files.get(args.path)!;return {offset:args.offset,size:body.length,dataBase64:Buffer.from(body.slice(args.offset,args.offset+args.maxBytes)).toString('base64')} as T;}
  throw Error('unexpected '+method);
 };
 const runtime=createCloudRuntime(host,async()=>{throw Error('repository must stay closed');},{require(){}},accounts,undefined,gate);
 expect(await runtime.service.syncNow()).toBe(false);expect(runtime.service.status.phase).toBe('waiting');expect((await accounts.read())?.watchRefreshToken).toBe('new-refresh');expect((await accounts.read())?.watchDeviceToken).toBe('new-access');expect(files.size).toBe(0);expect(calls.at(-1)).toBe('cloud.release');
});

test('pausing a streamed journal chunk closes its host reader without decoding or repairing data',async()=>{
 const {createCloudHostPorts}=await import('../../src/cloud/host-ports');const gate=new CloudForegroundExecution(true),check=gate.begin(),calls:string[]=[];
 const host=cloudRunHost(async<T>(method:string,args:Record<string,unknown>)=>{calls.push(method);if(method==='file.stat')return {exists:true,file:true,size:100000} as T;if(method==='file.openText')return {id:'reader'} as T;if(method==='file.readTextChunk'){expect(args.maxChars).toBe(32768);gate.foreground(false);return {text:'never consumed',eof:false} as T;}if(method==='file.closeText')return {} as T;throw Error(method);},check);
 const ports=createCloudHostPorts(host,{require:check});let consumed=0;
 await expect((async()=>{for await(const text of ports.files.textChunks!('cache.delta'))consumed+=text.length;})()).rejects.toThrow(CLOUD_SYNC_SUSPENDED);
 expect(consumed).toBe(0);expect(calls).toEqual(['file.stat','file.openText','file.readTextChunk','file.closeText']);
});
