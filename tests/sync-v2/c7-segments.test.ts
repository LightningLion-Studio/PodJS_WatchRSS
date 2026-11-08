/** C7 product paths: publisher, reader, bindings, write gate and failure retention. */
import {test,expect} from 'bun:test';
import {randomBytes,createCipheriv,createHash,hkdfSync,createHmac} from 'node:crypto';
import {scope,idKey,libraryId,binding,cipher,noteValue,SqlFixture} from './fixture';
import {SyntheticIndexBackend,crypto,publicBytes,serverPin} from './p2-fixture';
import {canonical,jsonBytes,bytes,parseCanonicalJson} from '../../src/sync-v2/protocol';
import {b64} from '../../src/sync-v2/wire';
import {objectOid,sealV2} from '../../src/sync-v2/sealed';
import {signControl} from '../../src/sync-v2/signing';
import {SyncV2Http,SyncV2Error,parseNetwork} from '../../src/sync-v2/http';
import {WatchProjectionStore} from '../../src/sync-v2/store';
import {ProjectionGate} from '../../src/sync-v2/gate';
import {WatchIndexPublisher} from '../../src/sync-v2/publisher';
import {WatchCloudIndex,noteClosurePorts} from '../../src/sync-v2/cloud-index';
import {candidates,fromWire} from '../../src/sync-v2/business';
import {conflictSet,noteResolutionBudget} from '../../src/sync-v2/notes-conflict';
import {readSegmentedNote,splitOrdinary,encodeNote,NOTE_TEXT_BUDGET} from '../../src/sync-v2/note-segments';

const keys={id:idKey,content:Buffer.alloc(32,0x22),version:1},device='a'.repeat(32),approved=async(deviceId:string)=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)});
const fail=(code:string,status=409)=>({status,headers:{},body:jsonBytes({error:{code,retryable:false,retryAfterMillis:null,details:{}}})});
/** Synthetic backend with the C7 write gate, child-table checks and counters. */
class C7Backend extends SyntheticIndexBackend {
 advertise=true;gate=true;completed:string[]=[];refsPosted:any[]=[];
 override async request(r:any):Promise<any>{
  const path=decodeURIComponent(new URL(r.url).pathname.replace('/functions/v1/sync/v2',''));
  if(path==='/capabilities'){const res=await super.request(r),v=parseNetwork(res.body);v.features=this.advertise?['note-segments.v1']:[];return {...res,body:jsonBytes(v)};}
  if(path==='/state-refs'&&r.method==='POST'){const v=parseNetwork(r.body);if(v.body.segmentOids.length){if(!this.gate)return fail('feature_disabled',503);if(v.body.segmentOids.some((id:string)=>!this.objects.has(id)||!this.tables.has(id)))return fail('closure_incomplete',412);}this.refsPosted.push(v);}
  if(path.startsWith('/state-refs/')&&r.method==='GET'&&!this.tables.has(path.slice(12)))return fail('object_missing',404);
  if(path.startsWith('/objects/')&&r.method==='GET'&&!path.includes('/parts/')&&!this.objects.has(path.slice(9)))return fail('object_missing',404);
  const res=await super.request(r),done=path.match(/^\/objects\/(.+)\/complete$/);if(done)this.completed.push(done[1]!);return res;
 }
 snapshot(){return {objects:new Map(this.objects),tables:new Map(this.tables)};}
 restore(s:{objects:Map<string,Uint8Array>;tables:Map<string,any>}){this.objects=new Map(s.objects);this.tables=new Map(s.tables);}
}
async function client(server:C7Backend,options:{write?:boolean;read?:boolean;project?:boolean}={}){
 const db=new SqlFixture(),store=new WatchProjectionStore(db,cipher,new ProjectionGate(true),scope,libraryId,idKey,async()=>{},{noteSegments:options.project??options.write!==false});await store.initialize();await store.beginScan(binding);
 const http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'approved-old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,serverPin());
 const publisher=new WatchIndexPublisher(store,http,crypto,keys,()=>100,undefined,{noteSegments:options.write!==false}),reader=new WatchCloudIndex(store,http,crypto,keys,approved,async()=>{},()=>100,undefined,{noteSegments:options.read!==false});
 return {db,store,http,publisher,reader,
  async scan(rows:any[]){const cp=await store.checkpoint();if(cp&&cp.phase!=='scan')await store.restartScan();await store.scanPage({page:async()=>({rows,after:'end',done:true}),changed:async()=>[]});},
  async prepare(){return publisher.prepare(device,'key',{commitOid:server.device.commitOid,revision:server.device.revision},randomBytes(16).toString('hex'));},
  async publish(){const plan=await this.prepare();await publisher.flush();return plan;},
  pull(){return reader.pull(server.window());},
  /** Stands in for the P5 follow of a device without unpublished edits: the
   * authenticated current account becomes this device's edit base. */
  async adopt(){await reader.pull(server.window());const s=await store.readState();await store.controlUpdate(s,{...s,hasUnsentEdits:false,editBase:{accountOid:s.account!.oid,generation:s.account!.generation}});},
  close(){db.close();},
 };
}
const long=(markdown:string,extra:any={})=>({kind:'note',logicalId:'long',value:{...noteValue('long'),markdown,plainText:'',baseMarkdown:'',...extra}});
const base='a'.repeat(600000);
const entity=async(c:any)=>(await c.store.candidatePage())[0].entityKey;
const statePlans=(server:C7Backend,from:number)=>server.completed.slice(from).filter(id=>id.startsWith('state:')).length;

test('C7 product roundtrip: ordered segment tables, authenticated reassembly into another store',async()=>{
 const server=new C7Backend(),a=await client(server),b=await client(server);try{
  await a.scan([long(base+'\r\nend\u0000😀')]);const plan=await a.publish();expect(plan.segments).toEqual({uploaded:3,reused:0});
  const posted=server.refsPosted.map(t=>t.body.segmentOids.length);expect(posted.slice(0,3)).toEqual([0,0,0]);expect(posted.at(-1)).toBe(3);
  await b.pull();const row=(await b.store.cloudRows((await b.store.readState()).cloud.current.treeRoot))[0],local=(await a.store.candidatePage())[0].candidate;
  expect(canonical(row.state)).toBe(canonical(local.state));expect(row.state.noteSegments).toEqual([]);expect(row.state.requiredFeatures).toEqual([]);
  expect(fromWire('note',row.meta.payload,row.state.payload).markdown).toBe(base+'\r\nend\u0000😀');expect(row.segments.objects.length).toBe(3);
  expect(row.state.payload.contentHash).toBe('h');expect(row.meta.payload).not.toHaveProperty('contentHash');
 }finally{a.close();b.close();}
},120000);

test('C7 increment: tail append and same-length edit upload one segment and one parent each',async()=>{
 const server=new C7Backend(),a=await client(server);try{
  await a.scan([long(base)]);await a.publish();await a.pull();const e=await entity(a),first=(await a.store.noteBinding(e))!;
  let mark=server.completed.length;await a.scan([long(base+'tail')]);let plan=await a.publish();await a.pull();
  expect(plan.segments).toEqual({uploaded:1,reused:2});expect(statePlans(server,mark)).toBe(2);
  const same=base.slice(0,300000)+'b'+base.slice(300001)+'tail';mark=server.completed.length;await a.scan([long(same)]);plan=await a.publish();await a.pull();
  expect(plan.segments).toEqual({uploaded:1,reused:2});expect(statePlans(server,mark)).toBe(2);expect((await a.store.noteBinding(e))!.revision).toBe(first.revision);
  // A middle insertion that moves later boundaries re-sends the moved segments only.
  mark=server.completed.length;await a.scan([long('x'+same)]);plan=await a.publish();expect(plan.segments.reused).toBe(0);expect(statePlans(server,mark)).toBe(4);
 }finally{a.close();}
},180000);

test('C7 25.5 failures at pull: no application, no cursor/state advance, quarantine only for unsupported',async()=>{
 const server=new C7Backend(),a=await client(server);try{
  await a.scan([long(base)]);await a.publish();const clean=server.snapshot(),head=parseCanonicalJson(server.objects.get(server.account.commitOid)!);
  const parentOid=[...server.tables.values()].find(t=>[...server.tables.values()].some(x=>x.parentOid===t.parentOid)&&server.refsPosted.some(p=>p.body.stateOid===t.parentOid&&p.body.segmentOids.length))!.parentOid;
  const parentRefs=server.refsPosted.find(p=>p.body.stateOid===parentOid)!,segs:string[]=parentRefs.body.segmentOids;
  const repost=async(segmentOids:string[],badSignature=false)=>{const signed=await signControl(crypto,'key','wrss.sync.v2/state-refs-sign',{scope,stateOid:parentOid,segmentOids});if(badSignature)signed.signature='A'.repeat(86);const raw=jsonBytes(signed),id=objectOid('state-refs',raw);server.objects.set(id,raw);server.tables.set(parentOid,{...server.tables.get(parentOid),refsOid:id,totalBytes:raw.length});};
  const cases:[string,()=>Promise<void>|void,boolean?][]=[
   ['closure_incomplete',()=>{server.objects.delete(segs[1]!);}],
   ['hash_mismatch',()=>{const raw=Uint8Array.from(server.objects.get(segs[0]!)!);raw[raw.length-1]!^=1;server.objects.set(segs[0]!,raw);}],
   ['closure_incomplete',()=>{server.tables.delete(segs[2]!);}],
   ['invalid_schema',()=>repost([segs[1]!,segs[0]!,segs[2]!])],
   ['signature_invalid',()=>repost(segs,true)],
   ['unsupported_feature',()=>{},true],
  ];
  for(const [code,mutate,oldReader]of cases){
   server.restore(clean);await mutate();const b=await client(server,{read:!oldReader});try{
    const before=await b.store.readState();await expect(b.pull()).rejects.toThrow(code);
    const after=await b.store.readState();expect(after.cloud?.current??null).toBe(null);expect(after.account).toBe(null);expect(after.localChangeRevision).toBe(before.localChangeRevision);expect(after.acknowledgedLocalChangeRevision).toBe(before.acknowledgedLocalChangeRevision);
    // Only an unsupported feature records a block marker beside the quarantined original bytes.
    if(code==='unsupported_feature')expect(after.cloud.blockedCode).toBe('unsupported_feature');else expect(canonical(after)).toBe(canonical(before));
    const table=(name:string)=>(b.db.raw.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name=?").get(name) as any).n?(b.db.raw.query('SELECT COUNT(*) AS n FROM '+name).get() as any).n:0;expect(table('syncv2_cloud_rows')).toBe(0);
    const quarantined=table('syncv2_quarantine');
    expect(quarantined>0).toBe(code==='unsupported_feature');
   }finally{b.close();}
  }
  server.restore(clean);const ok=await client(server);try{await ok.pull();expect((await ok.store.readState()).account?.oid).toBe(server.account.commitOid);}finally{ok.close();}
  expect(head.body.requiredFeatures).toEqual([]);
 }finally{a.close();}
},180000);

const sealPlain=(plain:Uint8Array)=>{const salt=randomBytes(32),nonce=randomBytes(12),lp=(v:Uint8Array[])=>Buffer.concat(v.flatMap(x=>{const n=Buffer.alloc(4);n.writeUInt32BE(x.length);return [n,Buffer.from(x)];}));
 const opaque=createHmac('sha256',idKey).update(lp([bytes('wrss.sync.v2/content'),jsonBytes(scope),bytes('state'),createHash('sha256').update(plain).digest()])).digest('hex');
 const h={domain:'wrss.sync.v2/sealed',version:2,scope,keyVersion:1,type:'state',opaqueContentId:opaque,encoding:'identity',plainBytes:plain.length,encodedBytes:plain.length,salt:b64(salt),nonce:b64(nonce)},aad=jsonBytes(h);
 const key=Buffer.from(hkdfSync('sha256',keys.content,salt,lp([bytes('wrss.sync.v2/aead'),createHash('sha256').update(aad).digest()]),32)),c=createCipheriv('aes-256-gcm',key,nonce);c.setAAD(aad);const n=Buffer.alloc(4);n.writeUInt32BE(aad.length);
 const wire=Buffer.concat([bytes('WRS2'),n,aad,c.update(plain),c.final(),c.getAuthTag()]);return {oid:objectOid('state',wire),wire};};
test('C7 25.5 order: oversize before missing, malformed refs are invalid_schema, budget is storage_pressure',async()=>{
 const e='22'.repeat(32),rev='33'.repeat(16),big=sealPlain(bytes('x'.repeat(262145))),other='state:sha256:'+'9'.repeat(64),parent={version:2,entityKey:e,requiredFeatures:['note-segments.v1'],payload:{segmentedNote:true,noteRevision:rev,segmentCount:2,plaintextSha256:'0'.repeat(64),metadata:{}},noteSegments:[big.oid,other]};
 const objects=new Map<string,Uint8Array>([[big.oid,big.wire]]),tables=new Map<string,any>();
 const port=(malformed=false)=>noteClosurePorts({scope,async stateRefs(_w:string,id:string){if(malformed)return {version:2,scope,parentOid:id,refsOid:objectOid('state-refs',jsonBytes({signature:'x'})),authorDeviceId:'a'.repeat(32),keyId:'b'.repeat(32),totalBytes:jsonBytes({signature:'x'}).length};if(!tables.has(id))throw new SyncV2Error('object_missing');return tables.get(id);}} as any,async id=>{if(malformed&&id.startsWith('state-refs:'))return jsonBytes({signature:'x'});const v=objects.get(id);if(!v)throw new SyncV2Error('object_missing');return v;},crypto,keys,approved,'1'.repeat(32));
 const read=(p:any,o:any={})=>readSegmentedNote('state:sha256:'+'8'.repeat(64),p,p.ports??port(),{entityKey:e,supported:['note-segments.v1'],...o});
 await expect(read(parent)).rejects.toThrow('object_too_large');
 const small=sealPlain(jsonBytes({version:2,entityKey:e,requiredFeatures:[],payload:{segmentOf:rev,index:0,text:'{"markdown":"x"}'},noteSegments:[]})),p2={...parent,noteSegments:[small.oid,other]};objects.set(small.oid,small.wire);
 await expect(read(p2)).rejects.toThrow('closure_incomplete');objects.set(other,small.wire);
 await expect(readSegmentedNote('state:sha256:'+'8'.repeat(64),{...p2,payload:{...p2.payload,segmentCount:1},noteSegments:[small.oid]},port(true),{entityKey:e,supported:['note-segments.v1']})).rejects.toThrow('invalid_schema');
 await expect(read({...parent,payload:{...parent.payload,segmentCount:3}})).rejects.toThrow('invalid_schema');
 await expect(read(parent,{supported:[]})).rejects.toThrow('unsupported_feature');
 // The budget covers plaintext plus one sealed-envelope allowance per segment.
 const mid=sealPlain(jsonBytes({version:2,entityKey:e,requiredFeatures:[],payload:{segmentOf:rev,index:0,text:'x'.repeat(20000)},noteSegments:[]}));objects.set(mid.oid,mid.wire);
 await expect(read({...p2,noteSegments:[mid.oid,other]},{budget:10})).rejects.toThrow('storage_pressure');
});

test('C7 25.8 write gate: closed backend keeps the queue, missing feature keeps the candidate, opt-out cannot segment',async()=>{
 const server=new C7Backend();server.gate=false;const a=await client(server);try{
  await a.scan([long(base)]);const e=await entity(a);await a.prepare();await expect(a.publisher.flush()).rejects.toThrow('feature_disabled');
  const queued=(await a.store.readState()).cloud.pendingPublish,revision=(await a.store.noteBinding(e))!.revision;expect(queued.phase).toBe('queued');expect(server.account.commitOid).toBe(null);
  server.gate=true;await a.publisher.flush();expect(server.account.commitOid).toBe(queued.commitOid);expect((await a.store.noteBinding(e))!.revision).toBe(revision);
 }finally{a.close();}
 const closed=new C7Backend();closed.advertise=false;const b=await client(closed);try{
  await b.scan([long(base)]);const before=await b.store.readState(),candidate=canonical(await b.store.candidatePage());await expect(b.prepare()).rejects.toThrow('feature_disabled');
  const after=await b.store.readState();expect(after.cloud.pendingPublish??null).toBe(null);expect(canonical(await b.store.candidatePage())).toBe(candidate);expect(await b.store.noteBinding(await entity(b))).toBe(null);expect(after.localChangeRevision).toBe(before.localChangeRevision);
 }finally{b.close();}
 const optOut=await client(new C7Backend(),{write:false,project:true});try{await optOut.scan([long(base)]);await expect(optOut.prepare()).rejects.toThrow('object_too_large');}finally{optOut.close();}
 const noProject=await client(new C7Backend(),{project:false,write:false});try{await expect(noProject.scan([long(base)])).rejects.toThrow('object_too_large');expect(await noProject.store.candidatePage()).toEqual([]);}finally{noProject.close();}
 expect(()=>candidates('note','long','2'.repeat(64),long(base).value)).toThrow('object_too_large');
 expect(()=>candidates('note','long','2'.repeat(64),long('x'.repeat(NOTE_TEXT_BUDGET)).value,undefined,{noteSegments:true})).toThrow('storage_pressure');
 // Short notes keep the ordinary root, readable by a client without segment support.
 const s=new C7Backend(),w=await client(s),old=await client(s,{read:false,write:false});try{await w.scan([long('short '.repeat(1000))]);await w.publish();await old.pull();const row=(await old.store.cloudRows((await old.store.readState()).cloud.current.treeRoot))[0];expect(row.segments).toBeUndefined();expect(row.state.noteSegments).toEqual([]);}finally{w.close();old.close();}
},180000);

test('C7 25.3 bindings: local first, delete-restore and remote recreate get fresh values, scope-local',async()=>{
 const server=new C7Backend(),a=await client(server),b=await client(server);try{
  await a.scan([long(base)]);await a.publish();await a.pull();const e=await entity(a),x=(await a.store.noteBinding(e))!.revision!;
  // B adopts the current authenticated binding and reuses its segments.
  await b.adopt();await b.scan([long(base+'b')]);let plan=await b.prepare();expect((await b.store.noteBinding(e))!.revision).toBe(x);expect(plan.segments.reused).toBe(2);await b.publisher.flush();await b.pull();
  // A deletes and restores locally without publishing the deletion: fresh binding, no reuse.
  await a.adopt();await a.scan([long(base+'b',{deleted:true,deletedAt:5})]);expect(await a.store.noteBinding(e)).toEqual({revision:null,life:'deleted'});
  await a.scan([long(base+'b',{updatedAt:9})]);plan=await a.publish();const y=(await a.store.noteBinding(e))!.revision!;expect(y).not.toBe(x);expect(plan.segments).toEqual({uploaded:3,reused:0});
  // B has no unpublished edit: observing the remote recreate drops its old binding, then adopts Y.
  await b.adopt();expect(await b.store.noteBinding(e)).toBe(null);await b.scan([long(base+'b',{updatedAt:9,title:'t2'})]);plan=await b.prepare();expect((await b.store.noteBinding(e))!.revision).toBe(y);expect(plan.segments.reused).toBe(3);await b.publisher.flush();
  // R1: A keeps its persisted binding while it holds an unpublished edit, whatever the remote binding is.
  await a.store.controlUpdate(await a.store.readState(),{...(await a.store.readState())},[await a.store.noteBindingStatement(e,{revision:'5'.repeat(32),life:'live'})]);
  await a.scan([long(base+'local edit')]);await a.pull();expect((await a.store.noteBinding(e))!.revision).toBe('5'.repeat(32));
  const row=await a.store.cloudRow((await a.store.readState()).cloud.current.treeRoot,e),objects=new Map<string,Uint8Array>(),bindings:any[]=[],c=(await a.store.candidatePage())[0].candidate;
  const oid=await (a.publisher as any).sealState(e,c,row,'key',objects,bindings);const parent=[...objects].find(([id])=>id===oid)!;expect(parent).toBeTruthy();expect(row.segments.noteRevision).toBe(y);
  const opened=await (await import('../../src/sync-v2/sealed')).openV2(crypto,keys.id,keys.content,scope,oid,parent[1]);expect(opened.value.payload.noteRevision).toBe('5'.repeat(32));expect(bindings).toEqual([]);
  // Bindings are scoped: another scope never sees them.
  const other=new WatchProjectionStore(b.db,cipher,new ProjectionGate(true),{...scope,contentGeneration:'3'},libraryId,idKey,async()=>{},{noteSegments:true});await other.initialize();expect(await other.noteBinding(e)).toBe(null);
 }finally{a.close();b.close();}
},240000);

test('C7 25.3 observe: a remote tombstone marks the local life deleted',async()=>{
 const server=new C7Backend(),a=await client(server),b=await client(server);try{
  await a.scan([long(base)]);await a.publish();await b.adopt();await b.scan([long(base+'b')]);await b.publish();const e=await entity(b);expect((await b.store.noteBinding(e))!.life).toBe('live');
  await a.adopt();await a.scan([long(base+'b',{deleted:true,deletedAt:7})]);await a.publish();await b.pull();expect(await b.store.noteBinding(e)).toEqual({revision:null,life:'deleted'});
 }finally{a.close();b.close();}
},180000);

test('C7 25.6 budget: long resolution charges every segment; an oversized conflict container fails and keeps everything',()=>{
 const records=(n:number)=>[{conflictId:'c',noteId:'n',baseMarkdown:'b'.repeat(n),localMarkdown:'l'.repeat(n),remoteMarkdown:'r'.repeat(n),remoteDeviceId:'x',createdAt:1,resolvedAt:0}];
 const state=(markdown:string,n:number)=>({note:{...noteValue('n'),markdown,baseMarkdown:markdown},conflicts:conflictSet('n',records(n)),entityKey:'2'.repeat(64)});
 const short=noteResolutionBudget({},state('short',10)),longer=noteResolutionBudget({},state(base,10));
 expect(longer.closureStoredBytes).toBeGreaterThan(2*600000);expect(longer.closureStoredBytes).toBeGreaterThan(short.closureStoredBytes);
 const big=state(base,90000),before=canonical(big);expect(()=>noteResolutionBudget({},big)).toThrow('object_too_large');expect(canonical(big)).toBe(before);
 const input=splitOrdinary({version:2,entityKey:'2'.repeat(64),requiredFeatures:[],payload:{markdown:base,plainText:''},noteSegments:[]});expect(()=>encodeNote(input,'3'.repeat(32),()=>{},100)).toThrow('storage_pressure');
});

test('C7 follow projection builds long-note candidates with the same option as scan',async()=>{
 for(const enabled of [true,false]){
  const server=new C7Backend(),c=await client(server,{project:enabled});try{
   const before=await c.store.readState(),record=long(base);
   const run=c.store.prepareAccountProjection(before,[record as any],[]);
   if(enabled)expect(Array.isArray(await run)).toBe(true);else await expect(run).rejects.toThrow('object_too_large');
  }finally{c.close();}
 }
});
