import {lengthPrefix,sha256Hex} from '@podjs/framework/crypto';
import type {MemoNote} from '../notes/types';
export interface NoteManifest {noteId:string;contentHash:string;updatedAt:number;deleted:boolean;deletedAt:number;stateHash?:string}
export function noteManifest(note:MemoNote):NoteManifest {
 const stateHash=sha256Hex(lengthPrefix('watchrss/note-state/v2',note.noteId,note.folderId===null?'0':'1',note.folderId??'',note.title,note.contentHash,note.baseContentHash,note.pinned?'1':'0',note.createdAt,note.updatedAt,note.modifiedBy,note.deleted?'1':'0',note.deletedAt));
 return {noteId:note.noteId,contentHash:note.contentHash,updatedAt:note.updatedAt,deleted:note.deleted,deletedAt:note.deletedAt,stateHash};
}
export function parseNoteManifest(input:unknown):NoteManifest[]{
 if(!Array.isArray(input))throw Error('Invalid note manifest');const seen=new Set<string>();
 return input.map(value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid note manifest row');
  const r=value as NoteManifest;
  if(typeof r.noteId!=='string'||!r.noteId||seen.has(r.noteId)||typeof r.contentHash!=='string'||!Number.isSafeInteger(r.updatedAt)||r.updatedAt<0||typeof r.deleted!=='boolean'||!Number.isSafeInteger(r.deletedAt)||r.deletedAt<0||r.stateHash!==undefined&&(typeof r.stateHash!=='string'||! /^[a-f0-9]{64}$/.test(r.stateHash)))throw Error('Invalid note manifest row');
  seen.add(r.noteId);return {noteId:r.noteId,contentHash:r.contentHash,updatedAt:r.updatedAt,deleted:r.deleted,deletedAt:r.deletedAt,...(r.stateHash===undefined?{}:{stateHash:r.stateHash})};
 });
}
export function sameNoteState(a:NoteManifest,b:NoteManifest|undefined){return !!b&&!!a.stateHash&&a.stateHash===b.stateHash&&a.contentHash===b.contentHash&&a.updatedAt===b.updatedAt&&a.deleted===b.deleted&&a.deletedAt===b.deletedAt;}
