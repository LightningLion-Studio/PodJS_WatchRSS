/** C7 review F2 on an owned emulator: publication preparation and pull of N long
 * notes inside the QuickJS background runtime, under a caller-chosen guest
 * memory limit. The synthetic loopback server owns all keys; nothing here is an
 * account material. Only counts and timings are exported. */
import {createSyncV2Crypto,hex} from '@podjs/framework/crypto';
import {encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import {jsonBytes,canonical} from '../../../src/sync-v2/protocol';
import type {LocalCipher} from '../../../src/sync-v2/store';
import {SyncV2Http,parseNetwork} from '../../../src/sync-v2/http';
import {WatchServiceKeyPin} from '../../../src/sync-v2/service-key';
import {WatchProjectionStore} from '../../../src/sync-v2/store';
import {ProjectionGate} from '../../../src/sync-v2/gate';
import {localProjectionCipher,projectionSql} from '../../../src/sync-v2/host';
import {WatchCloudIndex} from '../../../src/sync-v2/cloud-index';
import {WatchIndexPublisher} from '../../../src/sync-v2/publisher';

const scope={repoId:'01'.repeat(16),libraryEpoch:'1',contentGeneration:'2'},libraryId='aa'.repeat(16),idKey=new Uint8Array(32).fill(17),device='a'.repeat(32),accountId='0'.repeat(31)+'1';
const binding={schema:'frozen-v2-rc6',descriptorPin:'repo-descriptor:sha256:'+'a'.repeat(64),accountScope:'synthetic',capability:'local-projection-v1'};
const noteValue=(id:string)=>({noteId:id,folderId:null,title:'title '+id,markdown:'local\ntext',plainText:'local text',contentHash:'h',baseContentHash:'base-h',baseMarkdown:'ancestor',pinned:false,createdAt:1,updatedAt:2,modifiedBy:'watch',deleted:false,deletedAt:0});
/** Same shape as tests/sync-v2/c7-memory.test.ts (72222 chars: about 650 KB of B). */
const longNote=(i:number,chars:number)=>{const t=String.fromCharCode(0x4e00+i).repeat(chars)+'x'.repeat(i);return {kind:'note',logicalId:'n'+i,value:{...noteValue('n'+i),markdown:t,plainText:t,baseMarkdown:t}};};
const check=(v:unknown,code:string)=>{if(!v)throw Error(code);};
/** The product local cipher rejects plaintext above 768 KiB (src/sync-v2/host.ts).
 * A long note's staged cloud row exceeds that, so this probe seals larger values
 * through the same host operation and reports their count and largest size. */
const oversized={calls:0,maxBytes:0};
function probeCipher(host:any,base:LocalCipher):LocalCipher {
 return {nativeKey:()=>base.nativeKey!(),open:(aad,sealed)=>base.open(aad,sealed),
  async seal(aad,value){const input=jsonBytes(value);oversized.maxBytes=Math.max(oversized.maxBytes,input.length);if(input.length<=768*1024)return base.seal(aad,value);oversized.calls++;
   return canonical(await host('crypto.aesGcmEncrypt',{keyBase64:(await base.nativeKey!()).keyBase64,aadBase64:encodeBase64(jsonBytes(aad)),dataBase64:encodeBase64(input)}));}};
}

(globalThis as any).backgroundHandler=async(ctx:any)=>{
 const f=ctx.payload,origin=f.baseUrl,host:any=(method:string,args:any)=>ctx.request('cloud.host',{method,args});
 let requests=0,stage='setup';
 try{
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)&&(f.mode==='publish'||f.mode==='pull')&&f.notes>=1&&f.notes<=64&&f.chars>=1,'isolated_fixture_required');
  const crypto=createSyncV2Crypto(host),keys={id:idKey,content:new Uint8Array(32).fill(0x22),version:1},db=projectionSql(host);
  const transport={async request(r:any){requests++;const out=await host('http',{...r,body:r.body?encodeBase64(r.body):null});return {...out,body:decodeBase64(out.body)};}};
  const control=async(path:string)=>{const r=await transport.request({method:'GET',url:origin+'/c7/'+path,headers:{},body:null});check(r.status===200,'control_http');return parseNetwork(r.body);};
  const pinSlots=new Map<string,string>(),pin=new WatchServiceKeyPin({get:async k=>pinSlots.get(k),compareAndSet:async(k,old,value)=>{if((pinSlots.get(k)??null)!==old)return false;pinSlots.set(k,value);return true;}},accountId,async()=>({accountId,syncV2:f.serviceInfo}));
  const http=new SyncV2Http(transport,origin,scope,async()=>({accessToken:'synthetic',legacyDeviceId:'approved-old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,pin);
  const base=localProjectionCipher(host,'c7-memory:'+f.runId);await base.seal('probe',{});
  const store=new WatchProjectionStore(db,probeCipher(host,base),new ProjectionGate(true),scope,libraryId,idKey,async()=>{},{noteSegments:true});
  await store.initialize();await store.beginScan(binding);
  const approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:f.publicKeyBase64Url});
  const publisher=new WatchIndexPublisher(store,http,crypto,keys,()=>100,undefined,{noteSegments:true}),reader=new WatchCloudIndex(store,http,crypto,keys,approved,async()=>{},()=>100,undefined,{noteSegments:true});
  const scan=async(count:number,row:(i:number)=>any)=>{const cp=await store.checkpoint();if(cp&&cp.phase!=='scan')await store.restartScan();for(let i=0;i<count;i++)await store.scanPage({page:async()=>({rows:[row(i)],after:'r'+String(i).padStart(4,'0'),done:i===count-1}),changed:async()=>[]});};
  const prepare=async()=>{const d=await control('device');return publisher.prepare(device,'key',{commitOid:d.commitOid,revision:d.revision},hex(await crypto.random(16)));};
  const timed=async<T>(label:string,run:()=>Promise<T>)=>{stage=label;const started=Date.now(),before=requests,out:any=await run();const step={stage:label,millis:Date.now()-started,requests:requests-before};await host('result',{event:'step',...step});return out;};
  if(f.mode==='publish'){
   await timed('scan',()=>scan(f.notes,i=>longNote(i,f.chars)));
   const prepared=await timed('prepare',prepare);check(prepared.segments.uploaded>=2*f.notes,'segments_uploaded');await host('result',{event:'prepared',segments:prepared.segments,objects:prepared.objects});
   if(f.flush){await timed('flush',()=>publisher.flush());}
  }else{
   const window=await control('window'),pulled=await timed('pull',()=>reader.pull(window));check(pulled.rows===f.notes,'pulled_rows');
   const s=await store.readState();await store.controlUpdate(s,{...s,hasUnsentEdits:false,editBase:{accountOid:s.account!.oid,generation:s.account!.generation}});
   await timed('scan-edit',()=>scan(1,()=>({kind:'note',logicalId:'mine',value:noteValue('mine')})));
   const prepared=await timed('edit-prepare',prepare);check(prepared.segments.uploaded===0&&prepared.segments.reused===0,'edit_segments');
  }
  await host('result',{event:'done',mode:f.mode,notes:f.notes,requests,oversizedSeals:oversized.calls,maxSealBytes:oversized.maxBytes});
  return 'success';
 }catch(error){
  await host('result',{event:'failed',stage,code:String((error as Error)?.message??error).slice(0,80),stack:String((error as Error)?.stack??'').slice(0,1200),requests});
  throw error;
 }
};
