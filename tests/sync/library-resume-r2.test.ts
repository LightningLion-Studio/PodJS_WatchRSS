import {test,expect} from 'bun:test';
import {fixture,vectors,nonce,frames,Peer} from '../helpers/library-resume-fixture';
import {objectId,objectsRoot,planDigest,pageDigest,selectionDigest,completion,offerDigest,preparationDigest,requestDigest,D} from '../../src/sync/library-resume/digests';
import {envelope,successResult,hash,ResumeError,type Envelope,type Row,type ObjectDescriptor,type BeginPayload,type Selection,type Snapshot,type Capability} from '../../src/sync/library-resume/wire';
import {decodeFrame,decodeFrameAsync} from '../../src/sync/protocol';
import {frameBytes} from '../../src/sync/wire-frame-size';
import {ResumeApplicationService} from '../../src/sync/library-resume/host';
import {WatchAccountStore} from '../../src/account/store';
const base=vectors.requests.find(v=>v.name==='begin')!.frame.payload as unknown as BeginPayload;
const deferred=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>resolve=r),resolve:()=>resolve()};};
const clone=<T>(x:T):T=>JSON.parse(JSON.stringify(x));
async function manifest(c:ReturnType<Awaited<ReturnType<typeof fixture>>['connect']>,objects:ObjectDescriptor[]){
 const p={...base,objectCount:objects.length,objectsRoot:objectsRoot(objects.map(o=>o.objectId)),pageObjectCounts:[objects.length]};c.phone.plan=planDigest(p);const r=await c.phone.request('begin',p as unknown as Row);expect(r.success).toBe(true);c.phone.epoch=r.epoch!;
 expect((await c.phone.request('manifestPage',{pageIndex:0,startIndex:0,previousPageDigest:'0'.repeat(64),pageDigest:pageDigest(c.phone.plan,0,0,objects,'0'.repeat(64)),entries:objects})).success).toBe(true);
}
function rawFrame(r:Row,spaces:number){const b=Buffer.from(' '.repeat(spaces)+JSON.stringify(r)),h=Buffer.alloc(4);h.writeUInt32BE(b.length);return Buffer.concat([h,b]);}

test('RVRESUMEC-IMPL-01 real host onCancel revokes paused final SQL before EOF',async()=>{
 const f=await fixture(),values=new Map<string,string>(),account=new WatchAccountStore({get:k=>values.get(k)??null,set:(k,v)=>{values.set(k,v);},remove:k=>{values.delete(k);}});
 let permission=true,cancel:()=>void=()=>{};const pair=frames(),entered=deferred(),release=deferred();let running:Promise<void>|undefined;
 try{
 await account.save({...vectors.account,phoneMasked:'',installId:'RESUMEC',watchDeviceToken:'SYNTHETIC',tokenExpiresAtMillis:0,watchRefreshToken:'',refreshTokenExpiresAtMillis:0,posthogHost:'',posthogProjectApiKey:'',entitlement:{plan:'free',active:true,expiresAtMillis:0,features:[]},telemetryConfig:{anonymousEnabled:false,diagnosticsEnabled:false,sampleRate:0},updatedAtMillis:0});
 const service=new ResumeApplicationService({store:f.store,chunks:f.chunks,account,repository:async()=>f.repository,randomId:async()=>nonce(),localPermission:()=>permission,readFile:async path=>f.native.files.get(path)!});
 const context={session:{},onCancel:(cb:()=>void)=>{cancel=cb;return ()=>{};}};
 const probe=await service.probe({deviceId:vectors.phoneDeviceId,supportedLibraryResumeVersions:[1]},context);await service.accountConfirmed({account:{userId:vectors.account.userId}},context);
 running=pair.watch.readFrame(10000).then(first=>service.run(first,pair.watch,context)).catch(()=>{});
 const phone=new Peer(pair.phone,probe.libraryResume as unknown as Capability),offerPayload={step:'offer',accountScope:vectors.accountScope,phoneDeviceId:vectors.phoneDeviceId,watchDeviceId:vectors.watchDeviceId,phoneCapabilities:vectors.capability,phoneSnapshot:vectors.phoneSnapshot,watchSnapshot:null};
 const offer=await phone.request('prepare',offerPayload),watch=offer.result!.watchSnapshot as unknown as Snapshot,bs=[{direction:'phoneToWatch' as const,jobId:phone.jobId,intent:'create' as const,selection:vectors.selection as Selection}];
 expect((await phone.request('prepare',{step:'confirm',offerRequestId:offer.requestId,bindings:bs,preparationDigest:preparationDigest(offerDigest(offerPayload,probe.libraryResume as unknown as Capability,watch),bs)})).success).toBe(true);
 const p={...base,watchSnapshot:watch};phone.plan=planDigest(p);const began=await phone.request('begin',p as unknown as Row);expect(began.success).toBe(true);phone.epoch=began.epoch!;
 const objects=vectors.objects as ObjectDescriptor[];expect((await phone.request('manifestPage',{pageIndex:0,startIndex:0,previousPageDigest:'0'.repeat(64),pageDigest:pageDigest(phone.plan,0,0,objects,'0'.repeat(64)),entries:objects})).success).toBe(true);await phone.stage();
 const original=f.db.transactionChanges!;f.db.transactionChanges=async statements=>{if(statements.some(s=>s.sql.includes('UPDATE library_resume_objects SET receipt='))){entered.resolve();await release.promise;}return original(statements);};
 const applying=phone.apply().catch(()=>null);await entered.promise;permission=false;cancel();await applying;expect(await f.db.query('SELECT revoked FROM library_resume_connections')).toEqual([{revoked:1}]);release.resolve();await running;
 expect(await f.db.query('SELECT id FROM articles')).toEqual([]);expect(await f.db.query('SELECT receipt FROM library_resume_objects WHERE receipt IS NOT NULL')).toEqual([]);
 }finally{release.resolve();await pair.close();await running;f.sql.close();}
},10000);

test('RVRESUMEC-IMPL-02 four post-APPLIED cleanup failures recover and fifth RSS commits',async()=>{
 const f=await fixture();try{let c=f.connect();await c.phone.prepare();const rss=vectors.objects.find(o=>o.kind==='rssSource')!;
 const objects=Array.from({length:5},(_,i)=>{const meta=JSON.parse(Buffer.from(rss.metadataBase64,'base64').toString());meta.url='https://resume.invalid/r2/'+i;const metadata=Buffer.from(JSON.stringify(meta)),{objectId:_id,...raw}=rss,d={...raw,businessId:meta.url,metadataBase64:metadata.toString('base64'),metadataSha256:hash(metadata)};return {...d,objectId:objectId(d as Omit<ObjectDescriptor,'objectId'>)} as ObjectDescriptor;}).sort((a,b)=>a.objectId.localeCompare(b.objectId));
 await manifest(c,objects);const release=f.chunks.release.bind(f.chunks);f.chunks.release=async()=>{throw Error('post-commit crash');};for(const o of objects.slice(0,4))expect((await c.phone.apply(o.objectId)).success).toBe(true);expect(f.native.objects.size).toBe(4);expect(await f.db.query('SELECT receipt FROM library_resume_objects WHERE receipt IS NOT NULL')).toHaveLength(4);await c.pair.close();await c.running;
 f.chunks.release=release;c=f.connect();await c.phone.prepare('resume');const p={...base,intent:'resume' as const,objectCount:5,objectsRoot:objectsRoot(objects.map(o=>o.objectId)),pageObjectCounts:[5]};c.phone.plan=planDigest(p);const begun=await c.phone.request('begin',p as unknown as Row);expect(begun.success).toBe(true);c.phone.epoch=begun.epoch!;expect(f.native.objects.size).toBe(0);
 expect((await c.phone.missing()).success).toBe(true);expect((await c.phone.apply(objects[0]!.objectId)).success).toBe(true);expect((await c.phone.apply(objects[4]!.objectId)).success).toBe(true);expect(f.native.objects.size).toBe(0);expect(await f.db.query('SELECT receipt FROM library_resume_objects WHERE receipt IS NOT NULL')).toHaveLength(5);expect(await f.db.query("SELECT url FROM channels WHERE url LIKE 'https://resume.invalid/r2/%'")).toHaveLength(5);await c.pair.close();await c.running;
 }finally{f.sql.close();}
});

test('RVRESUMEC-IMPL-03 cancellation binds digest/result for cancelled and COMPLETE jobs',async()=>{
 for(const complete of [false,true]){const f=await fixture();try{let c=f.connect();await c.phone.prepare();let p={...base};if(complete){p={...p,objectCount:0,objectsRoot:objectsRoot([]),pageObjectCounts:[]};c.phone.plan=planDigest(p);const b=await c.phone.request('begin',p as unknown as Row);c.phone.epoch=b.epoch!;const {receiptsRoot}=await import('../../src/sync/library-resume/digests');expect((await c.phone.request('complete',{objectCount:0,receiptsRoot:receiptsRoot([]),ackToInclusive:0})).success).toBe(true);await c.running;c=f.connect();await c.phone.prepare('resume');p={...p,intent:'resume'};c.phone.plan=planDigest(p);const b2=await c.phone.request('begin',p as unknown as Row);c.phone.epoch=b2.epoch!;
 }else await c.phone.begin();
 const id=nonce(),first=await c.phone.request('cancel',{reason:'USER_CANCEL'},{id});expect(first.success).toBe(true);expect(first.result?.alreadyComplete).toBe(complete);await c.running;
 expect(await f.db.query('SELECT result FROM library_resume_requests WHERE request_id=?',[id])).toEqual([{result:JSON.stringify(first.result)}]);
 c=f.connect();await c.phone.prepare('resume');c.phone.plan=planDigest(p);const begun=await c.phone.request('begin',{...p,intent:'resume'} as unknown as Row);expect(begun.success).toBe(true);c.phone.epoch=begun.epoch!;const changed=await c.phone.request('cancel',{reason:'LOCAL_ABORT'},{id});expect(changed.error?.code).toBe('REQUEST_CONFLICT');await c.running;
 }finally{f.sql.close();}}
});

test('RVRESUMEC-IMPL-04 journal selection and outstanding cross-scope reservations reject before begin',async()=>{
 const f=await fixture();try{await f.store.initialize();const p=clone(base);p.selection.limits={...p.selection.limits,maxJournalBytes:65536};p.selectionDigest=selectionDigest(p.selection);const id=nonce(),r={...vectors.requests.find(v=>v.name==='begin')!.frame,jobId:id,planDigest:planDigest(p)} as unknown as Envelope;
 await expect(f.store.begin('a'.repeat(64),r,p,nonce(),1,null)).rejects.toThrow('STORAGE_PRESSURE');expect(await f.db.query('SELECT * FROM library_resume_jobs')).toEqual([]);expect(await f.db.query('SELECT * FROM library_resume_objects')).toEqual([]);
 p.objectCount=1;p.pageObjectCounts=[1];p.selection.limits={...p.selection.limits,maxManifestBytes:40000,maxJournalBytes:16777216+85000};p.selectionDigest=selectionDigest(p.selection);const connection=nonce();await f.store.openConnection(connection);
 const j=await f.store.begin('a'.repeat(64),{...r,planDigest:planDigest(p)},p,connection,1,null);const second={...r,jobId:nonce()};await expect(f.store.begin('b'.repeat(64),second,p,connection,1,null)).rejects.toThrow('STORAGE_PRESSURE');expect(await f.db.query('SELECT * FROM library_resume_reservations')).toHaveLength(1);await f.store.cancel(j);expect(await f.db.query('SELECT * FROM library_resume_reservations')).toHaveLength(0);await f.store.begin('b'.repeat(64),second,p,connection,1,null);expect(await f.db.query('SELECT * FROM library_resume_jobs')).toHaveLength(2);
 }finally{f.sql.close();}
});

test('RVRESUMEC-IMPL-05 success schemas reject unknown keys and malformed fields in all eight phases',()=>{
 const receipt=vectors.receipts[0]!,done=vectors.completion;
 const rows:Record<Envelope['phase'],Row>={prepare:{step:'confirm',preparationDigest:'a'.repeat(64)},begin:{disposition:'RESUMED',selectionDigest:vectors.selectionDigest,state:'COMPLETE',expiresAtMillis:1000,nextManifestPage:1,completion:done},manifestPage:{pageIndex:0,pageDigest:vectors.pageDigest,nextManifestPage:1,manifestVerified:true,state:'READY'},missing:{state:'READY',nextManifestPage:1,expiresAtMillis:1000,items:[],next:null,done:true,completion:null},putChunk:{objectId:receipt.objectId,chunkIndex:0,chunkState:null,objectState:'APPLIED',receipt},apply:{state:'APPLIED',receipt},complete:done,cancel:{state:'CANCELLED',alreadyComplete:false}};
 expect(()=>successResult('begin',{...rows.begin,state:['READY'],completion:null})).toThrow();expect(()=>successResult('begin',{...rows.begin,disposition:['RESUMED']})).toThrow();for(const [phase,value]of Object.entries(rows)){expect(()=>successResult(phase as Envelope['phase'],value)).not.toThrow();expect(()=>successResult(phase as Envelope['phase'],{...value,unknown:true})).toThrow();const bad=clone(value);if(phase==='prepare')bad.preparationDigest='bad';else if(phase==='begin')bad.expiresAtMillis='1000';else if(phase==='manifestPage')bad.manifestVerified=1;else if(phase==='missing')bad.done=1;else if(phase==='putChunk')bad.chunkIndex='0';else if(phase==='apply')(bad.receipt as Row).applyRequestId='bad';else if(phase==='complete')bad.receiptsRoot='bad';else bad.alreadyComplete='false';expect(()=>successResult(phase as Envelope['phase'],bad)).toThrow();}
});

test('RVRESUMEC-IMPL-05 malformed or uncorrelated successful begin never saves peer ACK',async()=>{
 for(const corrupt of ['root','extra','selection','count','page']){const f=await fixture();try{const c=f.connect(),job=nonce();await c.phone.prepare('create',[{direction:'watchToPhone',jobId:job,intent:'create',selection:vectors.selection as Selection}]);const r=envelope(await c.pair.phone.readFrame(10000));expect(r.phase).toBe('begin');const p=r.payload as unknown as BeginPayload,done=completion(job,r.planDigest!,p.objectCount,corrupt==='root'?'not-a-sha256':'0'.repeat(64),0),result:Row={disposition:'RESUMED',selectionDigest:p.selectionDigest,state:'COMPLETE',expiresAtMillis:10000,nextManifestPage:0,completion:done};if(corrupt==='extra')result.extra=true;if(corrupt==='selection')result.selectionDigest='f'.repeat(64);if(corrupt==='count')(result.completion as Row).objectCount=1;if(corrupt==='page')result.nextManifestPage=p.pageObjectCounts.length+1;
 const {payload,...head}=r;await c.pair.phone.writeFrame({...head,type:'response',epoch:1,success:true,result} as unknown as Row);await c.running;expect(c.errors.length).toBe(1);expect(await f.db.query('SELECT * FROM library_resume_peer_ack')).toEqual([]);expect((await f.store.job(c.server.scope,job))?.state).not.toBe('COMPLETE');
 }finally{f.sql.close();}}
});

test('RVRESUMEC-IMPL-07 sync and async decoder retain actual whitespace bytes; v14 limit unchanged',async()=>{
 const r=vectors.requests[0]!.frame as unknown as Row,raw=rawFrame(r,300000),sync=decodeFrame(raw),async=await decodeFrameAsync(raw);expect(frameBytes(sync)).toBe(raw.length-4);expect(frameBytes(async)).toBe(raw.length-4);expect(frameBytes(sync)).toBeGreaterThan(262144);const legacy=decodeFrame(rawFrame({action:'syncLibrary',version:14},300000));expect(legacy.action).toBe('syncLibrary');
});

test('RVRESUMEC-IMPL-07 raw hard, selected-frame and manifest-page limits reject whitespace expansion',async()=>{
 for(const mode of ['hard','selected','page']){const f=await fixture();try{if(mode==='selected')f.cap.limits={...f.cap.limits,maxFrameBytes:100000};if(mode==='page')f.cap.limits={...f.cap.limits,maxManifestPageBytes:4000};
 const c=f.connect({receive:r=>r.phase===(mode==='hard'?'prepare':mode==='page'?'manifestPage':'missing')?decodeFrame(rawFrame(r,mode==='hard'?300000:mode==='selected'?110000:5000)):r});
 if(mode==='hard'){const offered=await c.phone.request('prepare',vectors.requests[0]!.frame.payload as unknown as Row);expect(offered.error?.code).toBe('LIMIT_EXCEEDED');}else{const selection=clone(vectors.selection as Selection);selection.limits={...f.cap.limits};await c.phone.prepare('create',[{direction:'phoneToWatch',jobId:c.phone.jobId,intent:'create',selection}]);const p={...base,selection,selectionDigest:selectionDigest(selection)};c.phone.plan=planDigest(p);const begun=await c.phone.request('begin',p as unknown as Row);expect(begun.success).toBe(true);c.phone.epoch=begun.epoch!;const entries=vectors.objects as ObjectDescriptor[];const m=await c.phone.request('manifestPage',{pageIndex:0,startIndex:0,previousPageDigest:'0'.repeat(64),pageDigest:pageDigest(c.phone.plan,0,0,entries,'0'.repeat(64)),entries});if(mode==='page'){expect(m.error?.code).toBe('PLAN_CONFLICT');expect(await f.db.query('SELECT * FROM library_resume_objects')).toEqual([]);}else{expect(m.success).toBe(true);expect((await c.phone.missing()).error?.code).toBe('LIMIT_EXCEEDED');}}
 await c.running;
 }finally{f.sql.close();}}
});
