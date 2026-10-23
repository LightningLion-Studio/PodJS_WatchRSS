import {noteManifest,parseNoteManifest,sameNoteState} from './note-manifest';
import {memoPlainText,type MemoNote} from '../notes/index.ts';
import {wireFields} from './article-batches.ts';
import type {JsonObject} from './protocol.ts';
const {string,optLong,bool}=wireFields;
export interface NoteSyncRepository {initialize():Promise<void>;merge(notes:readonly MemoNote[]):Promise<number>;allIncludingDeleted():Promise<MemoNote[]>}
/** Matches WatchNoteSyncPayload v1. Parse the entire request before applying any rows. */
export function parseSyncedNotes(request:JsonObject):MemoNote[]{
 if(!Array.isArray(request.notes))return [];
 return request.notes.map(value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('笔记载荷必须为对象');
  const j=value as JsonObject;if(typeof j.noteId!=='string')throw new Error('缺少笔记 ID');
  const markdown=string(j.markdown);
  return {noteId:j.noteId,folderId:j.folderId==null?null:string(j.folderId),title:string(j.title),markdown,plainText:memoPlainText(markdown),contentHash:string(j.contentHash),baseContentHash:string(j.baseContentHash),baseMarkdown:string(j.baseMarkdown),pinned:bool(j.pinned),createdAt:optLong(j.createdAt),updatedAt:optLong(j.updatedAt),modifiedBy:string(j.modifiedBy),deleted:bool(j.deleted),deletedAt:optLong(j.deletedAt)};
 });
}
export async function syncNotes(request:JsonObject,repository:NoteSyncRepository,deviceId:()=>Promise<string>):Promise<JsonObject>{
 const phase=request.phase;if(phase!==undefined&&!['manifest','delta'].includes(String(phase)))throw Error('Invalid note sync phase');
 const remote=phase===undefined?undefined:parseNoteManifest(request.noteManifest);
 const incoming=parseSyncedNotes(request);if(phase==='manifest'&&incoming.length)throw Error('Manifest contains note bodies');
 await repository.initialize();
 if(phase==='manifest')return {success:true,action:'syncNotes',version:1,phase,deviceId:await deviceId(),noteManifest:(await repository.allIncludingDeleted()).map(noteManifest)};
 const applied=await repository.merge(incoming);
 const byId=new Map(remote?.map(r=>[r.noteId,r]));
 const notes=(await repository.allIncludingDeleted()).filter(note=>!remote||!sameNoteState(noteManifest(note),byId.get(note.noteId))).map(({plainText,...wire})=>wire);
 return {success:true,action:'syncNotes',version:1,deviceId:await deviceId(),applied,notes,...(phase?{phase}:{})};
}
