/** Executable wire boundary, frozen to sync-v2.md sections 3/14. This boundary
 * never fills optional fields or changes business IDs, clocks, or ancestry. */
import {sha256Hex} from '@podjs/framework/crypto';
import {validateRecord} from '../cloud/records';
import {ARTICLE_REGISTER_FEATURE} from '../cloud/article-register';
import {recordFields} from '../cloud/compatibility';
import {validateBookShape,validateBookReading,bookIdInput,mergeBook,mergeBookReading} from '../books/protocol';
import {mergeNoteMarkdown} from '../notes/merge';
import {validateSet} from './note-conflict-set';
import {KINDS,canonical,jsonBytes,text,uint,exact,type Kind} from './protocol';
import {NOTE_TEXT_FIELDS,NOTE_TEXT_BUDGET,encodeNote,splitOrdinary} from './note-segments';
export {mergeBook,mergeBookReading,mergeNoteMarkdown};
const metaFields=new Set('articleId url title siteName excerpt imageUrl rssSourceUrl rssSourceTitle contentHash importedAt guid sourceUrl sourceId description siteUrl createdAt fingerprint chapterCount kind instanceId bookId articleIdHash chapterIndex noteId folderId name assetId mime originalFilename'.split(' '));
const fields:Record<Kind,readonly string[]>={...recordFields,
 note:'noteId folderId title markdown plainText contentHash baseContentHash baseMarkdown pinned createdAt updatedAt modifiedBy deleted deletedAt'.split(' '),
 folder:'folderId name sortOrder updatedAt modifiedBy deleted deletedAt'.split(' '),
 asset:'assetId mime originalFilename updatedAt sourceDeviceId deleted deletedAt'.split(' ')} as unknown as Record<Kind,readonly string[]>;
export const BUSINESS_FIELDS=Object.freeze(fields);
const clone=(value:any)=>JSON.parse(canonical(value));
/** rc7 25.2 freezes MemoNote contentHash as non-text state (M). Older rows that
 * carried it in meta remain readable; new candidates write it to state. */
const noteState=(kind:Kind,key:string)=>kind==='note'&&key==='contentHash';
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
 if(['article','source','rss-state','book','book-reading'].includes(kind))validateRecord({kind,value:checked,...(kind==='article'&&Object.hasOwn(checked,'registerSources')?{features:{incompat:[],roCompat:[ARTICLE_REGISTER_FEATURE]}}:{})});
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
  // rc7 25.1: note text fields are bounded by the complete state, not Text(245760).
  if(typeof v==='string')text(v,kind==='note'&&NOTE_TEXT_FIELDS.includes(key)?Number.MAX_SAFE_INTEGER:/^(url|guid|.*Url)$/.test(key)?8192:/^(title|name|description|excerpt|siteName|originalFilename|markdown|plainText|baseMarkdown)$/.test(key)?245760:1024);
  if(/(?:At|ChangedAt|Bytes|Clock)$/.test(key))uint(v);
  if(/SortOrder$/.test(key)||key==='sortOrder'){if(!Number.isSafeInteger(v)||Object.is(v,-0))throw Error('invalid_schema');}
  if(/Saved$/.test(key)||['isRead','isPinned','pinned','deleted','bookIndexRetired','rssIndexRetired','useOriginalContent','continuePlaybackInBackground'].includes(key)){if(typeof v!=='boolean')throw Error('invalid_schema');}
  (metaFields.has(key)&&!noteState(kind,key)?meta:state)[key]=v;
 }
 // Canonicalization rejects unsupported nested types and noninteger wire numbers.
 if(conflictChannel)state.noteConflicts=clone(noteConflicts);
 return {meta:clone(meta),state:clone(state)};
}
export function fromWire(kind:Kind,meta:Record<string,any>,state:Record<string,any>){
 if(Object.keys(meta).some(k=>!metaFields.has(k))||Object.keys(state).some(k=>metaFields.has(k)&&!noteState(kind,k)||Object.hasOwn(meta,k)))throw Error('invalid_schema');
 const value={...meta,...state};if(Object.hasOwn(value,'readingProgressMicros')){if(Object.hasOwn(value,'readingProgress'))throw Error('invalid_schema');uint(value.readingProgressMicros,1000000);value.readingProgress=value.readingProgressMicros/1000000;delete value.readingProgressMicros;}
 toWire(kind,value);return value;
}
/** `noteSegments` admits an ordinary note state above L only when the rc7
 * segmented encoding fits every limit and the watch text budget. Publication
 * still requires the write gate; the candidate keeps the ordinary S0. */
export function candidates(kind:Kind,logicalId:string,entityKey:string,value:Record<string,any>,addedAtMillis?:number,options:{noteSegments?:boolean}={}){
 text(logicalId);const wire=toWire(kind,value);if(addedAtMillis!==undefined)uint(addedAtMillis);
 const meta={version:2,entityKey,kind,logicalId,addedAtSource:addedAtMillis===undefined?'unknown':'original',requiredFeatures:[],payload:wire.meta};
 const state={version:2,entityKey,requiredFeatures:kind==='note'&&Object.hasOwn(wire.state,'noteConflicts')?['note-conflicts.v1']:[],payload:wire.state,noteSegments:[]};
 const metaBytes=jsonBytes(meta),stateBytes=jsonBytes(state);if(metaBytes.length>262144)throw Error('object_too_large');
 if(stateBytes.length>262144){if(kind!=='note'||options.noteSegments!==true)throw Error('object_too_large');encodeNote(splitOrdinary(state),'0'.repeat(32),()=>{},NOTE_TEXT_BUDGET);}
 return {meta,state,addedAtMillis:addedAtMillis??0,metaBytes:metaBytes.length,stateBytes:stateBytes.length};
}
/** The frozen save-register merger compares only the relative order of two
 * sort values. Rank just those values for its legacy nonnegative validator,
 * then restore the selected exact I53. Legacy validators remain unchanged. */
export function mergeWireBookReading(local:any,remote:any){
 const originals=[local,remote],normalized=originals.map(v=>{if(v===undefined)return undefined;toWire('book-reading',v);return {...v};});
 for(const prefix of ['favorite','watchLater']){const values=originals.filter(v=>v?.[prefix+'Saved']!==undefined).map(v=>v[prefix+'SortOrder']),ranks=[...new Set(values)].sort((a,b)=>a-b);for(const v of normalized)if(v?.[prefix+'Saved']!==undefined)v[prefix+'SortOrder']=ranks.indexOf(v[prefix+'SortOrder']);}
 const out=mergeBookReading(normalized[0],normalized[1]);
 for(const prefix of ['favorite','watchLater'])if((out as any)[prefix+'Saved']!==undefined){const tuple=(v:any)=>[v[prefix+'ChangedAt'],v[prefix+'SourceDeviceId']??v.sourceDeviceId,v[prefix+'Saved'],v[prefix+'SortOrder']];const index=normalized[1]?.[prefix+'Saved']!==undefined&&canonical(tuple(out))===canonical(tuple(normalized[1]))?1:0;(out as any)[prefix+'SortOrder']=originals[index][prefix+'SortOrder'];}
 return out;
}
