import {test,expect} from 'bun:test';
import {WatchAccountStore} from '../../src/account/store.ts';
import {SyncAccountTelemetry} from '../../src/sync/account-telemetry.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
import {debugLogReply} from '../../src/sync/diagnostic-log.ts';
import {LibrarySyncSession,type LibrarySessionRepository} from '../../src/sync/session.ts';
import {StreamFrameConnection} from '../../src/sync/stream.ts';
import {encodeFrame,FrameDecoder,type JsonObject} from '../../src/sync/protocol.ts';
import {parseWireJson} from '../../src/sync/wire-json.ts';
import phoneFixture from '../fixtures/account-debug-phone.json';
import debugFixture from '../fixtures/debug-log-native.json';

const parseJava=async(value:string)=>{const url=new URL(value);return {valid:true,scheme:url.protocol.slice(0,-1),host:url.hostname};};
function phone(frames:JsonObject[],beforeWrite:(frame:JsonObject)=>Promise<void>=async()=>{}){
 const input=frames.map(encodeFrame),decoder=new FrameDecoder(),out:JsonObject[]=[],timeouts:number[]=[];
 let index=0,offset=0,closed=0;
 const connection=new StreamFrameConnection({async read(max,timeout){timeouts.push(timeout);const frame=input[index];if(!frame)return null;const bytes=frame.slice(offset,offset+Math.min(max,11));offset+=bytes.length;if(offset===frame.length){index++;offset=0;}return bytes;},
 async write(bytes){for(const frame of decoder.push(bytes)){await beforeWrite(frame);out.push(frame);}},async close(){closed++;}});
 return {connection,out,timeouts,consumed:()=>index,closed:()=>closed};
}
function repository(){
 let marks=0;const unexpected=async():Promise<never>=>{throw Error('account/debug action touched library data');};
 const repo:LibrarySessionRepository={deviceId:async()=>'watch-fixture',markSuccess:async()=>{marks++;},cursor:unexpected,mergeSources:unexpected,prepareWindow:unexpected,exportSources:unexpected,receiveArticle:unexpected,exportRequested:unexpected,finalizeSnapshot:unexpected,resetPeerState:unexpected};
 return {repo,marks:()=>marks};
}
for(const fixture of phoneFixture.cases)test(`v${fixture.phoneProtocolVersion} phone account/debug frames persist before reply and consume received then applied`,async()=>{
 const secure=new Map<string,string>(),plain=new Map<string,string>();let notifications=0;
 const storage={get:(key:string)=>secure.get(key)??null,set:async(key:string,value:string)=>{await Promise.resolve();secure.set(key,value);},remove:(key:string)=>{secure.delete(key);}};
 const store=new WatchAccountStore(storage);store.subscribe(()=>notifications++);
 const telemetry=new SyncAccountTelemetry({get:key=>plain.get(key),set:(key,value)=>{plain.set(key,value);}},()=>Date.UTC(2026,9,4));
 const handler=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'watch-fixture',notesChanged:()=>{},accountStore:store,accountUriParse:parseJava,accountTelemetry:telemetry,readDebugLog:maxChars=>debugLogReply('prefix中😀',{maxChars})});
 const p=phone(fixture.frames as JsonObject[],async response=>{
  if(response.action==='syncAccount'){
   expect((await store.read())?.watchDeviceToken).toBe('fixture-access');
   expect(telemetry.backlogCount()).toBe(1);expect(notifications).toBe(1);
  }
 });
 const r=repository(),result=await new LibrarySyncSession(p.connection,r.repo,{handleAction:handler}).run();
 expect(result).toHaveLength(4);for(const action of result)expect(action.ack).toMatchObject({success:true,phase:'applied',applied:true});
 expect(p.out[1]).toEqual({success:true,version:1,action:'syncAccount',deviceId:'watch-fixture',boundUserId:'user-1',telemetryBacklog:1});
 expect(p.out[2]).toEqual({success:true,action:'pullDebugLog',log:'中😀',truncated:true,totalChars:9});
 expect(JSON.stringify(p.out)).not.toMatch(/fixture-access|fixture-refresh|fixture-old/);
 expect(JSON.stringify([...plain.values()])).not.toMatch(/fixture-access|fixture-refresh|user-1/);
 expect(await new WatchAccountStore(storage).read()).toMatchObject({userId:'user-1',watchDeviceToken:'fixture-access',watchRefreshToken:'fixture-refresh',entitlement:{plan:' member '}});
 expect(p.consumed()).toBe(fixture.frames.length);expect(p.closed()).toBe(1);expect(p.timeouts).toContain(120000);expect(r.marks()).toBe(0);
});
for(const failure of ['storage','invalid','received-only'])test(`account frame ${failure} never invents applied or advances library cursor`,async()=>{
 const request=structuredClone(phoneFixture.cases[0]!.frames[3]) as JsonObject;
 if(failure==='invalid')(request.account as JsonObject).watchAccessToken=(request.account as JsonObject).watchDeviceToken='';
 let writes=0,events=0;
 const store=new WatchAccountStore({get:()=>null,set:()=>{if(failure==='storage')throw Error('secure unavailable');writes++;},remove:()=>{}});
 const handler=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'watch-fixture',notesChanged:()=>{},accountStore:store,accountUriParse:parseJava,accountTelemetry:{recordSyncAccount:()=>{events++;},backlogCount:()=>1}});
 const p=phone([request,{action:'ack',phase:'received',success:true,applied:false}]),r=repository();
 const result=await new LibrarySyncSession(p.connection,r.repo,{handleAction:handler}).run();
 expect(p.out[0]?.success).toBe(failure==='received-only');expect(writes).toBe(failure==='received-only'?1:0);expect(events).toBe(writes);
 expect(result[0]?.ack?.applied).toBe(false);expect(r.marks()).toBe(0);expect(p.closed()).toBe(1);
});
test('debug export matches native Kotlin/Android JSON fixture including number token types and UTF-16 tails',async()=>{
 const raw='x'.repeat(700005)+'中😀';
 const handler=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'',notesChanged:()=>{},readDebugLog:maxChars=>debugLogReply(raw,{maxChars})});
 for(const row of debugFixture.cases){
  const request=parseWireJson(row.raw),reply=debugLogReply(raw,request),{log,...fields}=reply;
  expect<unknown>({...fields,logLength:log.length,tailCodeUnits:log.slice(-4).split('').map(c=>c.charCodeAt(0))}).toEqual(row.expected);
  request.action='pullDebugLog';expect(await handler(request)).toEqual(reply);
 }
 for(const raw of [null,undefined,''])expect(debugLogReply(raw,{})).toEqual({success:true,action:'pullDebugLog',log:'',truncated:false,totalChars:0});
});
test('account telemetry counts Shanghai days, retains seven days and survives restart without secrets',()=>{
 const data=new Map<string,string>(),storage={get:(key:string)=>data.get(key),set:(key:string,value:string)=>{data.set(key,value);}};
 let now=Date.parse('2026-10-01T15:59:59Z');const telemetry=new SyncAccountTelemetry(storage,()=>now);
 telemetry.recordSyncAccount();telemetry.recordSyncAccount();expect(telemetry.backlogCount()).toBe(1);
 now+=1000;telemetry.recordSyncAccount();expect(telemetry.backlogCount()).toBe(2);
 const snapshots=JSON.parse([...data.values()][0]!);expect(snapshots[0]).toMatchObject({day:'2026-10-01',eventCounts:{sync_account:2},syncSuccessCount:2});
 now=Date.parse('2026-10-08T00:00:00Z');telemetry.recordSyncAccount();
 expect(new SyncAccountTelemetry(storage).backlogCount()).toBe(2);
 expect(JSON.parse([...data.values()][0]!).map((x:{day:string})=>x.day)).toEqual(['2026-10-02','2026-10-08']);
});
