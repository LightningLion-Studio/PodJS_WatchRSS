import {sha256Hex} from '@podjs/framework/crypto';
import {cpuJsonParse} from '@podjs/framework/cpu-work';
import {utf8Decode,utf8Encode} from '../cloud/types';
import {phoneNotePlainText} from './phone-text';
import type {MemoNote} from './types';
export const NOTES_STATE_OBJECT='notes-state.json';
export const NOTES_ASSETS_OBJECT='notes-assets.zip';
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
