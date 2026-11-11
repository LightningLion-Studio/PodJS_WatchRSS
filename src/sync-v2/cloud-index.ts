import {canonical,jsonBytes,parseCanonicalJson,digest,bytes,hexId,oid,exact,checkD64,compareD64,nextD64,uint,entityKey,validateScope,type Scope} from './protocol';
import {sameScope,features,b64,unb64,indexRow} from './wire';
import {authenticatePath,type ApprovedKey,type Pins} from './head-pins';
import {openV2,objectOid,type EnvelopeCrypto,sealV2} from './sealed';
import {signCommit,signControl,verifySigned,type SigningPort} from './signing';
import {readTree,buildTree} from './merkle';
import {readConflicts,conflictNeutral,noteEditDigest} from './notes-conflict';
import {fromWire} from './business';
import {observeAccount,queuedReadOnly,type SyncState} from './state';
import {PAGE_BYTES,ObservationReadOnly,type WatchProjectionStore} from './store';
import {SyncV2Http,SyncV2Error} from './http';
import {NOTE_SEGMENTS_FEATURE,NOTE_TEXT_BUDGET,measureNote,readSegmentedNote,splitOrdinary,type ClosurePorts} from './note-segments';
import {storedSegments} from './publisher';
import type {Statement} from '@podjs/framework/sql-projection';
import {hex,sha256Hex} from '@podjs/framework/crypto';
import {noteUpsert} from './note-rows';
const missing=(error:unknown)=>error instanceof SyncV2Error&&error.code==='object_missing';
/** 25.5 closure ports over the authenticated window. Missing objects/tables are
 * null (closure_incomplete is decided by the caller's order). Malformed
 * mappings and tables are invalid_schema, never a host TypeError. */
export function noteClosurePorts(http:Pick<SyncV2Http,'scope'|'stateRefs'>,read:(id:string)=>Promise<Uint8Array>,crypto:EnvelopeCrypto&SigningPort,keys:import('./sealed').ObjectKeys,approved:(deviceId:string)=>Promise<ApprovedKey>,windowId:string):ClosurePorts{
 const scope=http.scope;
 return {
  async object(id){try{return await read(id);}catch(error){if(missing(error))return null;throw error;}},
  async refs(stateOid){let mapping:any;try{mapping=await http.stateRefs(windowId,stateOid);}catch(error){if(missing(error))return null;throw error;}
   const id=mapping?.refsOid;if(typeof id!=='string'||!/^state-refs:sha256:[a-f0-9]{64}$/.test(id))return {mapping,raw:new Uint8Array(0)};
   try{return {mapping,raw:await read(id)};}catch(error){if(missing(error))return {mapping,raw:null};throw error;}},
  async open(id,raw){const opened=await openV2(crypto,keys.id,keys.readContentKey??keys.content,scope,id,raw);if(opened.header.type!=='state')throw Error('invalid_schema');if(!keys.readContentKey&&opened.header.keyVersion!==keys.version)throw Error('unsupported_feature');return opened.value;},
  async verifyRefs(stateOid,read){
   const m=read.mapping;try{exact(m,['version','scope','parentOid','refsOid','authorDeviceId','keyId','totalBytes']);validateScope(m.scope);}catch{throw Error('invalid_schema');}sameScope(m.scope,scope);
   try{if(m.version!==2||m.parentOid!==stateOid)throw Error();oid(m.refsOid,'state-refs');hexId(m.authorDeviceId,32);hexId(m.keyId,32);if(uint(m.totalBytes,262144)===0)throw Error();}catch{throw Error('invalid_schema');}
   const refs=parseCanonicalJson(read.raw!);try{exact(refs,['body','signature']);exact(refs.body,['scope','stateOid','segmentOids']);validateScope(refs.body.scope);}catch{throw Error('invalid_schema');}sameScope(refs.body.scope,scope);
   const b=refs.body;try{if(b.stateOid!==stateOid||!Array.isArray(b.segmentOids)||b.segmentOids.length>2048)throw Error();for(const id of b.segmentOids)oid(id,'state');}catch{throw Error('invalid_schema');}
   const signer=await approved(m.authorDeviceId);if(signer.keyId!==m.keyId)throw Error('signature_invalid');await verifySigned(crypto,signer.publicKey,'wrss.sync.v2/state-refs-sign',b,refs.signature);return b.segmentOids;
  },
 };
}
/** Per-row metadata kept across a streamed pull; never text or ciphertext. */
interface ObservedRow {entityKey:string;note:boolean;noteId:string;deleted:boolean;noteRevision:string|null;unopenable:string|null}
/** F1 local status: notes this device cannot open (keyed by noteId). The row is
 * retained and republished unchanged; the local note keeps its prior version. */
export type UnopenableNotes=Record<string,{entityKey:string;code:string;deleted:boolean}>;
const unopenableNotes=(seen:readonly ObservedRow[]):UnopenableNotes=>Object.fromEntries(seen.filter(r=>r.unopenable).map(r=>[r.noteId,{entityKey:r.entityKey,code:r.unopenable!,deleted:r.deleted}]));
export interface CloudIndexOptions {noteSegments?:boolean;noteTextBudget?:number}
export type CloudPullResult={empty:boolean;readOnly?:boolean;rows?:number;awaitingUser?:boolean;bodyReads?:number;checkpointHit?:boolean;rebuildRequired?:boolean;rebuilt?:boolean};
export const placeholder=(row:any)=>row.bodyRevision===null?'no-body':row.recipeOid===null?'source-pending':'body-not-downloaded';
export const placeholderText=(row:any)=>row.bodyRevision===null?null:row.recipeOid===null?'正文尚未就绪':'正文尚未下载';
const copy=<T>(v:T):T=>JSON.parse(canonical(v));
const uuid=(b:Uint8Array)=>{const h=hex(Uint8Array.from(b,(v,i)=>i===6?(v&0x0f)|0x40:i===8?(v&0x3f)|0x80:v));return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
/** N1: noteId of a keep-both copy, derived from device key, scope, entity and
 * quarantine baseline digest. A crash re-run recreates the same one note. */
const copyNoteId=(scope:Scope,key:Uint8Array,entity:string,baseline:string)=>uuid(Uint8Array.from(sha256Hex(bytes(canonical({domain:'wrss.sync.v2/quarantine-copy',scope,key:hex(key),entityKey:entity,baseline}))).match(/../g)!.slice(0,16).map(x=>parseInt(x,16))));
/** P2 index coordinator. No body export, worker, history restore or local framing. */
export class WatchCloudIndex {
 constructor(private readonly store:WatchProjectionStore,private readonly http:SyncV2Http,private readonly crypto:EnvelopeCrypto&SigningPort,private readonly keys:import('./sealed').ObjectKeys,private readonly approved:(deviceId:string)=>Promise<ApprovedKey>,private readonly bootstrap:(window:any)=>Promise<void>,private readonly now:()=>number=Date.now,private readonly rebuild?:()=>Promise<void>,private readonly options:CloudIndexOptions={}){}
 private get supported(){return this.options.noteSegments===true?['note-conflicts.v1',NOTE_SEGMENTS_FEATURE]:['note-conflicts.v1'];}
 private get scope(){return this.http.scope;}
 private current(state:SyncState){return {pins:{accountOid:null,authors:{},seenOids:[]},headers:{},cursor:'0',current:null,deviceSequence:'0',pendingPublish:null,...state.cloud};}
 async pull(window:any,readOnly=false):Promise<CloudPullResult>{
  try{return await this.pullOnce(window,readOnly);}catch(error){if(error instanceof ObservationReadOnly)return this.pullOnce(window,true);throw error;}
 }
 private async pullOnce(window:any,readOnly:boolean):Promise<CloudPullResult>{
  if((await this.store.readStableState()).cloud?.witnessConflict)throw Error('ref_continuity_unavailable');
  const capabilities=await this.http.capabilities();sameScope(window.scope,this.scope);if(window.version!==2)throw Error('upgrade_required');exact(window.account,['commitOid','revision','rollbackGeneration']);const a=window.account;checkD64(a.revision);checkD64(a.rollbackGeneration);checkD64(window.serverRevision);checkD64(window.historyFloorRevision);hexId(window.windowId,32);uint(window.expiresAtMillis);if(this.now()>window.expiresAtMillis)throw Error('window_expired');if(compareD64(window.historyFloorRevision,window.serverRevision)>0)throw Error('invalid_schema');
  const before=await this.store.readState();readOnly ||= queuedReadOnly(before)||!!before.cloud?.pendingPublish?.explicit&&before.cloud.pendingPublish.kind==='rollback'&&!this.http.historyRestoreOpen();const saved=this.current(before),auditBinding=digest({scope:this.scope,keyVersion:this.keys.version,features:capabilities.features,schema:'v2-rc6c-business-2'});if(compareD64(window.serverRevision,saved.cursor)<0)throw Error('replay_detected');if(compareD64(a.rollbackGeneration,before.rollbackGeneration)<0||compareD64(a.revision,before.lastSeenAccountRevision)<0)throw Error('replay_detected');
  const historyGap=compareD64(saved.cursor,window.historyFloorRevision)<0;
  if(a.commitOid===null){if(a.revision!=='0'||a.rollbackGeneration!=='0'||saved.pins.accountOid!==null)throw Error('replay_detected');return {empty:true};}
  oid(a.commitOid,'commit');if(a.revision==='0')throw Error('invalid_schema');if(saved.pins.accountOid===null)await this.bootstrap(window);
  if(saved.current?.commitOid===a.commitOid){
   if(a.revision!==before.account?.revision||a.rollbackGeneration!==before.account?.generation)throw Error('replay_detected');
   if(saved.auditBinding===auditBinding&&await this.store.cloudRowCount(saved.current.treeRoot)===saved.current.rowCount){
    if(!readOnly&&window.serverRevision!==saved.cursor){const next=JSON.parse(canonical(before));next.cloud={...saved,cursor:window.serverRevision};await this.store.observationUpdate(before,next);}
    if(historyGap&&!readOnly)await this.rebuild?.();return {empty:false,rows:saved.current.rowCount,awaitingUser:!!before.pendingChoice,bodyReads:0,checkpointHit:true,...(readOnly?{readOnly:true}:{}),...(historyGap&&!readOnly?{rebuildRequired:!this.rebuild,rebuilt:!!this.rebuild}:{})};
   }
  }
  const objects=new Map<string,Uint8Array>(),get=async(id:string)=>{const existing=objects.get(id);if(existing)return existing;const raw=await this.http.object(id,undefined,window.windowId);objects.set(id,raw);return raw;};
  const headerCache=new Map<string,any>();
  const readHeader=async(id:string)=>{
   const retained=await this.store.readHeader(id);if(retained)return retained;if(headerCache.has(id))return headerCache.get(id);if(saved.headers?.[id])return saved.headers[id];
   const stop=saved.pins.accountOid;const page=await this.http.json('GET','/account/ancestry?head='+encodeURIComponent(id)+'&stop='+encodeURIComponent(stop??'null')+'&limit=64');
   exact(page,['version','scope','head','stop','headers','nextOid','complete']);sameScope(page.scope,this.scope);
   if(page.head!==id||page.stop!==stop||!Array.isArray(page.headers)||page.headers.length<1||page.headers.length>64||jsonBytes(page).length>262144)throw Error('ref_continuity_unavailable');let cursor:string|null=id;
   for(const entry of page.headers){exact(entry,['commitOid','headerOid','body','signature']);if(entry.commitOid!==cursor)throw Error('ref_continuity_unavailable');oid(entry.commitOid,'commit');oid(entry.headerOid,'commit-header');if(objectOid('commit-header',jsonBytes({body:entry.body,signature:entry.signature}))!==entry.headerOid)throw Error('hash_mismatch');headerCache.set(entry.commitOid,entry);cursor=entry.body.accountParent;}
   if(page.nextOid!==cursor||page.complete!==(cursor===stop))throw Error('ref_continuity_unavailable');return headerCache.get(id);
  };
  const path=await authenticatePath(this.crypto,this.scope,a.commitOid,saved.pins,readHeader,this.approved),head=path.head??(await this.store.readHeader(a.commitOid))?.body??saved.headers?.[a.commitOid]?.body;
  for(const entry of path.path)objects.set(entry.oid,jsonBytes({body:entry.body,signature:entry.signature}));
  if(!head||head.rollbackGeneration!==a.rollbackGeneration)throw Error('replay_detected');if(head.requiredFeatures.some((f:string)=>!this.supported.includes(f)))throw Error('unsupported_feature');
  // A closed explicit-action gate permits authentication and decoding only.
  // Keep the original persistent version, pins and choice fence untouched.
  if(readOnly){let count=0;await this.snapshot(head.treeRoot,window.windowId,get,async ids=>{const batch=await this.http.objects(window.windowId,ids);for(const [id,raw]of batch)objects.set(id,raw);return batch;},undefined,async()=>{count++;});if(this.now()>window.expiresAtMillis)throw Error('window_expired');return {empty:false,readOnly:true,rows:count,awaitingUser:!!before.pendingChoice,bodyReads:0};}
  // F2: rows stream into encrypted staging under the new root; only per-row OID,
  // binding and visibility metadata stay in memory. The active tree switches
  // only at the final CAS below.
  // Nothing is written before the first decoded batch, so an early failure
  // leaves the local state byte-identical.
  let staged:SyncState|null=null,count=0;const pending:any[]=[],seen:ObservedRow[]=[];
  const flush=async()=>{staged??=await this.store.stageHeaders(path.path,before,true);if(pending.length)staged=await this.store.stageCloudRows(head.treeRoot,pending.splice(0),staged,true);return staged;};
  const sink=async(r:any)=>{count++;seen.push({entityKey:r.row.entityKey,note:r.meta.kind==='note',noteId:r.meta.logicalId,deleted:r.row.deleted,noteRevision:r.segments?.noteRevision??null,unopenable:r.unopenable?.code??null});pending.push(r);if(pending.length>=32||r.segments||r.unopenable)await flush();};
  try{await this.snapshot(head.treeRoot,window.windowId,get,async ids=>{const batch=await this.http.objects(window.windowId,ids);for(const [id,raw]of batch)objects.set(id,raw);return batch;},saved.current?.treeRoot?id=>this.store.cloudRow(saved.current.treeRoot,id):undefined,sink);staged=await flush();}catch(error){if((error as Error).message==='unsupported_feature')await this.store.quarantineIncoming(staged??before,a.commitOid,objects,'unsupported_feature',true);throw error;}
  const editBases=copy(saved.editBases??{}),editCreates:string[]=[...saved.editCreates??[]],baseWrites:Statement[]=[];
  if(before.hasUnsentEdits&&saved.current?.commitOid===before.editBase.accountOid){let after='';for(;;){const page=await this.store.candidatePage(after,32,PAGE_BYTES);if(!page.length)break;for(const entry of page){const old=await this.store.cloudRow(saved.current.treeRoot,entry.entityKey);if(old?.unopenable)continue;const local={identity:entry.candidate.meta.logicalId,...entry.candidate.meta.payload,...conflictNeutral(entry.candidate.state).payload},base=old?{identity:old.meta.logicalId,...old.meta.payload,...old.state.payload}:null;if(canonical(local)!==canonical(old?{identity:old.meta.logicalId,...old.meta.payload,...conflictNeutral(old.state).payload}:null)){if(base){const kept=await this.store.editBaseEntry(entry.entityKey,base);editBases[entry.entityKey]=kept.value;baseWrites.push(...kept.statements);}else if(!editCreates.includes(entry.entityKey))editCreates.push(entry.entityKey);}}after=page.at(-1)!.entityKey;}}
  const next=observeAccount(staged,{oid:a.commitOid,revision:a.revision,generation:a.rollbackGeneration});path.pins.seenOids=[];
  // The only content snapshot retained is the current authenticated index.
  next.cloud={...saved,editBases,editCreates,pins:path.pins,headers:{},cursor:window.serverRevision,current:{commitOid:a.commitOid,treeRoot:head.treeRoot,rowCount:count},windowId:window.windowId,auditBinding,blockedCommitOid:null,blockedCode:null};
  if(saved.lastPublication?.commitOid===a.commitOid&&saved.lastPublication.localRevision===staged.localChangeRevision){next.hasUnsentEdits=false;next.editBase={accountOid:a.commitOid,generation:a.rollbackGeneration};}
  next.knownAuthors=path.pins.authors;next.knownAccountParents={[a.commitOid]:head.accountParent};
  next.cloud.unopenableNotes=unopenableNotes(seen);const bindings=await this.observeBindings(seen,saved.current?.treeRoot??null),kept=await this.keepQuarantinedEdits(seen,staged,saved);next.cloud.unopenableBaselines=kept.baselines;
  if(this.now()>window.expiresAtMillis)throw Error('window_expired');await this.store.observationUpdate(staged,next,[...baseWrites,...bindings,...kept.statements,...this.store.unopenableNotesStatements(Object.keys(next.cloud.unopenableNotes))]);await this.store.sweepEditBases(next);await this.store.dropInactiveCloudRows(head.treeRoot);if(historyGap)await this.rebuild?.();return {empty:false,rows:count,awaitingUser:!!next.pendingChoice,bodyReads:0,...(historyGap?{rebuildRequired:!this.rebuild,rebuilt:!!this.rebuild}:{})};
 }
 /** R2: a local note edit never stays only on a note this device cannot open.
  * An unsent edit when the note enters quarantine, or any later local change of
  * a quarantined note (against its recorded baseline), is kept as a new local
  * note ("keep both") that publishes normally. The original stays quarantined
  * and its remote row travels back unchanged. Baselines are digests, never text.
  * N1: the copies never enter the state CAS as note statements. Each kept edit
  * gets a noteId derived from (device key, scope, entity, baseline digest), so
  * a crash re-run recreates the same single note; WatchProjectionStore
  * .prepareQuarantineCopies moves every statement through bounded encrypted
  * pages and the CAS carries only the small program marker. */
 private async keepQuarantinedEdits(seen:readonly ObservedRow[],before:SyncState,saved:any){
  const baselines:Record<string,string|null>={},prior:Record<string,string|null>=saved.unopenableBaselines??{},root=saved.current?.treeRoot??null,sameBase=saved.current?.commitOid===before.editBase.accountOid;
  const copies:{entityKey:string;digest:string;noteId:string}[]=[];
  for(const r of seen){if(!r.note||!r.unopenable)continue;
   const candidate=await this.store.readCandidate(r.entityKey),local=candidate?noteEditDigest(candidate):null;baselines[r.entityKey]=local;if(!candidate)continue;
   const old=root?await this.store.cloudRow(root,r.entityKey):null;
   const edited=old?.unopenable?Object.hasOwn(prior,r.entityKey)&&prior[r.entityKey]!==local:before.hasUnsentEdits&&(sameBase?!old||noteEditDigest(old)!==local:Object.hasOwn(saved.editBases??{},r.entityKey)||(saved.editCreates??[]).includes(r.entityKey));
   const value=edited?fromWire('note',candidate.meta.payload,candidate.state.payload):null;if(!value||value.deleted)continue;
   copies.push({entityKey:r.entityKey,digest:local!,noteId:copyNoteId(this.scope,this.keys.id,r.entityKey,local!)});
  }
  if(!copies.length)return {baselines,statements:[] as Statement[]};
  const store=this.store;
  const statements=await store.prepareQuarantineCopies(before,sha256Hex(bytes(canonical(copies))),this.now(),async function*(now){
   for(const c of copies){
    const candidate=await store.readCandidate(c.entityKey);
    if(!candidate||noteEditDigest(candidate)!==c.digest)throw Error('sql_program_incomplete');
    const value=fromWire('note',candidate.meta.payload,candidate.state.payload);if(value.deleted)throw Error('sql_program_incomplete');
    const {noteConflicts:_,...rest}=value,hash=sha256Hex(bytes(value.markdown));
    // The kept note is fresh but published: normally its base is its own text.
    // Repeating a long text twice would push the copy over the note budget, so
    // an over-budget copy keeps the edit's own (bounded) base pair instead.
    // M1: the criterion charges exactly what scan and publish charge (business
    // .candidates -> encodeNote -> measureNote: the JSON-escaped bytes of the
    // three text fields against NOTE_TEXT_BUDGET), never a UTF-8 approximation.
    // Escape-heavy bodies cost more escaped than in UTF-8; admitting base=own
    // text by a UTF-8 size would fail the copy's next scan with storage_pressure
    // forever. base=own baseMarkdown is the very field set the scan already
    // admitted, so it fits by contract; anything else fails closed.
    const charged=(baseMarkdown:string)=>measureNote(splitOrdinary({version:2,entityKey:c.entityKey,requiredFeatures:[],payload:{markdown:value.markdown,plainText:value.plainText,baseMarkdown},noteSegments:[]})).textBytes;
    const fitsBase=charged(value.markdown)<=NOTE_TEXT_BUDGET;
    if(!fitsBase&&charged(value.baseMarkdown)>NOTE_TEXT_BUDGET)throw Error('sql_program_incomplete');
    let batch:Statement[]=[],size=0;
    for(const s of noteUpsert({...rest,noteId:c.noteId,baseMarkdown:fitsBase?value.markdown:value.baseMarkdown,contentHash:hash,baseContentHash:fitsBase?hash:value.baseContentHash,createdAt:now,updatedAt:now,deleted:false,deletedAt:0})){
     const n=JSON.stringify(s).length;if(batch.length&&(batch.length>=64||size+n>512*1024)){yield batch;batch=[];size=0;}
     batch.push(s);size+=n;}
    if(batch.length)yield batch;
   }
  });
  return {baselines,statements};
 }
 /** 25.3 observation. A remote tombstone ends the local note life. A remote
  * segmented row with another binding replaces the local binding only when this
  * device has no unpublished edit of that note; otherwise the local binding stays. */
 private async observeBindings(seen:readonly ObservedRow[],oldRoot:string|null){
  const out:Statement[]=[];
  for(const r of seen){if(!r.note)continue;const saved=await this.store.noteBinding(r.entityKey);if(!saved)continue;
   if(r.deleted){if(saved.life!=='deleted'||saved.revision!==null)out.push(await this.store.noteBindingStatement(r.entityKey,{revision:null,life:'deleted'}));continue;}
   if(!r.noteRevision||r.noteRevision===saved.revision)continue;
   const candidate=await this.store.readCandidate(r.entityKey),old=oldRoot?await this.store.cloudRow(oldRoot,r.entityKey):null;
   // F6: an empty conflict container is not an edit (either side may omit it).
   const edited=!!candidate&&(!old||!!old.unopenable||canonical({meta:candidate.meta.payload,state:conflictNeutral(candidate.state)})!==canonical({meta:old.meta.payload,state:conflictNeutral(old.state)}));
   if(!edited)out.push(await this.store.noteBindingStatement(r.entityKey,null));
  }
  return out;
 }
 /** Authenticated decoded rows. With `sink`, each row is handed over as soon as
  * it is decoded and nothing is accumulated (F2); otherwise rows are returned. */
 async snapshot(treeRoot:string,windowId:string,get?:(id:string)=>Promise<Uint8Array>,batch?:(ids:string[])=>Promise<Map<string,Uint8Array>>,previous?:(entityKey:string)=>Promise<any>,sink?:(row:any)=>Promise<void>){
  const read=get??(id=>this.http.object(id,undefined,windowId)),direct=(id:string)=>this.http.object(id,undefined,windowId),rows=await readTree(this.scope,treeRoot,read),decoded:any[]=[],emit=async(r:any)=>{if(sink)await sink(r);else decoded.push(r);};
  for(const row of rows){
   const pair=batch?await batch([row.metaOid,row.stateOid]):!get?await this.http.objects(windowId,[row.metaOid,row.stateOid]):new Map([[row.metaOid,await read(row.metaOid)],[row.stateOid,await read(row.stateOid)]]);
   const meta=await openV2(this.crypto,this.keys.id,this.keys.readContentKey??this.keys.content,this.scope,row.metaOid,pair.get(row.metaOid)!),state=await openV2(this.crypto,this.keys.id,this.keys.readContentKey??this.keys.content,this.scope,row.stateOid,pair.get(row.stateOid)!);
   if(!this.keys.readContentKey&&(meta.header.keyVersion!==this.keys.version||state.header.keyVersion!==this.keys.version))throw Error('unsupported_feature');
   const m=meta.value,s=state.value;exact(m,['version','entityKey','kind','logicalId','addedAtSource','requiredFeatures','payload']);exact(s,['version','entityKey','requiredFeatures','payload','noteSegments']);
   if(m.version!==2||s.version!==2||m.entityKey!==row.entityKey||s.entityKey!==row.entityKey||entityKey(this.keys.id,this.scope.repoId,m.kind,m.logicalId)!==row.entityKey||!['original','unknown'].includes(m.addedAtSource))throw Error('invalid_schema');features(m.requiredFeatures);features(s.requiredFeatures);features(row.requiredFeatures);if(m.requiredFeatures.length||row.requiredFeatures.some((f:string)=>f!==NOTE_SEGMENTS_FEATURE||!this.supported.includes(f)))throw Error('unsupported_feature');if(!Array.isArray(s.noteSegments))throw Error('invalid_schema');
   const segmented=s.noteSegments.length>0||s.requiredFeatures.includes(NOTE_SEGMENTS_FEATURE)||s.payload?.segmentedNote!==undefined;let segments:any=null,s0=s;
   if(segmented){if(m.kind!=='note')throw Error('invalid_schema');const old=await previous?.(row.entityKey);
    const quarantined=()=>{if(!!s.payload?.metadata?.deleted!==row.deleted)throw Error('invalid_schema');return emit({row,meta:m,state:s,unopenable:{code:'storage_pressure'},placeholder:placeholder(row),placeholderText:placeholderText(row)});};
    if(old?.row.stateOid===row.stateOid&&old.unopenable){await quarantined();continue;}
    if(old?.row.stateOid===row.stateOid&&old.segments){s0=old.state;segments=old.segments;}
    else{let out;try{out=await readSegmentedNote(row.stateOid,s,noteClosurePorts(this.http,direct,this.crypto,this.keys,this.approved,windowId),{entityKey:row.entityKey,supported:this.supported,budget:this.options.noteTextBudget??NOTE_TEXT_BUDGET});}
     catch(error){if((error as Error).message!=='storage_pressure')throw error;
      // F1/W3: this entity is quarantined like an unsupported row: not reassembled,
      // not applied; the authenticated row and parent travel back unchanged.
      await quarantined();continue;}
     s0=out.state;segments=storedSegments(out.segments);}}
   const conflicts=m.kind==='note'?readConflicts(s0,{entityKey:row.entityKey,noteId:m.logicalId},['note-conflicts.v1']):null;if(m.kind!=='note'&&s0.requiredFeatures.length)throw Error('unsupported_feature');
   const payload={...s0.payload};if(conflicts)delete payload.noteConflicts;const value=fromWire(m.kind,m.payload,payload),logicalId=m.kind==='article'?value.articleId:m.kind==='book'?value.bookId:m.kind==='book-reading'?value.bookId+':'+value.chapterIndex:m.kind==='rss-state'?value.sourceId+':'+value.articleIdHash:m.kind==='source'?value.url:m.kind==='note'?value.noteId:m.kind==='folder'?value.folderId:value.assetId;if(logicalId!==m.logicalId)throw Error('invalid_schema');if(!!value.deleted!==row.deleted)throw Error('invalid_schema');
   if(segmented){await emit({row,meta:m,state:s0,segments,placeholder:placeholder(row),placeholderText:placeholderText(row)});continue;}
   const mapping=await this.http.stateRefs(windowId,row.stateOid);exact(mapping,['version','scope','parentOid','refsOid','authorDeviceId','keyId','totalBytes']);sameScope(mapping.scope,this.scope);if(mapping.parentOid!==row.stateOid)throw Error('invalid_schema');oid(mapping.refsOid,'state-refs');const raw=await read(mapping.refsOid);if(raw.length!==mapping.totalBytes||objectOid('state-refs',raw)!==mapping.refsOid)throw Error('hash_mismatch');const refs=parseCanonicalJson(raw);exact(refs,['body','signature']);exact(refs.body,['scope','stateOid','segmentOids']);sameScope(refs.body.scope,this.scope);if(refs.body.stateOid!==row.stateOid||canonical(refs.body.segmentOids)!==canonical(s.noteSegments))throw Error('closure_incomplete');const signer=await this.approved(mapping.authorDeviceId);if(signer.keyId!==mapping.keyId)throw Error('signature_invalid');await verifySigned(this.crypto,signer.publicKey,'wrss.sync.v2/state-refs-sign',refs.body,refs.signature);
   await emit({row,meta:m,state:s,placeholder:placeholder(row),placeholderText:placeholderText(row)});
  }
  return decoded;
 }
 async poll(){const state=await this.store.readState(),saved=this.current(state);try{const window=await this.http.events(saved.cursor);return await this.pull(window);}catch(error){if(error instanceof SyncV2Error&&error.code==='history_expired'){const checkpoint:any=error.details.checkpoint;if(!checkpoint)throw Error('ref_continuity_unavailable');await this.bootstrap({checkpoint,account:checkpoint.body?.account,serverRevision:checkpoint.body?.serverRevision});const window=await this.http.json('GET','/account');const result=await this.pull(window);if(!('rebuilt' in result&&result.rebuilt))await this.rebuild?.();return {...result,rebuildRequired:!this.rebuild,rebuilt:!!this.rebuild};}throw error;}}
 /** History is an OID-only directory; selecting/fetching/restoring is P5. */
 async history(pageToken:string|null=null){const v=await this.http.json('GET','/history'+(pageToken===null?'':'?pageToken='+encodeURIComponent(pageToken)));if(!Array.isArray(v.items)||v.items.length>100)throw Error('invalid_schema');for(const x of v.items){exact(x,['commitOid','retiredAtMillis','expiresAtMillis','authorDeviceId']);oid(x.commitOid,'commit');uint(x.retiredAtMillis);uint(x.expiresAtMillis);hexId(x.authorDeviceId,32);}return {items:v.items,pageToken:v.pageToken};}
}
