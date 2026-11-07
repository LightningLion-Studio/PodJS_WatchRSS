/** P5 watch product actions on an owned Android emulator and loopback backend.
 * The fixture is injected at runtime. No credential appears in a bundle. */
import {ResourceQuota} from '@podjs/framework/resource-journal';
import {ContentFiles} from '@podjs/framework/content-files';
import {createSyncV2Crypto,unhex,hex,sha256Hex,hmacSha256Bytes} from '@podjs/framework/crypto';
import {encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import {canonical,jsonBytes,digest,entityKey,exact,compareD64} from '../../../src/sync-v2/protocol';
import {SyncV2Http,parseNetwork} from '../../../src/sync-v2/http';
import {WatchServiceKeyPin} from '../../../src/sync-v2/service-key';
import {WatchSigningKeys} from '../../../src/sync-v2/signing-keys';
import {WatchProjectionStore} from '../../../src/sync-v2/store';
import {ProjectionGate} from '../../../src/sync-v2/gate';
import {localProjectionCipher,projectionSql} from '../../../src/sync-v2/host';
import {WatchCloudIndex} from '../../../src/sync-v2/cloud-index';
import {WatchIndexPublisher} from '../../../src/sync-v2/publisher';
import {WatchAccountControl} from '../../../src/sync-v2/account-control';
import {WatchAccountBusinessSql} from '../../../src/sync-v2/account-business';
import {WatchSpaceStore} from '../../../src/sync-v2/space-store';
import {WatchRecovery} from '../../../src/sync-v2/recovery';
import {accountBodyVerifier} from '../../../src/sync-v2/account-body';
import {fromWire} from '../../../src/sync-v2/business';
import {SqlBusinessSource} from '../../../src/sync-v2/source';
import {watchMaterializer} from '../../../src/sync-v2/materializer';
import {initializeSchema} from '../../../src/core/schema';
import {initializeMemoSchema} from '../../../src/notes/repository';
import {BOOK_SCHEMA} from '../../../src/books/schema';
import {validateTrust,attest,commit} from '../../../src/cloud/v2';
const check=(v:unknown,code:string)=>{if(!v)throw Error(code);};
(globalThis as any).backgroundHandler=async(ctx:any)=>{
 const f=ctx.payload,origin=f.baseUrl;let lastResponse:any=null;let phase='bootstrap',serverNow:number|null=null,lastMonotonic=0,requests=0,bodyReads=0;const calls:Record<string,number>={};
 const host:any=(method:string,args:any)=>{calls[method]=(calls[method]??0)+1;return ctx.request('cloud.host',{method,args});},mark=(stage:string,details:any={})=>host('result',{phase:stage,...details}),now=()=>serverNow===null?null:serverNow+Math.max(0,Date.now()-lastMonotonic);
 try{
 check(f.syntheticOnly===true&&f.platform==='watch'&&/^http:\/\/127\.0\.0\.1:18972$/.test(origin),'isolated_fixture_required');
 const crypto=createSyncV2Crypto(host),keys={id:unhex(f.crypto.idKeyHex),content:unhex(f.crypto.contentKeyHex),version:f.crypto.wrappingKeyVersion},db=projectionSql(host),sql={...db,execute:(sql:string,params:any[]=[])=>db.transaction([{sql,params}])};
 const transport={async request(r:any){requests++;if(decodeURIComponent(r.url).includes('/objects/blob:'))bodyReads++;const out=await host('http',{...r,body:r.body?encodeBase64(r.body):null});const body=decodeBase64(out.body);if(!r.url.includes('/objects/')){const v=parseNetwork(body);lastResponse={route:r.url.split('/sync/v2').at(-1)?.split('?')[0].replace(/\/requests\/[a-f0-9]+/,'/requests/:id').replace(/\/(state-refs|recipe-refs)\/.+/,'/$1/:oid'),keys:Object.keys(v),leaseIdLength:typeof v.leaseId==='string'?v.leaseId.length:null,leaseIdH32:typeof v.leaseId==='string'?/^[a-f0-9]{32}$/.test(v.leaseId):null};}return {...out,body};}};
 const bootstrap=async()=>{const r=await transport.request({method:'POST',url:origin+'/functions/v1/cloud/bootstrap',headers:f.headers,body:jsonBytes({})});check(r.status===200,'bootstrap_http');const b=parseNetwork(r.body);validateTrust(b);const lc={sha256:async(b:Uint8Array)=>sha256Hex(b),hmac:async(k:Uint8Array,b:Uint8Array)=>hex(hmacSha256Bytes(k,b))},c=b.keyCommitments.find((x:any)=>x.keyVersion===keys.version);check(c&&await commit(lc,keys.content,f.userId,b.libraryEpoch,keys.version)===c.commitment,'legacy_commitment');for(const d of b.devices)if(d.revokedAt===null)check(await attest(lc,keys.content,f.userId,b.libraryEpoch,d.deviceId,d.publicKeySpki)===d.attestation,'legacy_attestation');return {accountId:f.accountId,syncV2:b.syncV2,devices:b.devices};};
 const pin=new WatchServiceKeyPin({get:key=>host('secure.get',{key}),compareAndSet:async(key,expected,value)=>(await host('secure.compareAndSet',{key,expected,value})).updated},f.accountId,bootstrap),http=new SyncV2Http(transport,origin,f.scope,async()=>({accessToken:f.auth.accessToken,legacyDeviceId:f.legacyDeviceId,userId:f.userId,scope:f.scope}),true,pin,true,false,true,true),authors=new WatchSigningKeys(http,crypto,keys.id,async()=>(await bootstrap()).devices);
 await http.capabilities();const time=await http.json('GET','/checkpoint');await pin.checkpoint(crypto,{body:time.body,signature:time.signature},f.scope,Date.now());serverNow=time.body.issuedAtMillis;lastMonotonic=Date.now();
 await initializeSchema(sql);await initializeMemoSchema(sql);await db.transaction(BOOK_SCHEMA.map(sql=>({sql})));
 const store=new WatchProjectionStore(db,localProjectionCipher(host,'p5-live-projection:'+f.runId),new ProjectionGate(true),f.scope,'5b'.repeat(16),keys.id),cache=new WatchSpaceStore(db,localProjectionCipher(host,'p5-live-cache:'+f.runId),new ContentFiles(host),digest(['p5',f.runId]));await cache.init();
 const reserve=async(bytes:number)=>{const stat=await host('file.stat',{path:cache.binding});return new ResourceQuota(db,cache.binding).reserve(hex(await crypto.random(16)),bytes,Math.max(0,stat.usableBytes-1048576));},business=new WatchAccountBusinessSql(db,store,f.scope,keys.id,{recoveryValue:async id=>{const c=await store.readCandidate(id);check(c.meta.kind==='note'&&!/assets\//.test(c.state.payload.markdown),'local_body_closure_unavailable');return {kind:c.meta.kind,value:fromWire(c.meta.kind,c.meta.payload,c.state.payload),bodyRefs:[]};}},accountBodyVerifier(http,crypto,keys,async id=>authors.get(id)),reserve);await business.initialize();await store.initialize();
 const authorKey=digest([f.scope,f.deviceId,f.signingKey.publicKeyBase64Url]),watermark=f.resumeWatermark;if(watermark){check(watermark.author===authorKey,'watermark_scope');const state=await store.readState();await store.controlUpdate(state,{...state,cloud:{...state.cloud,deviceSequence:watermark.sequence}});}const update=store.controlUpdate.bind(store);store.controlUpdate=async(before,next,statements,hook)=>{await update(before,next,statements,hook);if(next.cloud?.deviceSequence&&compareD64(next.cloud.deviceSequence,before.cloud?.deviceSequence??'0')>0)await host('author.reserve',{author:authorKey,sequence:next.cloud.deviceSequence});};
 const reader=new WatchCloudIndex(store,http,crypto,keys,async id=>authors.get(id),async w=>{const cp=await http.json('GET','/checkpoint');const b=await pin.checkpoint(crypto,{body:cp.body,signature:cp.signature},f.scope,now()!);check(canonical(b.account)===canonical(w.account),'ref_conflict');},()=>now()!),publisher=new WatchIndexPublisher(store,http,crypto,keys,()=>now()!),recovery=new WatchRecovery(store,cache,{cipher:localProjectionCipher(host,'p5-recovery:'+f.runId),randomId:async()=>hex(await crypto.random(16)),trustedNow:now,source:async refs=>{check(refs.length===0,'local_body_closure_unavailable');return [];},reserve});
 const pull=async()=>{const w=await http.negotiate([],['note-conflicts.v1']);await authors.refresh(w.windowId);await reader.pull(w);return w;},control=new WatchAccountControl({store,http,reader,publisher,crypto,approved:async id=>authors.get(id),business,recovery,trustedNow:now,historyRestore:true,choiceApply:true,author:async()=>{const w=await http.negotiate([],[]);await authors.refresh(w.windowId);const own=w.refs.find((r:any)=>r.deviceId===f.deviceId);return {deviceId:f.deviceId,alias:'fixture',own:{commitOid:own?.commitOid??null,revision:own?.refRevision??'0'}};}});
 phase='follow';const window=await pull();const followed=await control.follow(window);await mark('follow',{authenticatedCurrent:true,nativeAtomicApply:followed.applied===true,initialGeneration:(await store.readState()).rollbackGeneration});
 // A same-tree normal commit makes the exact observed current snapshot a
 // history target. CAS prevents a concurrent peer update from being overwritten.
 let own=window.refs.find((r:any)=>r.deviceId===f.deviceId);await store.beginScan({schema:'p5-live',descriptorPin:'fixed-fixture',accountScope:f.accountId,capability:'p5'});const source=await SqlBusinessSource.open(db,watchMaterializer(db,{cloudRestoreMetadata:async()=>{throw Error('body_materialization_unavailable');}} as any));
 for(;;){const cp=await store.scanPage(source);if(cp.phase==='complete')break;if(cp.phase==='tail'){for(;;)if((await store.catchUpPage(source)).phase==='complete')break;break;}}
 phase='same-tree-publication';let initial=await store.readState();const baselineRows=await store.candidatePage();check(!initial.hasUnsentEdits&&!initial.pendingChoice,'clean_baseline_required');
 // No candidate is changed. All current rows and ciphertext remain unchanged.
 if(!initial.account){await publisher.prepare(f.deviceId,'fixture',{commitOid:own?.commitOid??null,revision:own?.refRevision??'0'},hex(await crypto.random(16)));await mark('author-reserved',{deviceSequence:(await store.readState()).cloud.deviceSequence});await publisher.flush();const first=await pull();await control.follow(first);initial=await store.readState();own=first.refs.find((r:any)=>r.deviceId===f.deviceId);}
 const requestId=hex(await crypto.random(16));await publisher.prepare(f.deviceId,'fixture',{commitOid:own?.commitOid??null,revision:own?.refRevision??'0'},requestId);await mark('author-reserved',{deviceSequence:(await store.readState()).cloud.deviceSequence});const published=await publisher.flush();const after=await pull();check(after.account.commitOid===published.account.commitOid,'concurrent_account_change');
 const current=await store.readState();check(current.cloud.current.treeRoot===initial.cloud.current.treeRoot,'same_tree_required');
 phase='rollback';const capture=await control.captureAccount();await control.rollback(initial.account!.oid,capture,hex(await crypto.random(16)));const rolled=await store.readStableState();check(rolled.rollbackGeneration!==initial.rollbackGeneration&&rolled.cloud.current.treeRoot===initial.cloud.current.treeRoot,'rollback_result');await mark('rollback',{newCommit:true,sameAuthenticatedTree:true,atomicNativeApply:true,generationAdvanced:true});
 phase='cloud-choice';const noteId='p5-local-'+f.runId,hash=sha256Hex(jsonBytes('local'));await sql.execute('INSERT INTO memo_notes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[noteId,null,'P5 local draft','local','local',hash,'base','base',0,now(),now(),'watch',0,0]);
 // The edit is explicitly based on the older authenticated generation; this
 // simulates an offline editor returning after the real account rollback.
 const dirty=await store.readState();await store.controlUpdate(dirty,{...dirty,editBase:{accountOid:initial.account!.oid,generation:initial.rollbackGeneration},pendingChoice:{generation:rolled.rollbackGeneration,inboxKeys:[]}});
 await store.beginTailWindow();for(;;)if((await store.catchUpPage(source)).phase==='complete')break;
 const p=await control.pendingChoice();check(p,'pending_choice_required');await control.chooseCloud(p!.proof,hex(await crypto.random(16)));check(!(await db.query('SELECT 1 FROM memo_notes WHERE note_id=?',[noteId])).length,'cloud_draft_retained');const copies=await control.recoveryCopies();check(copies.length===1,'recovery_copy');await control.restoreRecovery(copies[0]!.copyId);check((await db.query('SELECT 1 FROM memo_notes WHERE note_id=?',[noteId])).length===1,'restore_edit');
 await mark('cloud-choice',{contentCommitCreated:false,encryptedRecovery:true,explicitRestoreCreatesEdits:true,copyCount:copies.length});
 // Exercise both signed resolution commits against the real backend. Each
 // offline editor carries the exact earlier authenticated basis in this fixture.
 const scan=async()=>{if((await store.checkpoint())?.phase==='complete')await store.beginTailWindow();for(;;){const c=await store.checkpoint();if(c!.phase==='complete')break;if(c!.phase==='tail')await store.catchUpPage(source);else await store.scanPage(source);}};
 const normal=async()=>{await scan();const w=await http.negotiate([],[]),own=w.refs.find((r:any)=>r.deviceId===f.deviceId);await publisher.prepare(f.deviceId,'fixture',{commitOid:own?.commitOid??null,revision:own?.refRevision??'0'},hex(await crypto.random(16)));await publisher.flush();await control.follow(await pull());};
 await normal();
 for(const mode of ['local','merge']){
  phase=mode+'-choice';const baseline=await store.readState(),entity=entityKey(keys.id,f.scope.repoId,'note',noteId),basis=await store.readCandidate(entity),base={identity:basis.meta.logicalId,...basis.meta.payload,...basis.state.payload};
  await normal();await control.rollback(baseline.account!.oid,await control.captureAccount(),hex(await crypto.random(16)));
  if(mode==='local')await sql.execute('UPDATE memo_notes SET title=?,updated_at=updated_at+1 WHERE note_id=?',['retained local choice',noteId]);
  else await sql.execute('UPDATE memo_notes SET markdown=?,plain_text=?,updated_at=updated_at+1 WHERE note_id=?',['merged offline text','merged offline text',noteId]);
  await scan();const dirty=await store.readState();await store.controlUpdate(dirty,{...dirty,editBase:{accountOid:baseline.account!.oid,generation:baseline.rollbackGeneration},pendingChoice:{generation:dirty.rollbackGeneration,inboxKeys:[]},cloud:{...dirty.cloud,editBases:{[entity]:base},editCreates:[]}});
  const choice=(await control.pendingChoice())!;check(choice,'pending_choice_required');if(mode==='local')await control.chooseLocal(choice.proof,hex(await crypto.random(16)));else {check(choice.canMerge,'merge_preflight_failed');await control.chooseMerge(choice.proof,hex(await crypto.random(16)));}
  const selected=await store.readStableState(),doc=parseNetwork(await http.object(selected.account!.oid));check(doc.body.operation.kind==='resolve-'+mode,'resolution_commit_required');check(!selected.pendingChoice&&!selected.hasUnsentEdits,'resolution_apply_required');const note=(await db.query('SELECT title,markdown FROM memo_notes WHERE note_id=?',[noteId]))[0];check(mode==='local'?note.title==='retained local choice':note.markdown==='merged offline text','native_resolution_required');
  await mark(mode+'-choice',{signedCommit:doc.body.operation.kind,nativeAtomicApply:true,canMerge:choice.canMerge,offlineBasisFixture:true});
 }
 await mark('complete',{realBackend:18972,emulator:true,requests,bodyReads,hostCalls:calls,noProduction:true});return 'success';
 }catch(error){await mark('failed',{at:phase,code:String((error as Error).message??error).slice(0,80),lastResponse,stack:String((error as Error).stack??'').split('\n').slice(0,5).join('\n')});throw Error('p5_integration_failed');}
};
