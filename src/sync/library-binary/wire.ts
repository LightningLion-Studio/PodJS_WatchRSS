/** Pure B2 S2 schemas. No production entry point imports this module. */
import {encodeUtf8} from '@podjs/framework/bytes';
import {sha256Hex} from '@podjs/framework/crypto';

export const ACTION='syncLibraryBinary',VERSION=2,CHUNK_BYTES=65536,RETENTION=86400000,LEASE=30000;
export const PHASES=['prepare','begin','manifestPage','missing','putChunk','apply','complete','cancel'] as const;
export type Phase=typeof PHASES[number];
export type Direction='phoneToWatch'|'watchToPhone';
export type Kind='articleBody'|'articleMetadata'|'rssSource'|'readerMetadata'|'readerResource'|'noteAsset'|'bookState'|'bookPackageSegment'|'bookPackageCommit'|'bookReading';
export type Row=Record<string,unknown>;
export const HARD_LIMITS={maxObjectBytes:16777216,maxInFlightObjects:4,maxFrameBytes:131084,maxManifestPageBytes:131084,maxManifestPageEntries:16,maxMetadataBytes:16384,maxPlanObjects:4096,maxManifestBytes:16777216,maxRangesPerPage:128,maxResultsPerPage:16,maxStagingBytes:1610612736,maxJournalBytes:67108864,maxActiveJobs:2,maxInFlightChunks:8,maxInFlightBytes:524288,maxControlHeaderBytes:131072,maxPackageBytes:536870912} as const;
export const LIMIT_KEYS=Object.keys(HARD_LIMITS) as (keyof typeof HARD_LIMITS)[];
export type Limits={[K in keyof typeof HARD_LIMITS]:number};
export interface KindVersion {kind:Kind;schemaVersion:1}
export interface Selection {profile:'merge-b2';chunkBytes:65536;kinds:KindVersion[];limits:Limits}
export interface Capability {version:2;profile:'merge-b2';chunkSizes:[65536];kinds:(KindVersion&{send:boolean;receive:boolean})[];limits:Limits}
export interface Snapshot {snapshotId:string;manifestDigest:string;fromExclusive:number;toInclusive:number}
export interface Binding {direction:Direction;jobId:string;intent:'create'|'resume';selection:Selection}
export interface ObjectDescriptor {objectId:string;kind:Kind;schemaVersion:1;businessId:string;contentVersion:string;encoding:'article-v14'|'raw'|'none';size:number;sha256:string;chunkHashes:string[];metadataUtf8:string;chunkBytes:65536;metadataSha256:string;dependsOn:string[]}
export interface BeginPayload {intent:'create'|'resume';accountScope:string;phoneDeviceId:string;watchDeviceId:string;direction:Direction;phoneSnapshot:Snapshot;watchSnapshot:Snapshot;selection:Selection;selectionDigest:string;objectCount:number;objectsRoot:string;pageObjectCounts:number[]}
export interface Envelope {action:typeof ACTION;version:2;phase:Phase;type:'request'|'response';jobId:string|null;requestId:string;requestDigest:string;epoch:number|null;planDigest:string|null;payload?:Row;success?:boolean;result?:Row|null;error?:Row}
export type Outcome='merged'|'retainedLocal'|'alreadyPresent';
export interface AppliedReceipt {jobId:string;planDigest:string;objectId:string;applyRequestId:string;applyRequestDigest:string;receiverDeviceId:string;resultDigest:string;outcome:Outcome}
export interface Completion {state:'COMPLETE';objectCount:number;receiptsRoot:string;ackToInclusive:number;completionDigest:string}
export class ResumeError extends Error {
 constructor(readonly code:string){super(code);this.name='ResumeError';}
 wire():Row {
  let cls='PROTOCOL',recovery='STOP',retryable=false,retryAfterMillis=0;
  if(['ACCOUNT_REQUIRED','ACCOUNT_MISMATCH','PEER_MISMATCH','AUTH_REVOKED'].includes(this.code))cls='ACCOUNT';
  if(['BUSINESS_REJECTED','UNSUPPORTED_KIND','LIMIT_EXCEEDED','UNSUPPORTED_MODE','UNSUPPORTED_SCOPE'].includes(this.code))cls='BUSINESS';
  if(['LOCAL_IO','STORAGE_PRESSURE','JOURNAL_CORRUPT'].includes(this.code))cls='LOCAL';
  if(['NOT_FOUND','EXPIRED','SOURCE_CHANGED','LEASE_EXPIRED','MANIFEST_INCOMPLETE','CHUNKS_MISSING','DEPENDENCIES_PENDING','WINDOW_FULL','BUSY'].includes(this.code)){cls='STATE';retryable=true;recovery=['NOT_FOUND','EXPIRED','SOURCE_CHANGED'].includes(this.code)?'REPLAN':this.code==='LEASE_EXPIRED'?'BEGIN':['WINDOW_FULL','BUSY'].includes(this.code)?'WAIT':'QUERY';if(recovery==='WAIT')retryAfterMillis=100;}
  if(['USER_CANCELLED','JOB_CANCELLED'].includes(this.code))cls='CANCELLED';
  return {code:this.code,class:cls,retryable,recovery,retryAfterMillis};
 }
}
export function resumeError(error:unknown):ResumeError {
 if(error instanceof ResumeError)return error;
 const code=error instanceof Error?error.message:'';
 const known=['INVALID_FRAME','OBJECT_CONFLICT','STALE_EPOCH','LEASE_EXPIRED','BUSY','WINDOW_FULL','HASH_MISMATCH','CHUNKS_MISSING','LOCAL_IO','REQUEST_CONFLICT','JOB_CANCELLED','JOURNAL_CORRUPT','SOURCE_CHANGED','AUTH_REVOKED','BUSINESS_REJECTED','STORAGE_PRESSURE'];
 return new ResumeError(known.includes(code)?code:'LOCAL_IO');
}
export function fail(code='INVALID_FRAME'):never{throw new ResumeError(code);}
export function row(v:unknown):Row {if(v===null||typeof v!=='object'||Array.isArray(v))fail();return v as Row;}
export function exact(v:unknown,keys:readonly string[]):Row {const o=row(v);if(Object.keys(o).length!==keys.length||keys.some(k=>!Object.hasOwn(o,k)))fail();return o;}
export function integer(v:unknown,max=Number.MAX_SAFE_INTEGER):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||Object.is(v,-0)||v<0||v>max)fail();return v;}
export function text(v:unknown,max=2048,min=1):string{if(typeof v!=='string')fail();const n=encodeUtf8(v,'strict').length;if(n<min||n>max)fail();return v;}
export function hex(v:unknown,n=64):string{if(typeof v!=='string'||!new RegExp('^[0-9a-f]{'+n+'}$').test(v))fail();return v;}
export function bool(v:unknown):boolean{if(typeof v!=='boolean')fail();return v;}
export function array(v:unknown,max:number):unknown[]{if(!Array.isArray(v)||v.length>max)fail();return v;}
export const hash=(bytes:Uint8Array)=>sha256Hex(bytes);
export const utf8=(value:string)=>encodeUtf8(value,'strict');
export function sorted(values:readonly string[]):void{if(values.some((v,i)=>i>0&&values[i-1]!>=v))fail('PLAN_CONFLICT');}
export function limits(v:unknown):Limits {
 const o=exact(v,LIMIT_KEYS);
 for(const k of LIMIT_KEYS)if(!integer(o[k],HARD_LIMITS[k]))fail('CAPABILITY_MISMATCH');
 if(Number(o.maxFrameBytes)<65628||Number(o.maxInFlightBytes)<65536||
 !((o.maxInFlightChunks===1&&o.maxInFlightBytes===65536)||(o.maxInFlightChunks===8&&o.maxInFlightBytes===524288))||
 Number(o.maxManifestPageBytes)<13||Number(o.maxControlHeaderBytes)<1)fail('CAPABILITY_MISMATCH');
 return o as Limits;
}
const KINDS=['articleBody','articleMetadata','noteAsset','readerMetadata','readerResource','rssSource'];
function kindVersion(v:unknown,cap:boolean):KindVersion&Partial<{send:boolean;receive:boolean}>{const o=exact(v,cap?['kind','schemaVersion','send','receive']:['kind','schemaVersion']);if(!(cap?[...KINDS,'bookState','bookPackageSegment','bookPackageCommit','bookReading']:KINDS).includes(text(o.kind,32))||o.schemaVersion!==1)fail('UNSUPPORTED_KIND');if(cap){bool(o.send);bool(o.receive);}return o as unknown as KindVersion;}
export function selection(v:unknown):Selection{const o=exact(v,['profile','kinds','chunkBytes','limits']),ks=array(o.kinds,6).map(k=>kindVersion(k,false));if(!ks.length||o.profile!=='merge-b2'||o.chunkBytes!==65536)fail('CAPABILITY_MISMATCH');sorted(ks.map(k=>k.kind));if(ks.some(k=>k.kind==='articleBody')&&!ks.some(k=>k.kind==='articleMetadata')||ks.some(k=>k.kind==='readerResource')&&!ks.some(k=>k.kind==='readerMetadata'))fail('CAPABILITY_MISMATCH');limits(o.limits);return o as unknown as Selection;}
export function capability(v:unknown):Capability{const o=exact(v,['version','profile','kinds','chunkSizes','limits']);if(o.version!==2||o.profile!=='merge-b2'||!Array.isArray(o.chunkSizes)||o.chunkSizes.length!==1||o.chunkSizes[0]!==65536)fail('CAPABILITY_MISMATCH');const ks=array(o.kinds,10).map(k=>kindVersion(k,true));if(!ks.length)fail('CAPABILITY_MISMATCH');sorted(ks.map(k=>k.kind));limits(o.limits);return o as unknown as Capability;}
export function snapshot(v:unknown):Snapshot{const o=exact(v,['snapshotId','manifestDigest','fromExclusive','toInclusive']);if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(text(o.snapshotId,128)))fail();hex(o.manifestDigest);integer(o.fromExclusive);integer(o.toInclusive);if(Number(o.fromExclusive)>Number(o.toInclusive))fail('PLAN_CONFLICT');return o as unknown as Snapshot;}
export function binding(v:unknown):Binding{const o=exact(v,['direction','jobId','intent','selection']);if(!['phoneToWatch','watchToPhone'].includes(String(o.direction))||!['create','resume'].includes(String(o.intent)))fail();hex(o.jobId,32);selection(o.selection);return o as unknown as Binding;}

/** Validate lexical JSON before parsing, including escaped duplicate keys and
 * lone surrogates. C envelope numbers are unsigned integral lexical tokens;
 * embedded legacy metadata is separately decoded with integersOnly=false.
 */
export function strictJson(source:string,integersOnly=true):Row {
 let i=0,nodes=0;const ws=()=>{while(i<source.length&&/[\x20\t\r\n]/.test(source[i]!))i++;};
 const str=():string=>{ws();if(source[i++]!=='"')fail();const start=i-1;let escaped=false;while(i<source.length){const ch=source[i++]!;if(escaped){escaped=false;continue;}if(ch==='\\'){escaped=true;continue;}if(ch==='"'){let value:string;try{value=JSON.parse(source.slice(start,i));}catch{fail();}utf8(value);return value;}}fail();};
 const value=(depth:number):void=>{if(depth>16||++nodes>32768)fail();ws();const ch=source[i];if(ch==='"'){str();return;}if(ch==='{'){i++;const keys=new Set<string>();ws();if(source[i]==='}'){i++;return;}for(;;){const key=str();if(keys.has(key))fail();keys.add(key);ws();if(source[i++]!==':')fail();value(depth+1);ws();const next=source[i++];if(next==='}')return;if(next!==',')fail();}}
  if(ch==='['){i++;ws();if(source[i]===']'){i++;return;}for(;;){value(depth+1);ws();const next=source[i++];if(next===']')return;if(next!==',')fail();}}
  for(const lit of ['true','false','null'])if(source.slice(i,i+lit.length)===lit){i+=lit.length;return;}
  const token=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i))?.[0];if(!token)fail();i+=token.length;
  if(!Number.isFinite(Number(token))||integersOnly&&(!/^(?:0|[1-9][0-9]*)$/.test(token)||!Number.isSafeInteger(Number(token))))fail();
 };
 value(0);ws();if(i!==source.length)fail();let parsed:unknown;try{parsed=JSON.parse(source);}catch{fail();}return row(parsed);
}
export function envelope(v:unknown):Envelope {
 const o=row(v),response=o.type==='response';exact(o,response?['action','version','phase','type','jobId','requestId','requestDigest','epoch','planDigest','success','result',...(o.success===false?['error']:[])]:['action','version','phase','type','jobId','requestId','requestDigest','epoch','planDigest','payload']);
 if(o.action!==ACTION||o.version!==2||!PHASES.includes(o.phase as Phase)||!['request','response'].includes(String(o.type)))fail();
 hex(o.requestId,32);hex(o.requestDigest);const prepare=o.phase==='prepare';if(prepare){if(o.jobId!==null||o.planDigest!==null||o.epoch!==null)fail();}else{hex(o.jobId,32);hex(o.planDigest);if(o.phase==='begin'&&!response){if(o.epoch!==null)fail();}else if(o.epoch!==null){if(integer(o.epoch)<1)fail();}else if(!response||o.success!==false)fail();}
 if(response){bool(o.success);if(o.success===false){if(o.result!==null)fail();const e=exact(o.error,['code','class','retryable','recovery','retryAfterMillis']);text(e.code,40);const expected=new ResumeError(String(e.code)).wire();if(!['ACCOUNT_REQUIRED','ACCOUNT_MISMATCH','PEER_MISMATCH','AUTH_REVOKED','INVALID_FRAME','UNSUPPORTED_VERSION','UNSUPPORTED_PHASE','CAPABILITY_MISMATCH','REQUEST_CONFLICT','JOB_CONFLICT','OBJECT_CONFLICT','PLAN_CONFLICT','RECEIPT_CONFLICT','HASH_MISMATCH','STALE_EPOCH','BUSINESS_REJECTED','UNSUPPORTED_KIND','LIMIT_EXCEEDED','UNSUPPORTED_MODE','UNSUPPORTED_SCOPE','STORAGE_PRESSURE','LOCAL_IO','JOURNAL_CORRUPT','NOT_FOUND','EXPIRED','SOURCE_CHANGED','LEASE_EXPIRED','MANIFEST_INCOMPLETE','CHUNKS_MISSING','DEPENDENCIES_PENDING','WINDOW_FULL','BUSY','USER_CANCELLED','JOB_CANCELLED','RATE_LIMITED','UNSUPPORTED_SCOPE','UNSUPPORTED_MODE','PEER_IMPLEMENTATION_UNKNOWN','FLOW_CONTROL_VIOLATION','WATCH_UPGRADE_REQUIRED','PHONE_UPGRADE_REQUIRED'].includes(String(e.code))||['class','retryable','recovery'].some(k=>e[k]!==expected[k])||integer(e.retryAfterMillis,1000)<(e.recovery==='WAIT'?1:0)||e.recovery!=='WAIT'&&e.retryAfterMillis!==0)fail();}else successResult(o.phase as Phase,o.result);}else {row(o.payload);if(o.phase==='putChunk')fail();}
 return o as unknown as Envelope;
}

const JOB_STATES=['PLANNING','READY','TRANSFERRING','APPLIED','COMPLETE','CANCELLED'];
export function completionResult(value:unknown):Completion {
 const o=exact(value,['state','objectCount','receiptsRoot','ackToInclusive','completionDigest']);
 if(o.state!=='COMPLETE')fail();integer(o.objectCount,4096);hex(o.receiptsRoot);integer(o.ackToInclusive);hex(o.completionDigest);return o as unknown as Completion;
}
export function receiptResult(value:unknown):AppliedReceipt {
 const o=exact(value,['jobId','planDigest','objectId','applyRequestId','applyRequestDigest','receiverDeviceId','resultDigest','outcome']);
 hex(o.jobId,32);hex(o.planDigest);hex(o.objectId);hex(o.applyRequestId,32);hex(o.applyRequestDigest);text(o.receiverDeviceId,128);hex(o.resultDigest);if(typeof o.outcome!=='string'||!['merged','retainedLocal','alreadyPresent'].includes(o.outcome))fail();return o as unknown as AppliedReceipt;
}
/** Frozen phase schemas apply to every success, before a pending request can
 * observe it. Digest self-consistency is checked separately from schema. */
export function successResult(phase:Phase,value:unknown):Row {
 const o=row(value);
 const oneOf=(value:unknown,choices:readonly string[])=>{if(typeof value!=='string'||!choices.includes(value))fail();};
 const state=()=>oneOf(o.state,JOB_STATES);
 const completed=()=>{if(o.state==='COMPLETE')completionResult(o.completion);else if(o.completion!==null)fail();};
 switch(phase){
  case 'prepare':if(o.step==='offer'){exact(o,['step','watchCapabilities','watchSnapshot','offerDigest']);capability(o.watchCapabilities);snapshot(o.watchSnapshot);hex(o.offerDigest);}else{exact(o,['step','preparationDigest']);if(o.step!=='confirm')fail();hex(o.preparationDigest);}break;
  case 'begin':exact(o,['disposition','selectionDigest','state','expiresAtMillis','nextManifestPage','completion']);oneOf(o.disposition,['CREATED','RESUMED']);hex(o.selectionDigest);state();integer(o.expiresAtMillis);integer(o.nextManifestPage,4096);completed();break;
  case 'manifestPage':exact(o,['pageIndex','pageDigest','nextManifestPage','manifestVerified','state']);integer(o.pageIndex,4095);hex(o.pageDigest);if(integer(o.nextManifestPage,4096)<1||bool(o.manifestVerified)!==(o.state==='READY')||!['PLANNING','READY'].includes(o.state as string))fail();break;
  case 'missing':{
   exact(o,['state','nextManifestPage','expiresAtMillis','items','next','done','completion']);state();integer(o.nextManifestPage,4096);integer(o.expiresAtMillis);completed();let ranges=0;const ids:string[]=[];
   for(const raw of array(o.items,16)){const item=exact(raw,['objectId','state','missingRanges','receipt']);ids.push(hex(item.objectId));oneOf(item.state,['PENDING','PARTIAL','STAGED','APPLIED']);let last=-1;
    const rs=array(item.missingRanges,128);ranges+=rs.length;for(const raw of rs){const r=array(raw,2);if(r.length!==2)fail();const a=integer(r[0],255),b=integer(r[1],256);if(a>=b||a<last)fail();last=b;}
    if(['STAGED','APPLIED'].includes(String(item.state))&&rs.length)fail();if(item.state==='APPLIED'){if(receiptResult(item.receipt).objectId!==item.objectId)fail();}else if(item.receipt!==null)fail();
   }if(ids.some((id,i)=>i>0&&ids[i-1]!>=id)||ranges>128)fail();
   if(o.next!==null){const n=exact(o.next,['afterObjectId','afterChunkIndex']);hex(n.afterObjectId);if(n.afterChunkIndex!==null)integer(n.afterChunkIndex,256);}if(bool(o.done)!==(o.next===null))fail();if(['PLANNING','CANCELLED'].includes(String(o.state))&&((o.items as unknown[]).length||o.next!==null||!o.done))fail();break;
  }
  case 'putChunk':fail();
  case 'apply':exact(o,['state','receipt']);if(o.state!=='APPLIED')fail();receiptResult(o.receipt);break;
  case 'complete':completionResult(o);break;
  case 'cancel':exact(o,['state','alreadyComplete']);if(!['COMPLETE','CANCELLED'].includes(o.state as string)||bool(o.alreadyComplete)!==(o.state==='COMPLETE'))fail();break;
 }
 return o;
}
