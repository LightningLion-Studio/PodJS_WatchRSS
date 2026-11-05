/** rc6c planner; frozen field mergers remain the only business algorithms. */
import * as strict from './notes-strict';
import * as noteConflicts from './note-conflict-set';
import {canonical,compareD64,checkD64} from './protocol';
import {mergeBook} from '../books/protocol';
import {mergeNoteMarkdown} from '../notes/merge';
const clone=<T>(v:T):T=>JSON.parse(canonical(v));
const markdown=(base:string,local:string,remote:string)=>{const out=mergeNoteMarkdown(base,local,remote);return out===null?{conflict:true}:{markdown:out};};
export function canMerge(input:any){
 if(input.unsupported)return {canMerge:false,reason:'unsupported_feature'};
 if(input.spaceAvailable===false)return {canMerge:false,reason:'storage_pressure'};
 const cloud=clone(input.cloud),base=input.base,local=input.local;
 const no=(reason:string)=>({canMerge:false,reason});
 // Inspect complete snapshots, not only edited fields or op IDs. A local-only
 // conflict must never disappear merely because the candidate starts at cloud.
 const incidents=new Map<string,noteConflicts.ConflictSet>();
 const allIds=new Set([...Object.keys(base),...Object.keys(local),...Object.keys(cloud)]);
 for(const id of allIds){
  const rows=[base[id],local[id],cloud[id]],present=rows.filter(row=>row&&Object.hasOwn(row,'noteConflicts'));
  if(!present.length)continue;
  const noteId=present[0].identity;
  if(rows.some(row=>row&&row.identity!==noteId))return no('identity_conflict');
  try{for(const row of present){if(row.identity!==noteId)throw Error();noteConflicts.validateSet(noteId,row.noteConflicts);}}catch{return no('unsupported_feature');}
  if(present.some(row=>noteConflicts.openConflicts(row.noteConflicts).length))return no('note_conflict');
  if(present.some(row=>row.noteConflicts.records.length)){
   // A caller cannot silently union future resolution markers into a rollback.
   // Empty legacy text-only inputs retain their old contract; records require
   // explicit authenticated generation provenance for all three snapshots.
   try{strict.exact(input.noteConflictGenerations,['base','local','cloud']);for(const generation of Object.values(input.noteConflictGenerations))strict.d64(generation);}catch{return no('missing_base');}
   const g=input.noteConflictGenerations;if(g.base!==g.local||g.local!==g.cloud)return no('note_conflict');
  }
  try{let union=noteConflicts.conflictSet(noteId,[]);for(const row of present)union=noteConflicts.mergeConflicts(noteId,union,row.noteConflicts);incidents.set(id,union);}catch{return no('identity_conflict');}
 }
 const withoutIncidents=(row:any)=>{const copy={...row};delete copy.noteConflicts;return copy;};
 for(const op of input.ops){
  const id=op.id,b=base[id],l=local[id],c=cloud[id];
  if(!['create','update','delete','explicit-restore'].includes(op.kind))return no('unsupported_feature');
  if(!op.complete)return no('missing_content');
  if(op.kind==='create'){
   if(!l)return no('missing_content');if(c&&canonical(withoutIncidents(c))!==canonical(withoutIncidents(l)))return no('identity_conflict');cloud[id]=clone(l);continue;
  }
  if(!b)return no('missing_base');
  if(op.kind==='explicit-restore'){
   if(!l||!l.lifecycle||!c||!c.bookId)return no('delete_edit_conflict');
   if(l.lifecycle.generation<=(b.lifecycle?.generation??0))return no('delete_edit_conflict');
   try{cloud[id]=mergeBook(c,l);}catch{return no('identity_conflict');}continue;
  }
  if(!c||c.deleted){if(op.kind==='delete')continue;return no('delete_edit_conflict');}
  if(op.kind==='delete'){
   if(canonical(c)!==canonical(b))return no('delete_edit_conflict');cloud[id]={...c,deleted:true};continue;
  }
  if(!l)return no('missing_content');
  if(c.identity!==b.identity||l.identity!==b.identity)return no('identity_conflict');
  for(const field of op.fields){
   if(field==='noteConflicts')continue; // The set has one merge path, never LWW.
   if(!(field in b)||!(field in l))return no('missing_base');
   if(field==='markdown'){
    const result=markdown(b[field],l[field],c[field]);if('conflict'in result)return no('note_conflict');cloud[id][field]=result.markdown;
   }else if(canonical(c[field])===canonical(b[field])||canonical(c[field])===canonical(l[field]))cloud[id][field]=l[field];
   else return no('identity_conflict');
  }
 }
 for(const [id,records]of incidents){if(!cloud[id]){if(records.records.length)return no('missing_content');continue;}cloud[id].noteConflicts=records;}
 return {canMerge:true,tree:cloud};
}
export function detectRollback(seen:string,current:string,dirty:boolean,persisted:any={}){
 checkD64(seen);checkD64(current);if(compareD64(current,seen)<0)return 'replay_detected';
 if(persisted.awaitingUser||persisted.pendingChoice)return 'awaiting-user';
 if(persisted.baseGeneration!==undefined&&dirty&&compareD64(checkD64(persisted.baseGeneration),current)<0)return 'awaiting-user';
 if(compareD64(current,seen)>0)return dirty?'awaiting-user':'follow-cloud';return 'normal';
}
