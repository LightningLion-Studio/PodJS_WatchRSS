/** C7 review F2: the pull and publication-preparation resident peak is bounded by
 * one long note, not by the number of long notes in the account. The peak is
 * the live JS heap after a full GC, sampled at every transport request,
 * signature, staging write and candidate/cloud-row read, minus the heap before
 * the operation (the synthetic server's objects are already resident). */
import {test,expect} from 'bun:test';
import {randomBytes} from 'node:crypto';
import {scope,idKey,libraryId,binding,cipher,noteValue,SqlFixture} from './fixture';
import {SyntheticIndexBackend,crypto,publicBytes,serverPin} from './p2-fixture';
import {jsonBytes,parseCanonicalJson} from '../../src/sync-v2/protocol';
import {b64} from '../../src/sync-v2/wire';
import {SyncV2Http,parseNetwork} from '../../src/sync-v2/http';
import {WatchProjectionStore} from '../../src/sync-v2/store';
import {ProjectionGate} from '../../src/sync-v2/gate';
import {WatchIndexPublisher} from '../../src/sync-v2/publisher';
import {WatchCloudIndex} from '../../src/sync-v2/cloud-index';

const keys={id:idKey,content:Buffer.alloc(32,0x22),version:1},device='a'.repeat(32),MiB=1024*1024;
const approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)});
const fail=(code:string,status=409)=>({status,headers:{},body:jsonBytes({error:{code,retryable:false,retryAfterMillis:null,details:{}}})});
/** Sampling probe: full GC, then the live heap above the baseline. */
const probe={on:false,base:0,peak:0,sample(){if(!this.on)return;Bun.gc(true);const used=process.memoryUsage().heapUsed-this.base;if(used>this.peak)this.peak=used;}};
async function measure<T>(run:()=>Promise<T>){Bun.gc(true);probe.base=process.memoryUsage().heapUsed;probe.peak=0;probe.on=true;try{const out=await run();probe.sample();return {out,peakMiB:+(probe.peak/MiB).toFixed(2)};}finally{probe.on=false;}}
class C7Backend extends SyntheticIndexBackend {
 override async request(r:any):Promise<any>{
  probe.sample();const path=decodeURIComponent(new URL(r.url).pathname.replace('/functions/v1/sync/v2',''));
  if(path==='/capabilities'){const res=await super.request(r),v=parseNetwork(res.body);v.features=['note-segments.v1'];return {...res,body:jsonBytes(v)};}
  if(path.startsWith('/state-refs/')&&r.method==='GET'&&!this.tables.has(path.slice(12)))return fail('object_missing',404);
  if(path.startsWith('/objects/')&&r.method==='GET'&&!path.includes('/parts/')&&!this.objects.has(path.slice(9)))return fail('object_missing',404);
  return super.request(r);
 }
}
const sampled=(target:any,names:string[])=>{for(const name of names){const f=target[name].bind(target);target[name]=async(...a:any[])=>{probe.sample();const out=await f(...a);probe.sample();return out;};}return target;};
async function client(server:C7Backend){
 const db=new SqlFixture(),store=sampled(new WatchProjectionStore(db,cipher,new ProjectionGate(true),scope,libraryId,idKey,async()=>{},{noteSegments:true}),['stageCloudRows','stageUpload','cloudRow','cloudRows','candidatePage']);await store.initialize();await store.beginScan(binding);
 const signing=sampled({...crypto},['sign','encrypt']);
 const http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'approved-old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin());
 const publisher=new WatchIndexPublisher(store,http,signing,keys,()=>100,undefined,{noteSegments:true}),reader=new WatchCloudIndex(store,http,signing,keys,approved,async()=>{},()=>100,undefined,{noteSegments:true});
 return {store,publisher,reader,
  async scan(rows:any[]){const cp=await store.checkpoint();if(cp&&cp.phase!=='scan')await store.restartScan();for(let i=0;i<rows.length;i++)await store.scanPage({page:async()=>({rows:[rows[i]],after:'r'+String(i).padStart(4,'0'),done:i===rows.length-1}),changed:async()=>[]});},
  prepare(){return publisher.prepare(device,'key',{commitOid:server.device.commitOid,revision:server.device.revision},randomBytes(16).toString('hex'));},
  async adopt(){await reader.pull(server.window());const s=await store.readState();await store.controlUpdate(s,{...s,hasUnsentEdits:false,editBase:{accountOid:s.account!.oid,generation:s.account!.generation}});},
  close(){db.close();},
 };
}
/** About 650 KB of B per note (three equal CJK fields), distinct text per note. */
const longNote=(i:number)=>{const t=String.fromCharCode(0x4e00+i).repeat(72222)+'x'.repeat(i);return {kind:'note',logicalId:'n'+i,value:{...noteValue('n'+i),markdown:t,plainText:t,baseMarkdown:t}};};

test('F2: pull and publication-preparation peaks do not grow with the number of long notes',async()=>{
 const rows:any[]=[];
 for(const n of [1,6,20]){
  const server=new C7Backend(),writer=await client(server),reader=await client(server);try{
   await writer.scan(Array.from({length:n},(_,i)=>longNote(i)));
   const first=await measure(()=>writer.prepare());expect(first.out.segments.uploaded).toBe(3*n);await writer.publisher.flush();
   const pull=await measure(()=>reader.reader.pull(server.window()));expect(pull.out.rows).toBe(n);
   // One unrelated edit against an account holding n long notes (current rows path).
   await reader.adopt();await reader.scan([{kind:'note',logicalId:'mine',value:noteValue('mine')}]);
   const edit=await measure(()=>reader.prepare());expect(edit.out.segments).toEqual({uploaded:0,reused:0});
   rows.push({longNotes:n,firstPrepareMiB:first.peakMiB,pullMiB:pull.peakMiB,editPrepareMiB:edit.peakMiB});
  }finally{writer.close();reader.close();}
 }
 console.log('C7-F2',JSON.stringify(rows));
 // Bounded by one note (B=0.62 MiB; S0 + sealed segments + staging copies), not by n.
 for(const k of ['firstPrepareMiB','pullMiB','editPrepareMiB'] as const){
  const one=rows[0][k],twenty=rows[2][k];expect(twenty).toBeLessThan(one*1.5+2);expect(twenty).toBeLessThan(12);
 }
},600000);
