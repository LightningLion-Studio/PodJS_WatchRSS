/** Executable wire boundary, frozen to sync-v2.md sections 3/14. This boundary
 * never fills optional fields or changes business IDs, clocks, or ancestry. */
import {sha256Hex} from '@podjs/framework/crypto';
import {validateRecord} from '../cloud/records';
import {recordFields} from '../cloud/compatibility';
import {validateBookShape,validateBookReading,bookIdInput,mergeBook,mergeBookReading} from '../books/protocol';
import {mergeNoteMarkdown} from '../notes/merge';
import {validateSet} from './note-conflict-set';
import {KINDS,canonical,jsonBytes,text,uint,exact,type Kind} from './protocol';
export {mergeBook,mergeBookReading,mergeNoteMarkdown};
const metaFields=new Set('articleId url title siteName excerpt imageUrl rssSourceUrl rssSourceTitle contentHash importedAt guid sourceUrl sourceId description siteUrl createdAt fingerprint chapterCount kind instanceId bookId articleIdHash chapterIndex noteId folderId name assetId mime originalFilename'.split(' '));
const fields:Record<Kind,readonly string[]>={...recordFields,
 note:'noteId folderId title markdown plainText contentHash baseContentHash baseMarkdown pinned createdAt updatedAt modifiedBy deleted deletedAt'.split(' '),
 folder:'folderId name sortOrder updatedAt modifiedBy deleted deletedAt'.split(' '),
 asset:'assetId mime originalFilename updatedAt sourceDeviceId deleted deletedAt'.split(' ')} as unknown as Record<Kind,readonly string[]>;
export const BUSINESS_FIELDS=Object.freeze(fields);
const clone=(value:any)=>JSON.parse(canonical(value));
/** Section 14 permits signed I53 sort orders. The legacy validator still checks
 * all field types, clocks and save-field coupling against a validation-only copy.
 * The original values are retained for v2 payloads; v13/v14 validators are unchanged. */
function bookReadingValidationInput(value:Record<string,any>){
 const checked={...value};for(const field of ['favoriteSortOrder','watchLaterSortOrder'])if(Object.hasOwn(value,field)){
  if(!Number.isSafeInteger(value[field])||Object.is(value[field],-0))throw Error('invalid_schema');
  checked[field]=0;
 }return checked;
}
export function toWire(kind:Kind,value:Record<string,any>){
 if(!KINDS.includes(kind)||!value||Object.getPrototypeOf(value)!==Object.prototype)throw Error('unsupported_feature');
 exact(value,Object.keys(value));if(Object.keys(value).some(k=>!fields[kind].includes(k)&&!(kind==='note'&&k==='noteConflicts')))throw Error('unsupported_feature');
 const noteConflicts=value.noteConflicts;const conflictChannel=kind==='note'&&Object.hasOwn(value,'noteConflicts');
 if(conflictChannel){validateSet(String(value.noteId),value.noteConflicts);value={...value};delete value.noteConflicts;}
 if('readingProgressMicros'in value)throw Error('invalid_schema');
 const checked=kind==='book-reading'?bookReadingValidationInput(value):value;
 if(['article','source','rss-state','book','book-reading'].includes(kind))validateRecord({kind,value:checked});
 if(kind==='note'||kind==='folder'||kind==='asset'){
  exact(value,fields[kind]);for(const [key,v]of Object.entries(value))if(!['folderId','pinned','deleted','sortOrder','updatedAt','createdAt','deletedAt'].includes(key)&&typeof v!=='string')throw Error('invalid_schema');
  if(kind==='note'&&value.folderId!==null)text(value.folderId);
  if(kind==='folder')text(value.folderId);if(kind==='asset'){text(value.mime,255);text(value.originalFilename,1024);}
 }
 if(kind==='book'){validateBookShape(value);if(sha256Hex(bookIdInput(value.fingerprint,value.instanceId))!==value.bookId)throw Error('book_sync_invalid');}if(kind==='book-reading')validateBookReading(checked);
 const meta:Record<string,any>={},state:Record<string,any>={};
 for(const [key,v]of Object.entries(value)){
  if(v===undefined)throw Error('invalid_schema');
  if(key==='readingProgress'){if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1)throw Error('invalid_schema');state.readingProgressMicros=Math.floor(v*1e6+.5);continue;}
  if(typeof v==='string')text(v,/^(url|guid|.*Url)$/.test(key)?8192:/^(title|name|description|excerpt|siteName|originalFilename|markdown|plainText|baseMarkdown)$/.test(key)?245760:1024);
  if(/(?:At|ChangedAt|Bytes|Clock)$/.test(key))uint(v);
  if(/SortOrder$/.test(key)||key==='sortOrder'){if(!Number.isSafeInteger(v)||Object.is(v,-0))throw Error('invalid_schema');}
  if(/Saved$/.test(key)||['isRead','isPinned','pinned','deleted','bookIndexRetired','rssIndexRetired','useOriginalContent','continuePlaybackInBackground'].includes(key)){if(typeof v!=='boolean')throw Error('invalid_schema');}
  (metaFields.has(key)?meta:state)[key]=v;
 }
 // Canonicalization rejects unsupported nested types and noninteger wire numbers.
 if(conflictChannel)state.noteConflicts=clone(noteConflicts);
 return {meta:clone(meta),state:clone(state)};
}
export function fromWire(kind:Kind,meta:Record<string,any>,state:Record<string,any>){
 if(Object.keys(meta).some(k=>!metaFields.has(k))||Object.keys(state).some(k=>metaFields.has(k)||Object.hasOwn(meta,k)))throw Error('invalid_schema');
 const value={...meta,...state};if(Object.hasOwn(value,'readingProgressMicros')){if(Object.hasOwn(value,'readingProgress'))throw Error('invalid_schema');uint(value.readingProgressMicros,1000000);value.readingProgress=value.readingProgressMicros/1000000;delete value.readingProgressMicros;}
 toWire(kind,value);return value;
}
export function candidates(kind:Kind,logicalId:string,entityKey:string,value:Record<string,any>,addedAtMillis?:number){
 text(logicalId);const wire=toWire(kind,value);if(addedAtMillis!==undefined)uint(addedAtMillis);
 const meta={version:2,entityKey,kind,logicalId,addedAtSource:addedAtMillis===undefined?'unknown':'original',requiredFeatures:[],payload:wire.meta};
 const state={version:2,entityKey,requiredFeatures:kind==='note'&&Object.hasOwn(wire.state,'noteConflicts')?['note-conflicts.v1']:[],payload:wire.state,noteSegments:[]};
 const metaBytes=jsonBytes(meta),stateBytes=jsonBytes(state);if(metaBytes.length>262144||stateBytes.length>262144)throw Error('object_too_large');
 return {meta,state,addedAtMillis:addedAtMillis??0,metaBytes:metaBytes.length,stateBytes:stateBytes.length};
}
