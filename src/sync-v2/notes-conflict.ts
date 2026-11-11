import {choiceCurrent} from './state';
/** rc6a note-conflict wire and atomic resolution model. No product or network IO. */
import {canonical,jsonBytes as jb,bytes as utf8} from './protocol';
import {sha256Hex} from '@podjs/framework/crypto';
const c={canonical,jb};
const clone=<T>(v:T):T=>JSON.parse(canonical(v));
import {mergeNoteMarkdown} from '../notes/merge';
import {segmentedClosureBudget} from './note-segments';
import * as s from './notes-strict';
import {feature,text,validateSet,conflictSet,mergeConflicts,openConflicts} from './note-conflict-set.ts';
import type {Conflict,ConflictSet} from './note-conflict-set.ts';
export {feature,validateSet,conflictSet,mergeConflicts,openConflicts,conflictTexts} from './note-conflict-set.ts';
export type {Conflict,ConflictSet} from './note-conflict-set.ts';
const fail=(code:string):never=>{throw Error(code);};
const fields=['conflictId','noteId','baseMarkdown','localMarkdown','remoteMarkdown','remoteDeviceId','createdAt','resolvedAt'];
/** W2/F6: for edit detection and reseal decisions an empty conflict container
 * `{version:1,records:[]}` equals its absence. Only comparisons use this view;
 * the received or local wire form is never rewritten by it. */
export function conflictNeutral(state:any){
 const v=state?.payload?.noteConflicts;
 if(!v||typeof v!=='object'||v.version!==1||!Array.isArray(v.records)||v.records.length||Object.keys(v).length!==2)return state;
 const payload={...state.payload};delete payload.noteConflicts;
 return {...state,requiredFeatures:state.requiredFeatures.filter((f:string)=>f!==feature),payload};
}
/** This preserves the existing creation algorithm; migrated IDs remain opaque. */
/** R2: digest of the conflict-neutral note model compared for local edits of a
 * candidate or decoded row (the edit-base shape). */
export const noteEditDigest=(r:any)=>sha256Hex(jb({identity:r.meta.logicalId,...r.meta.payload,...conflictNeutral(r.state).payload}));
export function newConflictId(noteId:string,base:string,local:string,remote:string,device:string){
 for(const v of [noteId,base,local,remote,device])c.canonical(v);
 return sha256Hex(utf8([noteId,base,local,remote,device].join('\0')));
}
/** Only a legacy importer may map absent resolvedAt to zero. Wire may not. */
export function importLegacy(client:'watch'|'phone'|'mini',noteId:string,rows:any[]):ConflictSet{
 if(!Array.isArray(rows)||!['watch','phone','mini'].includes(client))fail('invalid_schema');
 const records=rows.map(row=>{
  if(client==='watch'){
   s.exact(row,['conflict_id','note_id','base_markdown','local_markdown','remote_markdown','remote_device_id','created_at']);
   return {conflictId:row.conflict_id,noteId:row.note_id,baseMarkdown:row.base_markdown,localMarkdown:row.local_markdown,remoteMarkdown:row.remote_markdown,remoteDeviceId:row.remote_device_id,createdAt:row.created_at,resolvedAt:0};
  }
  if(client==='phone'||Object.hasOwn(row,'resolvedAt'))s.exact(row,fields);else s.exact(row,fields.filter(x=>x!=='resolvedAt'));
  return {...row,...(!Object.hasOwn(row,'resolvedAt')?{resolvedAt:0}:{})};
 });return conflictSet(noteId,records);
}
function holder(state:any){
 if(!state.payload||Object.getPrototypeOf(state.payload)!==Object.prototype||Object.hasOwn(state.payload,'segmentOf'))fail('invalid_schema');
 if(state.payload.segmentedNote===true){if(!state.payload.metadata||Object.getPrototypeOf(state.payload.metadata)!==Object.prototype||Object.hasOwn(state.payload,'noteConflicts'))fail('invalid_schema');return state.payload.metadata;}
 return state.payload;
}
function outer(state:any,context:{entityKey:string;noteId:string}){
 s.exact(state,['version','entityKey','requiredFeatures','payload','noteSegments']);s.hexBytes(context.entityKey,32);text(context.noteId,1024,true);
 if(state.version!==2||state.entityKey!==context.entityKey||!Array.isArray(state.requiredFeatures)||state.requiredFeatures.length>32||!Array.isArray(state.noteSegments)||state.noteSegments.length>2048)fail('invalid_schema');
 let previous='';for(const f of state.requiredFeatures){if(typeof f!=='string'||!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(f)||f<=previous)fail('invalid_schema');previous=f;}
 for(const oid of state.noteSegments)s.objectOid(oid,'state');
 const p=state.payload,segmented=p?.segmentedNote===true,declared=state.requiredFeatures.includes('note-segments.v1');
 if(!p||Object.getPrototypeOf(p)!==Object.prototype||(Object.hasOwn(p,'segmentedNote')&&!segmented)||segmented!==declared)fail('invalid_schema');
 if(segmented){
  s.exact(p,['segmentedNote','noteRevision','segmentCount','plaintextSha256','metadata']);
  if(typeof p.noteRevision!=='string'||!/^[a-f0-9]{32}$/.test(p.noteRevision)||typeof p.plaintextSha256!=='string'||!/^[a-f0-9]{64}$/.test(p.plaintextSha256)||!p.metadata||Object.getPrototypeOf(p.metadata)!==Object.prototype||s.uint(p.segmentCount,2048)<1||p.segmentCount!==state.noteSegments.length||new Set(state.noteSegments).size!==state.noteSegments.length)fail('invalid_schema');
 }else if(state.noteSegments.length)fail('invalid_schema');
 // Only wire roots are size-bound here. A reassembled long note (rc7 S0) is an
 // ordinary business record above L; its encoder enforces every wire limit.
 if(segmented&&c.jb(state).length>262144)fail('object_too_large');
}
export function attachConflicts(state:any,context:{entityKey:string;noteId:string},value:ConflictSet){
 validateSet(context.noteId,value);outer(state,context);const next=clone(state),target=holder(next);
 if(Object.hasOwn(target,'noteConflicts')||next.requiredFeatures.includes(feature))fail('invalid_schema');
 target.noteConflicts=clone(value);next.requiredFeatures=[...next.requiredFeatures,feature].sort();readConflicts(next,context);if(c.jb(next).length>262144)fail('object_too_large');return next;
}
/** null means no conflict channel, NOT an authoritative empty table. */
export function readConflicts(state:any,context:{entityKey:string;noteId:string},supported=[feature,'note-segments.v1']):ConflictSet|null{
 outer(state,context);const target=holder(state);if(state.requiredFeatures.some((f:string)=>!supported.includes(f)))fail('unsupported_feature');
 if(!state.requiredFeatures.includes(feature)){if(Object.hasOwn(target,'noteConflicts'))fail('invalid_schema');return null;}
 if(!Object.hasOwn(target,'noteConflicts'))fail('invalid_schema');validateSet(context.noteId,target.noteConflicts);return clone(target.noteConflicts);
}
/** An existing open incident blocks automatic merge even if current text is disjoint. */
export function mergeNoteWithConflicts(noteId:string,base:string,local:string,remote:string,known:ConflictSet[]){
 for(const set of known){validateSet(noteId,set);if(openConflicts(set).length)return {conflict:true};}
 const out=mergeNoteMarkdown(base,local,remote);return out===null?{conflict:true}:{markdown:out};
}
/** Materialize the complete minimal-model short-note state before committing.
 * The fixed-width entityKey is a size witness only, never a publication identity.
 * Production adapters must encode their full business state and every segment.
 */
export function noteResolutionBudget(before:any,next:any){
 const payload:any={};for(const [key,value]of Object.entries(next.note))if(!['noteId','title','folderId','createdAt'].includes(key))payload[key]=clone(value);
 const context={entityKey:Object.hasOwn(next,'entityKey')?next.entityKey:'0'.repeat(64),noteId:next.note.noteId};
 const add=(a:number,b:number)=>{const sum=BigInt(a)+BigInt(b);if(sum>BigInt(Number.MAX_SAFE_INTEGER))fail('object_too_large');return Number(sum);};
 const widest={repoId:'0'.repeat(32),libraryEpoch:'18446744073709551615',contentGeneration:'18446744073709551615'};
 // Identity encoding and the maximum AAD/frame overhead bound compression too.
 const rootRefsBytesUpperBound=c.jb({body:{scope:widest,stateOid:'state:sha256:'+'0'.repeat(64),segmentOids:[]},signature:'A'.repeat(86)}).length;
 const base={version:2,entityKey:context.entityKey,requiredFeatures:[],payload,noteSegments:[]};let root:any,rootPlainBytes:number,closureStoredBytes:number;
 try{root=attachConflicts(base,context,next.conflicts);rootPlainBytes=c.jb(root).length;closureStoredBytes=add(rootPlainBytes,4120+rootRefsBytesUpperBound);}
 catch(error){
  if((error as Error).message!=='object_too_large')throw error;
  // rc7 25.6: a long final note is charged as parent, every segment and every
  // refs table. The conflict container stays in M and is never segmented.
  validateSet(context.noteId,next.conflicts);root={...base,requiredFeatures:[feature],payload:{...payload,noteConflicts:clone(next.conflicts)}};rootPlainBytes=c.jb(root).length;
  closureStoredBytes=segmentedClosureBudget(root,'0'.repeat(32),widest)!.bytes;
 }const closures=Object.hasOwn(next,'resolutionClosures')?next.resolutionClosures:[];
 if(!Array.isArray(closures))fail('invalid_schema');const seen=new Map<string,number>();
 for(const object of closures){s.exact(object,['oid','storedBytes']);if(typeof object.oid!=='string'||!/^(meta|state|blob|recipe|tree|state-refs|recipe-refs):sha256:[a-f0-9]{64}$/.test(object.oid))fail('invalid_schema');s.uint(object.storedBytes);if(seen.has(object.oid)){if(seen.get(object.oid)!==object.storedBytes)fail('closure_incomplete');continue;}seen.set(object.oid,object.storedBytes);closureStoredBytes=add(closureStoredBytes,object.storedBytes);}
 if(Object.hasOwn(next,'resolutionBodyClosuresReady')&&typeof next.resolutionBodyClosuresReady!=='boolean')fail('invalid_schema');if(next.resolutionBodyClosuresReady===false)fail('closure_incomplete');
 // Old and new journal images plus framing and pointer/intent scratch coexist.
 const journalWorstBytes=add(add(c.jb(before).length,c.jb(next).length),8752),requiredBytes=add(closureStoredBytes,journalWorstBytes);
 if(Object.hasOwn(next,'resolutionAvailableBytes')){s.uint(next.resolutionAvailableBytes);if(requiredBytes>next.resolutionAvailableBytes)fail('storage_pressure');}
 return {root,rootPlainBytes,rootStoredBytesUpperBound:rootPlainBytes+4120,rootRefsBytesUpperBound,closureStoredBytes,journalWorstBytes,requiredBytes};
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;}
function immutableData(value:any){if(!value||typeof value!=='object'||!Object.isFrozen(value)||Object.values(Object.getOwnPropertyDescriptors(value)).some((d:any)=>!Object.hasOwn(d,'value')))fail('choice_stale');for(const v of Object.values(value))if(v&&typeof v==='object')immutableData(v);}
/** Pure candidate planner. The SQL adapter supplies the final business codec,
 * authenticated closure, physical reservation and atomic storage CAS. */
export class NoteConflictPlan {
 state:any;
 constructor(saved:any){this.state=clone(saved);}
 private guardSync(token?:any){
  const st=this.state;try{
   s.exact(st.account,['oid','revision','generation']);s.objectOid(st.account.oid,'commit');if(s.d64(st.account.revision)<1n)throw Error();s.d64(st.account.generation);s.d64(st.rollbackGeneration);s.d64(st.stateVersion);s.d64(st.localChangeRevision);
   if(st.account.generation!==st.rollbackGeneration||st.editBase.generation!==st.account.generation)throw Error();s.objectOid(st.editBase.accountOid,'commit');
   for(const [key,value]of [['lastSeenAccountOid',st.account.oid],['lastSeenAccountRevision',st.account.revision],['lastSeen',st.account.generation]])if(Object.hasOwn(st,key)&&st[key]!==value)throw Error();
   if(token){s.capture(token);immutableData(token);
    if(token.generation!==st.account.generation||!choiceCurrent(st,token))throw Error();}
  }catch{fail('choice_stale');}
  if(st.pendingChoice!==null)fail('choice_pending');
 }
 capture(){
  this.guardSync();const st=this.state;validateSet(st.note.noteId,st.conflicts);s.uint(st.note.updatedAt);const open=openConflicts(st.conflicts);if(st.note.deleted||!open.length)fail('notes_stale');
  return freeze({sync:{stateVersion:st.stateVersion,accountOid:st.account.oid,accountRevision:st.account.revision,generation:st.account.generation,localChangeRevision:st.localChangeRevision},noteId:st.note.noteId,expectedUpdatedAt:st.note.updatedAt,selectedConflictId:open[0]!.conflictId,openConflictIds:open.map(r=>r.conflictId).sort()});
 }
 private guard(capture:any){
  try{s.exact(capture,['sync','noteId','expectedUpdatedAt','selectedConflictId','openConflictIds']);s.exact(capture.sync,['stateVersion','accountOid','accountRevision','generation','localChangeRevision']);immutableData(capture);}catch{fail('choice_stale');}
  this.guardSync(capture.sync);const st=this.state;validateSet(st.note.noteId,st.conflicts);const open=openConflicts(st.conflicts);
  if(st.note.deleted||st.note.noteId!==capture.noteId||st.note.updatedAt!==capture.expectedUpdatedAt||open[0]?.conflictId!==capture.selectedConflictId||c.canonical(open.map(r=>r.conflictId).sort())!==c.canonical(capture.openConflictIds))fail('notes_stale');
 }
 /** Guard before preparation AND before atomic replacement. Hook models a race/crash. */
 resolve(capture:any,choice:'local'|'remote'|'manual',manual:string|null,now:number,device:string,hook?:(budget:ReturnType<typeof noteResolutionBudget>)=>void){
  this.guard(capture);s.uint(now);text(device,1024);if(!['local','remote','manual'].includes(choice)||(choice!=='manual'&&manual!==null))fail('invalid_schema');
  const next=clone(this.state),note=next.note,selected=next.conflicts.records.find((r:Conflict)=>r.conflictId===capture.selectedConflictId);
  if(note.updatedAt===Number.MAX_SAFE_INTEGER)fail('counter_exhausted');
  const markdown=choice==='local'?note.markdown:(choice==='remote'?selected.remoteMarkdown:manual);
  text(markdown,Number.MAX_SAFE_INTEGER); // rc7: the final candidate budget bounds the body.
  const body=choice==='local'?markdown:markdown.replace(/\r\n?/g,'\n');
  Object.assign(note,{markdown:body,baseMarkdown:body,contentHash:sha256Hex(utf8(body)),baseContentHash:sha256Hex(utf8(body)),updatedAt:Math.max(now,note.updatedAt+1),modifiedBy:device});
  for(const r of next.conflicts.records)if(capture.openConflictIds.includes(r.conflictId))r.resolvedAt=Math.max(1,now);
  next.stateVersion=s.nextD64(next.stateVersion);next.localChangeRevision=s.nextD64(next.localChangeRevision);
  next.outbox.push({kind:'note-resolution',noteId:note.noteId,resolvedConflictIds:[...capture.openConflictIds]});
  const budget=noteResolutionBudget(this.state,next); // Mandatory, after marker/hash/counter growth.
  if(hook)hook(budget);this.guard(capture);this.state=next;
  return {choice,markdown:body,baseMarkdown:body,updatedAt:note.updatedAt,resolvedConflictIds:[...capture.openConflictIds]};
 }
}
