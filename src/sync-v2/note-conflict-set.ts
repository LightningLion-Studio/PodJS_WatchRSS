/** Shared acyclic note-conflict validation/union for planner and journal. */
import * as s from './notes-strict';
import {bytes,canonical} from './protocol';
const clone=<T>(v:T):T=>JSON.parse(canonical(v));
export const feature='note-conflicts.v1';
export type Conflict={conflictId:string;noteId:string;baseMarkdown:string;localMarkdown:string;remoteMarkdown:string;remoteDeviceId:string;createdAt:number;resolvedAt:number};
export type ConflictSet={version:1;records:Conflict[]};
const fields=['conflictId','noteId','baseMarkdown','localMarkdown','remoteMarkdown','remoteDeviceId','createdAt','resolvedAt'];
const immutable=['noteId','baseMarkdown','localMarkdown','remoteMarkdown','remoteDeviceId'];
const fail=(code:string):never=>{throw Error(code);};
export function text(value:any,max:number,nonempty=false){if(typeof value!=='string')fail('invalid_schema');for(const scalar of value){const cp=scalar.codePointAt(0)!;if(cp>=0xd800&&cp<=0xdfff)fail('invalid_encoding');}if(bytes(value).length>max||(nonempty&&!value.length))fail('invalid_schema');}
function record(noteId:string,r:any){s.exact(r,fields);text(noteId,1024,true);text(r.conflictId,1024,true);text(r.noteId,1024,true);if(r.noteId!==noteId)fail('invalid_schema');for(const key of ['baseMarkdown','localMarkdown','remoteMarkdown'])text(r[key],245760);text(r.remoteDeviceId,1024);s.uint(r.createdAt);s.uint(r.resolvedAt);}
/** Producers sort; consumers require that order and reject duplicate keys. */
export function conflictSet(noteId:string,records:Conflict[]):ConflictSet{
 if(!Array.isArray(records)||records.length>1024)fail('invalid_schema');
 for(const r of records)record(noteId,r);
 const value={version:1 as const,records:clone(records).sort((a,b)=>a.conflictId<b.conflictId?-1:a.conflictId>b.conflictId?1:0)};validateSet(noteId,value);return value;
}
export function validateSet(noteId:string,value:any):asserts value is ConflictSet{
 text(noteId,1024,true);s.exact(value,['version','records']);if(value.version!==1||!Array.isArray(value.records)||value.records.length>1024)fail('invalid_schema');
 let previous:string|undefined;for(const r of value.records){record(noteId,r);if(previous!==undefined&&previous>=r.conflictId)fail('invalid_schema');previous=r.conflictId;}
}
/** Same authenticated account generation only. Rollback selection is external. */
export function mergeConflicts(noteId:string,a:ConflictSet,b:ConflictSet):ConflictSet{
 validateSet(noteId,a);validateSet(noteId,b);const records=new Map<string,Conflict>();
 for(const r of [...a.records,...b.records]){
  const prior=records.get(r.conflictId);if(prior){if(immutable.some(key=>prior[key as keyof Conflict]!==r[key as keyof Conflict]))fail('conflict_identity_mismatch');records.set(r.conflictId,{...prior,createdAt:Math.min(prior.createdAt,r.createdAt),resolvedAt:Math.max(prior.resolvedAt,r.resolvedAt)});}else records.set(r.conflictId,clone(r));
 }return conflictSet(noteId,[...records.values()]);
}
export function openConflicts(value:ConflictSet){return value.records.filter(r=>r.resolvedAt===0).sort((a,b)=>b.createdAt-a.createdAt||(a.conflictId<b.conflictId?-1:a.conflictId>b.conflictId?1:0));}
/** GC must scan resolved rows too; hydration can prioritize unresolved rows. */
export function conflictTexts(value:ConflictSet){return value.records.flatMap(r=>[r.baseMarkdown,r.localMarkdown,r.remoteMarkdown]);}
