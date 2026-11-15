import {sha256Hex} from '@podjs/framework/crypto';
import {cpuJsonParse,cpuJsonStringify,cpuSort} from '@podjs/framework/cpu-work';
import {utf8Decode,utf8Encode} from '../cloud/types';
import {phoneNotePlainText} from './phone-text';
import type {MemoNote} from './types';
export const NOTES_STATE_OBJECT='notes-state.json';
export const NOTES_ASSETS_OBJECT='notes-assets.zip';
/** Exact NoteCloudStateCodec v1 fields. A publication is not an edit ACK:
 * in particular baseMarkdown/baseContentHash must not advance here. */
export function encodeNoteCloudState(notes:readonly MemoNote[]):Uint8Array{
 for(const n of notes)if(!n.noteId||n.noteId.length>512||['__proto__','constructor','prototype'].includes(n.noteId))throw Error('cloud_note_path_invalid');
 return utf8Encode(cpuJsonStringify({format:'watchrss-notes',version:1,notes:cpuSort([...notes],(a,b)=>a.noteId<b.noteId?-1:a.noteId>b.noteId?1:0).map(n=>({id:n.noteId,folder:n.folderId,title:n.title,markdown:n.markdown,hash:n.contentHash,base:n.baseMarkdown,updatedAt:n.updatedAt,modifiedBy:n.modifiedBy,pinned:n.pinned,deleted:n.deleted,deletedAt:n.deletedAt,createdAt:n.createdAt}))}));
}
/** Byte-compatible with phone MarkdownNoteCodec.export. */
export function exportNoteMarkdown(n:MemoNote){return utf8Encode('---\nwatchrss-note: 1\nid: '+n.noteId+'\n'+(n.folderId===null?'':'folder: '+n.folderId+'\n')+'created-at: '+n.createdAt+'\nupdated-at: '+n.updatedAt+'\n---\n'+n.markdown+(n.markdown.endsWith('\n')?'':'\n'));}
/** Phone MarkdownNoteArchive.safePath, including opaque imported note IDs. */
export function noteMarkdownPath(id:string){
 if(!id||id.length>512||['__proto__','constructor','prototype'].includes(id))throw Error('cloud_note_path_invalid');
 const parts=('notes/'+id+'.md').replaceAll('\\','/').split('/').filter(Boolean);
 if(parts.some(p=>p==='.'||p==='..'||p.includes('\0')))throw Error('cloud_note_path_invalid');return parts.join('/');
}
/** Phone NoteCloudStateCodec v1. Hash and edit ancestry are wire values,
 * never replaced by a timestamp comparison or a locally acknowledged base. */
export function decodeNoteCloudState(bytes:Uint8Array):MemoNote[]{
 const root=cpuJsonParse(utf8Decode(bytes));
 if(!root||root.format!=='watchrss-notes'||root.version!==1||!Array.isArray(root.notes)||root.features)throw Error('cloud_format_notes_unsupported');
 const seen=new Set<string>();
 return root.notes.map((n:any)=>{
  if(!n||typeof n.id!=='string'||!n.id||seen.has(n.id))throw Error('cloud_format_notes_invalid');seen.add(n.id);
  const string=(key:string)=>{const value=n[key];if(value==null)return '';if(typeof value!=='string')throw Error('cloud_format_notes_invalid');return value;};
  const number=(key:string)=>{const value=n[key]??0;if(!Number.isSafeInteger(value)||value<0)throw Error('cloud_format_notes_invalid');return value;};
  const boolean=(key:string)=>{const value=n[key]??false;if(typeof value!=='boolean')throw Error('cloud_format_notes_invalid');return value;};
  const markdown=string('markdown'),base=string('base');
  return {noteId:n.id,folderId:n.folder==null?null:string('folder'),title:string('title'),markdown,plainText:phoneNotePlainText(markdown),contentHash:string('hash'),baseContentHash:sha256Hex(utf8Encode(base)),baseMarkdown:base,pinned:boolean('pinned'),createdAt:number('createdAt'),updatedAt:number('updatedAt'),modifiedBy:string('modifiedBy'),deleted:boolean('deleted'),deletedAt:number('deletedAt')};
 });
}
