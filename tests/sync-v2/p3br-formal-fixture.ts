import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {engine,ContentBackend,keys} from './p3-fixture';
import {cipher,scope,binding,noteValue,vector} from './fixture';
import {entityKey,canonical,digest} from '../../src/sync-v2/protocol';
import {WatchBusinessClosure} from '../../src/sync-v2/business-closure';
import {contentBodyResolver} from '../../src/sync-v2/content-business';
import {candidates} from '../../src/sync-v2/business';
export async function setup(mutate?:(records:any[])=>void){const root=mkdtempSync(join(tmpdir(),'p3b-closure-')),backend=new ContentBackend(),f=engine(root,backend,new Uint8Array(262147).fill(21)),projection=f.db.store();await f.store.init();await projection.initialize();const book=structuredClone(vector('book-merge').cases[0].expected),records:any[]=[{kind:'article',logicalId:'rss',value:{articleId:'rss',url:'https://synthetic.invalid/rss',title:'rss'}},{kind:'article',logicalId:'import',value:{articleId:'import',url:'https://synthetic.invalid/import',title:'import'}},{kind:'book',logicalId:book.bookId,value:book},...['current.png','base.png','conflict.png'].map(assetId=>({kind:'asset',logicalId:assetId,value:{assetId,mime:'image/png',originalFilename:assetId,updatedAt:1,sourceDeviceId:'watch',deleted:false,deletedAt:0}})),{kind:'note',logicalId:'note',value:{...noteValue('note'),markdown:'![a](assets/current.png)',baseMarkdown:'<img src="assets/base.png">',noteConflicts:{version:1,records:[{conflictId:'c',noteId:'note',baseMarkdown:'![c](assets/conflict.png)',localMarkdown:'',remoteMarkdown:'',remoteDeviceId:'watch',createdAt:1,resolvedAt:2}]}}}].map(r=>({...r,addedAtMillis:1,id:entityKey(keys.id,scope.repoId,r.kind,r.logicalId)}));mutate?.(records);await projection.beginScan(binding);await projection.scanPage({page:async()=>({rows:records,after:'done',done:true}),changed:async()=>[]});
 const resolver=contentBodyResolver(f.e,async entry=>({bodyRevision:digest(entry.entityKey).slice(0,32),sourceBinding:'source-'+entry.entityKey,importedFile:entry.candidate.meta.logicalId==='import'||entry.candidate.meta.kind==='book'}));
 for(const r of records)if(r.kind!=='note')await resolver({entityKey:r.id,candidate:candidates(r.kind,r.logicalId,r.id,r.value,1)},null);
 await f.e.runWindow();const closures=new WatchBusinessClosure(projection,f.e);
 return {root,f,backend,projection,records,closures,close(){f.db.close();rmSync(root,{recursive:true,force:true});}};
}

/** Review fixture: a formal closure, a retired original source, and a durable edit. */
export async function restoredSetup(logicalId='rss'){
 const {WatchSpaceStore}=await import('../../src/sync-v2/space-store'),{WatchRecovery}=await import('../../src/sync-v2/recovery'),{captureChoice}=await import('../../src/sync-v2/state');
 const {recoveryCipher,accountOid,now}=await import('./p3b-fixture'),{SqlFixture}=await import('./fixture');
 const s=await setup(records=>{const required=new Set(logicalId==='note'?['note','current.png','base.png','conflict.png']:[logicalId]);records.splice(0,records.length,...records.filter(r=>required.has(r.logicalId)));}),record=s.records.find(r=>r.logicalId===logicalId),value=await s.closures.recoveryValue(record.id);
 let db=s.f.db,projection=s.projection,cache=new WatchSpaceStore(db,cipher,s.f.store.files,s.f.store.prefix),time=now;
 await cache.init();let state=await projection.readState();await projection.controlUpdate(state,{...state,account:{oid:accountOid,revision:'1',generation:'0'},lastSeenAccountOid:accountOid,lastSeenAccountRevision:'1',hasUnsentEdits:true,pendingChoice:{generation:'0',inboxKeys:[]}});
 const rows:any[]=[];for(const r of s.records){const c=(await projection.readCandidate(r.id))!,b=r.kind==='note'?null:await s.f.e.businessBinding(r.id),manifest=b?await s.f.e.manifest(r.id,b.bodyRevision):null;rows.push({row:{entityKey:r.id,bodyRevision:manifest?.bodyRevision??null,recipeOid:manifest?.recipeOid??null,opaqueContentId:manifest?.opaqueContentId??null,contentBytes:manifest?.contentBytes??null,deleted:false},meta:c.meta,state:c.state});}
 const makeRecovery=()=>new WatchRecovery(projection,cache,{cipher:recoveryCipher,randomId:async()=> 'a'.repeat(32),trustedNow:()=>time,source:(refs,changes)=>s.closures.source(refs,changes),reserve:async()=>async()=>{},acknowledge:(delta,read)=>new WatchBusinessClosure(projection,s.f.e).acknowledgeRecovery(delta,read,()=>time)});
 let recovery=makeRecovery();state=await projection.readState();const copy=(await recovery.applyCloud({capture:captureChoice(state,state.account!),local:{[record.id]:value},cloud:{},explicitCloudChoice:true,next:{...state,pendingChoice:null,hasUnsentEdits:false,activeGeneration:'cloud'},statements:[]}))!;
 const resources=await cache.journal.resourcePage('recovery:'+copy.copyId);
 // Retire only this temporary fixture's own source, after authenticating it.
 for(const r of s.records.filter(r=>r.kind!=='note')){const b=await s.f.e.businessBinding(r.id),key=digest([r.id,b.bodyRevision]),plan=(await s.f.store.get('body:'+key))!.value;for(const path of [s.f.store.path(plan.recipeObject.cache),...plan.recipe.blocks.map((_:any,index:number)=>s.f.store.path('prepared:'+key+':'+index))])writeFileSync(s.f.host.path(path),new Uint8Array());}
 s.f.e.options.source=async()=>{throw Error('source_retired_after_cloud_choice');};
 const remote=s.f.e.remote,original=remote.availability.bind(remote);let receiptMode='fresh';remote.availability=async expected=>{const response=await original(expected),body={...response.receipt.body,createdAtMillis:time-1,expiresAtMillis:receiptMode==='expired'?time:time+1000},receipt=await s.backend.signed('availability-sign',body);if(receiptMode==='tampered')receipt.signature='A'.repeat(86);return {...response,receipt};};
 return {...s,copy,record,value,resources,rows,get projection(){return projection;},get cache(){return cache;},get recovery(){return recovery;},get time(){return time;},set time(v:number){time=v;},get receiptMode(){return receiptMode;},set receiptMode(v:string){receiptMode=v;},
  async restore(){return recovery.restoreAsEdits(copy.copyId,async delta=>[{sql:'CREATE TABLE IF NOT EXISTS pending_body_edit(entity TEXT,value TEXT,body_refs TEXT)'},{sql:'INSERT INTO pending_body_edit VALUES(?,?,?)',params:[record.id,canonical(delta.changes),canonical(delta.bodyRefs)]}]);},
  async installCurrent(mutate?:(rows:any[])=>void){const cloud=structuredClone(rows);mutate?.(cloud);const before=await projection.stageCloudRows('tree:sha256:'+'9'.repeat(64),cloud,await projection.readState());await projection.controlUpdate(before,{...before,hasUnsentEdits:false,acknowledgedLocalChangeRevision:before.localChangeRevision,cloud:{...before.cloud,current:{commitOid:accountOid,treeRoot:'tree:sha256:'+'9'.repeat(64)}}});},
  async reopen(){db.close();db=new SqlFixture(join(s.root,'projection.sqlite'));projection=db.store();cache=new WatchSpaceStore(db,cipher,s.f.store.files,s.f.store.prefix);await cache.init();recovery=makeRecovery();},
  close(){db.close();rmSync(s.root,{recursive:true,force:true});},
 };
}
