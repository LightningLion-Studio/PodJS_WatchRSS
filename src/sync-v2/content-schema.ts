/** P3 decrypted content grammar. Public edges never replace this validation. */
import {exact,uint,hexId,oid,text,jsonBytes,canonical,opaqueContentId,type Scope} from './protocol';
import {sha256Hex,unhex,hmacSha256Bytes,lengthPrefixFields,hex} from '@podjs/framework/crypto';
import {bytes} from './protocol';
export interface ContentBlock {index:number;oid:string;plainBytes:number;opaqueContentId:string;}
export interface ContentRange {logicalPart:string;offset:number;length:number;}
export interface ContentRecipe {version:2;entityKey:string;bodyRevision:string;opaqueContentId:string;totalPlainBytes:number;plaintextSha256:string;blocks:ContentBlock[];ranges:ContentRange[];}
export function recipe(value:any):ContentRecipe {
 exact(value,['version','entityKey','bodyRevision','opaqueContentId','totalPlainBytes','plaintextSha256','blocks','ranges']);
 if(!Array.isArray(value.blocks)||!Array.isArray(value.ranges))throw Error('invalid_schema');
 if(value.blocks.length>2048||value.ranges.length>100000||jsonBytes(value).length>262144)throw Error('object_too_large');
 if(value.version!==2)throw Error('invalid_schema');hexId(value.entityKey,64);hexId(value.bodyRevision,32);hexId(value.opaqueContentId,64);hexId(value.plaintextSha256,64);uint(value.totalPlainBytes);
 let total=0;for(let i=0;i<value.blocks.length;i++){const b=value.blocks[i];exact(b,['index','oid','plainBytes','opaqueContentId']);if(uint(b.index,4294967295)!==i||uint(b.plainBytes,262144)===0||i<value.blocks.length-1&&b.plainBytes!==262144)throw Error('invalid_schema');oid(b.oid,'blob');hexId(b.opaqueContentId,64);total+=b.plainBytes;}
 if(total!==value.totalPlainBytes)throw Error('invalid_schema');
 const parts=new Set<string>();let previous:ContentRange|undefined;
 for(const r of value.ranges){exact(r,['logicalPart','offset','length']);text(r.logicalPart);uint(r.offset);uint(r.length);if(r.offset>value.totalPlainBytes-r.length||parts.has(r.logicalPart))throw Error('invalid_schema');parts.add(r.logicalPart);
  if(previous&&(previous.offset>r.offset||previous.offset===r.offset&&(previous.logicalPart>r.logicalPart||previous.logicalPart===r.logicalPart&&previous.length>=r.length)))throw Error('invalid_schema');previous=r;
 }return value;
}
export function contentIdFromHash(key:Uint8Array,scope:Scope,type:string,hash:string){hexId(hash,64);return hex(hmacSha256Bytes(key,lengthPrefixFields([bytes('wrss.sync.v2/content'),jsonBytes(scope),bytes(type),unhex(hash)])));}
export function recipeBlock(r:ContentRecipe,index:number,plain:Uint8Array,idKey:Uint8Array,scope:Scope){const b=r.blocks[index];if(!b||b.index!==index||b.plainBytes!==plain.length||opaqueContentId(idKey,scope,'blob',plain)!==b.opaqueContentId)throw Error('fingerprint_mismatch');}
