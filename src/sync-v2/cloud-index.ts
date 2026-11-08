import {canonical,jsonBytes,parseCanonicalJson,digest,hexId,oid,exact,checkD64,compareD64,nextD64,uint,entityKey,validateScope,type Scope} from './protocol';
import {sameScope,features,b64,unb64,indexRow} from './wire';
import {authenticatePath,type ApprovedKey,type Pins} from './head-pins';
import {openV2,objectOid,type EnvelopeCrypto,sealV2} from './sealed';
import {signCommit,signControl,verifySigned,type SigningPort} from './signing';
import {readTree,buildTree} from './merkle';
import {readConflicts} from './notes-conflict';
import {fromWire} from './business';
import {observeAccount,type SyncState} from './state';
import type {WatchProjectionStore} from './store';
import {SyncV2Http,SyncV2Error} from './http';
import {NOTE_SEGMENTS_FEATURE,NOTE_TEXT_BUDGET,readSegmentedNote,type ClosurePorts} from './note-segments';
import {storedSegments} from './publisher';
import type {Statement} from '@podjs/framework/sql-projection';
const missing=(error:unknown)=>error instanceof SyncV2Error&&error.code==='object_missing';
/** 25.5 closure ports over the authenticated window. Missing objects/tables are
 * null (closure_incomplete is decided by the caller's order). Malformed
 * mappings and tables are invalid_schema, never a host TypeError. */
export function noteClosurePorts(http:Pick<SyncV2Http,'scope'|'stateRefs'>,read:(id:string)=>Promise<Uint8Array>,crypto:EnvelopeCrypto&SigningPort,keys:{id:Uint8Array;content:Uint8Array;version:number},approved:(deviceId:string)=>Promise<ApprovedKey>,windowId:string):ClosurePorts{
 const scope=http.scope;
 return {
  async object(id){try{return await read(id);}catch(error){if(missing(error))return null;throw error;}},
  async refs(stateOid){let mapping:any;try{mapping=await http.stateRefs(windowId,stateOid);}catch(error){if(missing(error))return null;throw error;}
   const id=mapping?.refsOid;if(typeof id!=='string'||!/^state-refs:sha256:[a-f0-9]{64}$/.test(id))return {mapping,raw:new Uint8Array(0)};
   try{return {mapping,raw:await read(id)};}catch(error){if(missing(error))return {mapping,raw:null};throw error;}},
  async open(id,raw){const opened=await openV2(crypto,keys.id,keys.content,scope,id,raw);if(opened.header.type!=='state')throw Error('invalid_schema');if(opened.header.keyVersion!==keys.version)throw Error('unsupported_feature');return opened.value;},
  async verifyRefs(stateOid,read){
   const m=read.mapping;try{exact(m,['version','scope','parentOid','refsOid','authorDeviceId','keyId','totalBytes']);validateScope(m.scope);}catch{throw Error('invalid_schema');}sameScope(m.scope,scope);
   try{if(m.version!==2||m.parentOid!==stateOid)throw Error();oid(m.refsOid,'state-refs');hexId(m.authorDeviceId,32);hexId(m.keyId,32);if(uint(m.totalBytes,262144)===0)throw Error();}catch{throw Error('invalid_schema');}
   const refs=parseCanonicalJson(read.raw!);try{exact(refs,['body','signature']);exact(refs.body,['scope','stateOid','segmentOids']);validateScope(refs.body.scope);}catch{throw Error('invalid_schema');}sameScope(refs.body.scope,scope);
   const b=refs.body;try{if(b.stateOid!==stateOid||!Array.isArray(b.segmentOids)||b.segmentOids.length>2048)throw Error();for(const id of b.segmentOids)oid(id,'state');}catch{throw Error('invalid_schema');}
   const signer=await approved(m.authorDeviceId);if(signer.keyId!==m.keyId)throw Error('signature_invalid');await verifySigned(crypto,signer.publicKey,'wrss.sync.v2/state-refs-sign',b,refs.signature);return b.segmentOids;
  },
 };
}
export interface CloudIndexOptions {noteSegments?:boolean;noteTextBudget?:number}
export type CloudPullResult={empty:boolean;rows?:number;awaitingUser?:boolean;bodyReads?:number;checkpointHit?:boolean;rebuildRequired?:boolean;rebuilt?:boolean};
export const placeholder=(row:any)=>row.bodyRevision===null?'no-body':row.recipeOid===null?'source-pending':'body-not-downloaded';
export const placeholderText=(row:any)=>row.bodyRevision===null?null:row.recipeOid===null?'正文尚未就绪':'正文尚未下载';
const copy=<T>(v:T):T=>JSON.parse(canonical(v));
/** P2 index coordinator. No body export, worker, history restore or local framing. */
export class WatchCloudIndex {
 constructor(private readonly store:WatchProjectionStore,private readonly http:SyncV2Http,private readonly crypto:EnvelopeCrypto&SigningPort,private readonly keys:{id:Uint8Array;content:Uint8Array;version:number},private readonly approved:(deviceId:string)=>Promise<ApprovedKey>,private readonly bootstrap:(window:any)=>Promise<void>,private readonly now:()=>number=Date.now,private readonly rebuild?:()=>Promise<void>,private readonly options:CloudIndexOptions={}){}
 private get supported(){return this.options.noteSegments===true?['note-conflicts.v1',NOTE_SEGMENTS_FEATURE]:['note-conflicts.v1'];}
 private get scope(){return this.http.scope;}
 private current(state:SyncState){return {pins:{accountOid:null,authors:{},seenOids:[]},headers:{},cursor:'0',current:null,deviceSequence:'0',pendingPublish:null,...state.cloud};}
 async pull(window:any):Promise<CloudPullResult>{
  if((await this.store.readStableState()).cloud?.witnessConflict)throw Error('ref_continuity_unavailable');
  const capabilities=await this.http.capabilities();sameScope(window.scope,this.scope);if(window.version!==2)throw Error('upgrade_required');exact(window.account,['commitOid','revision','rollbackGeneration']);const a=window.account;checkD64(a.revision);checkD64(a.rollbackGeneration);checkD64(window.serverRevision);checkD64(window.historyFloorRevision);hexId(window.windowId,32);uint(window.expiresAtMillis);if(this.now()>window.expiresAtMillis)throw Error('window_expired');if(compareD64(window.historyFloorRevision,window.serverRevision)>0)throw Error('invalid_schema');
  const before=await this.store.readState(),saved=this.current(before),auditBinding=digest({scope:this.scope,keyVersion:this.keys.version,features:capabilities.features,schema:'v2-rc6c-business-2'});if(compareD64(window.serverRevision,saved.cursor)<0)throw Error('replay_detected');if(compareD64(a.rollbackGeneration,before.rollbackGeneration)<0||compareD64(a.revision,before.lastSeenAccountRevision)<0)throw Error('replay_detected');
  const historyGap=compareD64(saved.cursor,window.historyFloorRevision)<0;
  if(a.commitOid===null){if(a.revision!=='0'||a.rollbackGeneration!=='0'||saved.pins.accountOid!==null)throw Error('replay_detected');return {empty:true};}
  oid(a.commitOid,'commit');if(a.revision==='0')throw Error('invalid_schema');if(saved.pins.accountOid===null)await this.bootstrap(window);
  if(saved.current?.commitOid===a.commitOid){
   if(a.revision!==before.account?.revision||a.rollbackGeneration!==before.account?.generation)throw Error('replay_detected');
   if(saved.auditBinding===auditBinding&&await this.store.cloudRowCount(saved.current.treeRoot)===saved.current.rowCount){
    if(window.serverRevision!==saved.cursor){const next=JSON.parse(canonical(before));next.cloud={...saved,cursor:window.serverRevision};await this.store.controlUpdate(before,next);}
    if(historyGap)await this.rebuild?.();return {empty:false,rows:saved.current.rowCount,awaitingUser:!!before.pendingChoice,bodyReads:0,checkpointHit:true,...(historyGap?{rebuildRequired:!this.rebuild,rebuilt:!!this.rebuild}:{})};
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
  let decoded:any[];try{decoded=await this.snapshot(head.treeRoot,window.windowId,get,async ids=>{const batch=await this.http.objects(window.windowId,ids);for(const [id,raw]of batch)objects.set(id,raw);return batch;},saved.current?.treeRoot?id=>this.store.cloudRow(saved.current.treeRoot,id):undefined);}catch(error){if((error as Error).message==='unsupported_feature')await this.store.quarantineIncoming(before,a.commitOid,objects,'unsupported_feature');throw error;}
  const headerStaged=await this.store.stageHeaders(path.path,before),staged=await this.store.stageCloudRows(head.treeRoot,decoded,headerStaged);
  const editBases=copy(saved.editBases??{}),editCreates:string[]=[...saved.editCreates??[]];
  if(before.hasUnsentEdits&&saved.current?.commitOid===before.editBase.accountOid){let after='';for(;;){const page=await this.store.candidatePage(after,32);if(!page.length)break;for(const entry of page){const old=await this.store.cloudRow(saved.current.treeRoot,entry.entityKey),local={identity:entry.candidate.meta.logicalId,...entry.candidate.meta.payload,...entry.candidate.state.payload},base=old?{identity:old.meta.logicalId,...old.meta.payload,...old.state.payload}:null;if(canonical(local)!==canonical(base)){if(base)editBases[entry.entityKey]=base;else if(!editCreates.includes(entry.entityKey))editCreates.push(entry.entityKey);}}after=page.at(-1)!.entityKey;}}
  const next=observeAccount(staged,{oid:a.commitOid,revision:a.revision,generation:a.rollbackGeneration});path.pins.seenOids=[];
  // The only content snapshot retained is the current authenticated index.
  next.cloud={...saved,editBases,editCreates,pins:path.pins,headers:{},cursor:window.serverRevision,current:{commitOid:a.commitOid,treeRoot:head.treeRoot,rowCount:decoded.length},windowId:window.windowId,auditBinding,blockedCommitOid:null,blockedCode:null};
  if(saved.lastPublication?.commitOid===a.commitOid&&saved.lastPublication.localRevision===staged.localChangeRevision){next.hasUnsentEdits=false;next.editBase={accountOid:a.commitOid,generation:a.rollbackGeneration};}
  next.knownAuthors=path.pins.authors;next.knownAccountParents={[a.commitOid]:head.accountParent};
  const bindings=await this.observeBindings(decoded,saved.current?.treeRoot??null);
  if(this.now()>window.expiresAtMillis)throw Error('window_expired');await this.store.controlUpdate(staged,next,bindings);await this.store.dropInactiveCloudRows(head.treeRoot);if(historyGap)await this.rebuild?.();return {empty:false,rows:decoded.length,awaitingUser:!!next.pendingChoice,bodyReads:0,...(historyGap?{rebuildRequired:!this.rebuild,rebuilt:!!this.rebuild}:{})};
 }
 /** 25.3 observation. A remote tombstone ends the local note life. A remote
  * segmented row with another binding replaces the local binding only when this
  * device has no unpublished edit of that note; otherwise the local binding stays. */
 private async observeBindings(decoded:any[],oldRoot:string|null){
  const out:Statement[]=[];
  for(const r of decoded){if(r.meta.kind!=='note')continue;const saved=await this.store.noteBinding(r.row.entityKey);if(!saved)continue;
   if(r.row.deleted){if(saved.life!=='deleted'||saved.revision!==null)out.push(await this.store.noteBindingStatement(r.row.entityKey,{revision:null,life:'deleted'}));continue;}
   if(!r.segments||r.segments.noteRevision===saved.revision)continue;
   const candidate=await this.store.readCandidate(r.row.entityKey),old=oldRoot?await this.store.cloudRow(oldRoot,r.row.entityKey):null;
   const edited=!!candidate&&(!old||canonical({meta:candidate.meta.payload,state:candidate.state})!==canonical({meta:old.meta.payload,state:old.state}));
   if(!edited)out.push(await this.store.noteBindingStatement(r.row.entityKey,null));
  }
  return out;
 }
 async snapshot(treeRoot:string,windowId:string,get?:(id:string)=>Promise<Uint8Array>,batch?:(ids:string[])=>Promise<Map<string,Uint8Array>>,previous?:(entityKey:string)=>Promise<any>){
  const read=get??(id=>this.http.object(id,undefined,windowId));const rows=await readTree(this.scope,treeRoot,read),decoded:any[]=[];
  for(const row of rows){
   const pair=batch?await batch([row.metaOid,row.stateOid]):!get?await this.http.objects(windowId,[row.metaOid,row.stateOid]):new Map([[row.metaOid,await read(row.metaOid)],[row.stateOid,await read(row.stateOid)]]);
   const meta=await openV2(this.crypto,this.keys.id,this.keys.content,this.scope,row.metaOid,pair.get(row.metaOid)!),state=await openV2(this.crypto,this.keys.id,this.keys.content,this.scope,row.stateOid,pair.get(row.stateOid)!);
   if(meta.header.keyVersion!==this.keys.version||state.header.keyVersion!==this.keys.version)throw Error('unsupported_feature');
   const m=meta.value,s=state.value;exact(m,['version','entityKey','kind','logicalId','addedAtSource','requiredFeatures','payload']);exact(s,['version','entityKey','requiredFeatures','payload','noteSegments']);
   if(m.version!==2||s.version!==2||m.entityKey!==row.entityKey||s.entityKey!==row.entityKey||entityKey(this.keys.id,this.scope.repoId,m.kind,m.logicalId)!==row.entityKey||!['original','unknown'].includes(m.addedAtSource))throw Error('invalid_schema');features(m.requiredFeatures);features(s.requiredFeatures);features(row.requiredFeatures);if(m.requiredFeatures.length||row.requiredFeatures.some((f:string)=>f!==NOTE_SEGMENTS_FEATURE||!this.supported.includes(f)))throw Error('unsupported_feature');if(!Array.isArray(s.noteSegments))throw Error('invalid_schema');
   const segmented=s.noteSegments.length>0||s.requiredFeatures.includes(NOTE_SEGMENTS_FEATURE)||s.payload?.segmentedNote!==undefined;let segments:any=null,s0=s;
   if(segmented){if(m.kind!=='note')throw Error('invalid_schema');const old=await previous?.(row.entityKey);
    if(old?.row.stateOid===row.stateOid&&old.segments){s0=old.state;segments=old.segments;}
    else{const out=await readSegmentedNote(row.stateOid,s,noteClosurePorts(this.http,read,this.crypto,this.keys,this.approved,windowId),{entityKey:row.entityKey,supported:this.supported,budget:this.options.noteTextBudget??NOTE_TEXT_BUDGET});s0=out.state;segments=storedSegments(out.segments);}}
   const conflicts=m.kind==='note'?readConflicts(s0,{entityKey:row.entityKey,noteId:m.logicalId},['note-conflicts.v1']):null;if(m.kind!=='note'&&s0.requiredFeatures.length)throw Error('unsupported_feature');
   const payload={...s0.payload};if(conflicts)delete payload.noteConflicts;const value=fromWire(m.kind,m.payload,payload),logicalId=m.kind==='article'?value.articleId:m.kind==='book'?value.bookId:m.kind==='book-reading'?value.bookId+':'+value.chapterIndex:m.kind==='rss-state'?value.sourceId+':'+value.articleIdHash:m.kind==='source'?value.url:m.kind==='note'?value.noteId:m.kind==='folder'?value.folderId:value.assetId;if(logicalId!==m.logicalId)throw Error('invalid_schema');if(!!value.deleted!==row.deleted)throw Error('invalid_schema');
   if(segmented){decoded.push({row,meta:m,state:s0,segments,placeholder:placeholder(row),placeholderText:placeholderText(row)});continue;}
   const mapping=await this.http.stateRefs(windowId,row.stateOid);exact(mapping,['version','scope','parentOid','refsOid','authorDeviceId','keyId','totalBytes']);sameScope(mapping.scope,this.scope);if(mapping.parentOid!==row.stateOid)throw Error('invalid_schema');oid(mapping.refsOid,'state-refs');const raw=await read(mapping.refsOid);if(raw.length!==mapping.totalBytes||objectOid('state-refs',raw)!==mapping.refsOid)throw Error('hash_mismatch');const refs=parseCanonicalJson(raw);exact(refs,['body','signature']);exact(refs.body,['scope','stateOid','segmentOids']);sameScope(refs.body.scope,this.scope);if(refs.body.stateOid!==row.stateOid||canonical(refs.body.segmentOids)!==canonical(s.noteSegments))throw Error('closure_incomplete');const signer=await this.approved(mapping.authorDeviceId);if(signer.keyId!==mapping.keyId)throw Error('signature_invalid');await verifySigned(this.crypto,signer.publicKey,'wrss.sync.v2/state-refs-sign',refs.body,refs.signature);
   decoded.push({row,meta:m,state:s,placeholder:placeholder(row),placeholderText:placeholderText(row)});
  }
  return decoded;
 }
 async poll(){const state=await this.store.readState(),saved=this.current(state);try{const window=await this.http.events(saved.cursor);return await this.pull(window);}catch(error){if(error instanceof SyncV2Error&&error.code==='history_expired'){const checkpoint:any=error.details.checkpoint;if(!checkpoint)throw Error('ref_continuity_unavailable');await this.bootstrap({account:checkpoint.body?.account,serverRevision:checkpoint.body?.serverRevision});const window=await this.http.json('GET','/account');const result=await this.pull(window);if(!('rebuilt' in result&&result.rebuilt))await this.rebuild?.();return {...result,rebuildRequired:!this.rebuild,rebuilt:!!this.rebuild};}throw error;}}
 /** History is an OID-only directory; selecting/fetching/restoring is P5. */
 async history(pageToken:string|null=null){const v=await this.http.json('GET','/history'+(pageToken===null?'':'?pageToken='+encodeURIComponent(pageToken)));if(!Array.isArray(v.items)||v.items.length>100)throw Error('invalid_schema');for(const x of v.items){exact(x,['commitOid','retiredAtMillis','expiresAtMillis','authorDeviceId']);oid(x.commitOid,'commit');uint(x.retiredAtMillis);uint(x.expiresAtMillis);hexId(x.authorDeviceId,32);}return {items:v.items,pageToken:v.pageToken};}
}
