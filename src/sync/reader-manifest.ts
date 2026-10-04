import type {JsonObject} from './protocol.ts';
import {wireFields} from './article-batches.ts';
import {tokenUsageOptInt} from './token-usage.ts';
export interface ReaderManifest {presets:JsonObject[];fonts:JsonObject[];backgrounds:JsonObject[];deletions:JsonObject[]}
const fields={
 presets:{strings:['id','name','payloadJson','modifiedBy'],longs:['updatedAt'],ints:[],bools:['deleted']},
 fonts:{strings:['id','sha256','displayName','familyName','fileName','mimeType','metadataJson','modifiedBy'],longs:['byteCount','updatedAt'],ints:['faceCount'],bools:['deleted']},
 backgrounds:{strings:['id','sha256','displayName','kind','mimeType','masterFileName','variantsJson','modifiedBy'],longs:['byteCount','durationMs','updatedAt'],ints:['width','height'],bools:['deleted']},
 deletions:{strings:['kind','entityId','deletedBy'],longs:['deletedAt'],ints:[],bools:[]},
} as const;
export function readerRequiredString(value:JsonObject,key:string):string {if(value[key]===undefined)throw Error('缺少 '+key);return wireFields.string(value[key]);}
export function readerRequiredLong(value:JsonObject,key:string):number {const n=wireFields.optLong(value[key],NaN);if(!Number.isFinite(n))throw Error('无效整数 '+key);return n;}
export function readerRequiredInt(value:JsonObject,key:string):number {const n=tokenUsageOptInt(value,key,NaN);if(!Number.isFinite(n))throw Error('无效整数 '+key);return n;}
export function parseReaderManifest(request:JsonObject):ReaderManifest {
 const result:ReaderManifest={presets:[],fonts:[],backgrounds:[],deletions:[]};
 for(const kind of Object.keys(fields) as (keyof ReaderManifest)[]){
  for(const item of Array.isArray(request[kind])?request[kind] as unknown[]:[]){const raw=wireFields.object(item);if(!raw)continue;const row:JsonObject={};
   for(const key of fields[kind].strings)row[key]=readerRequiredString(raw,key);
   for(const key of fields[kind].longs)row[key]=readerRequiredLong(raw,key);
   for(const key of fields[kind].ints)row[key]=readerRequiredInt(raw,key);
   for(const key of fields[kind].bools){const v=raw[key];if(typeof v!=='boolean'&&!(typeof v==='string'&&/^(true|false)$/i.test(v)))throw Error('无效布尔值 '+key);row[key]=wireFields.bool(v);}
   if(kind==='backgrounds'){const poster=raw.posterAssetId===undefined?'':wireFields.string(raw.posterAssetId);row.posterAssetId=wireFields.trim(poster)?poster:'';}
   result[kind].push(row);
  }
 }
 return result;
}
function wins(incoming:JsonObject,local:JsonObject){return Number(incoming.updatedAt)>Number(local.updatedAt)||incoming.updatedAt===local.updatedAt&&(incoming.deleted===true&&local.deleted!==true||incoming.deleted===local.deleted&&String(incoming.modifiedBy)>String(local.modifiedBy));}
/** Native REPLACE semantics: winning records move to the end and unique asset hashes replace their previous owner. Deletion history does not itself alter entity records. */
export function mergeReaderManifest(local:ReaderManifest,incoming:ReaderManifest):ReaderManifest {
 const result:ReaderManifest={presets:[...local.presets],fonts:[...local.fonts],backgrounds:[...local.backgrounds],deletions:[...local.deletions]};
 for(const kind of ['presets','fonts','backgrounds'] as const)for(const item of incoming[kind]){const old=result[kind].find(row=>row.id===item.id);if(old&&!wins(item,old))continue;result[kind]=result[kind].filter(row=>row.id!==item.id&&(kind==='presets'||row.sha256!==item.sha256));result[kind].push(item);}
 for(const item of incoming.deletions){result.deletions=result.deletions.filter(row=>row.kind!==item.kind||row.entityId!==item.entityId);result.deletions.push(item);}
 return result;
}
/** Existing local preset payloads predate wire entity wrappers; keep their exact payload JSON. */
export function localPresetEntity(value:unknown):JsonObject {
 const raw=wireFields.object(typeof value==='string'?JSON.parse(value):value);if(!raw)throw Error('阅读器预设记录损坏，已保留原数据');
 if(typeof raw.payloadJson==='string')return parseReaderManifest({presets:[raw]}).presets[0]!;
 return parseReaderManifest({presets:[{id:raw.id,name:raw.name,payloadJson:typeof value==='string'?value:JSON.stringify(value),updatedAt:raw.updatedAt??0,modifiedBy:raw.modifiedBy??'',deleted:raw.deleted??false}]}).presets[0]!;
}
