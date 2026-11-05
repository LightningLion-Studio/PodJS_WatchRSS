/** Sync Objects v2-rc6 local projection primitives. No network or account I/O. */
import {encodeUtf8,decodeUtf8Chunk} from '@podjs/framework/bytes';
import {sha256Hex,hmacSha256Bytes,hex,unhex,lengthPrefixFields} from '@podjs/framework/crypto';
import {checkD64} from '@podjs/framework/sql-projection';
export {checkD64,compareD64,nextD64} from '@podjs/framework/sql-projection';
export type Scope={repoId:string;libraryEpoch:string;contentGeneration:string};
export const bytes=(s:string)=>encodeUtf8(s,'strict');
export function exact(value:any,keys:readonly string[],enumerable=false){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype)throw Error('invalid_schema');
 const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))throw Error('invalid_schema');
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||(!Object.hasOwn(d,'value')||enumerable&&d.enumerable!==true))throw Error('invalid_schema');}
}
function scalar(s:string){for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const d=s.charCodeAt(++i);if(!(d>=0xdc00&&d<=0xdfff))throw Error('invalid_encoding');}else if(c>=0xdc00&&c<=0xdfff)throw Error('invalid_encoding');}}
export function canonical(value:any):string {
 if(value===null||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='string'){scalar(value);return JSON.stringify(value);}
 if(typeof value==='number'){if(!Number.isSafeInteger(value)||Object.is(value,-0))throw Error('invalid_encoding');return String(value);}
 if(Array.isArray(value)){for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,i))throw Error('invalid_encoding');return '['+value.map(canonical).join(',')+']';}
 if(value&&Object.getPrototypeOf(value)===Object.prototype){const keys=Object.keys(value);exact(value,keys);return '{'+keys.sort().map(k=>{scalar(k);return JSON.stringify(k)+':'+canonical(value[k]);}).join(',')+'}';}
 throw Error('invalid_encoding');
}
export const jsonBytes=(value:any)=>bytes(canonical(value));
export const digest=(value:any)=>sha256Hex(jsonBytes(value));
export function text(value:any,max=1024){if(typeof value!=='string')throw Error('invalid_schema');scalar(value);if(bytes(value).length>max)throw Error('invalid_schema');return value;}
export function hexId(value:any,length:number){if(typeof value!=='string'||!(new RegExp('^[a-f0-9]{'+length+'}$')).test(value))throw Error('invalid_schema');return value;}
export function uint(value:any,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(value)||Object.is(value,-0)||value<0||value>max)throw Error('invalid_schema');return value as number;}
export function oid(value:any,type:string){if(typeof value!=='string'||!value.startsWith(type+':sha256:'))throw Error('invalid_schema');hexId(value.slice(type.length+8),64);return value;}
export function entityKey(key:Uint8Array,repo:string,kind:string,id:string){hexId(repo,32);if(key.length!==32||!KINDS.includes(kind as Kind)||!text(id).length)throw Error('invalid_schema');return hex(hmacSha256Bytes(key,lengthPrefixFields(['wrss.sync.v2/entity',repo,kind,id].map(bytes))));}
export function opaqueContentId(key:Uint8Array,scope:Scope,type:string,plain:Uint8Array){validateScope(scope);if(!['meta','state','blob','recipe'].includes(type))throw Error('invalid_schema');if(key.length!==32)throw Error('invalid_schema');return hex(hmacSha256Bytes(key,lengthPrefixFields([bytes('wrss.sync.v2/content'),jsonBytes(scope),bytes(type),unhex(sha256Hex(plain))])));}
export const KINDS=['article','book','note','source','rss-state','book-reading','asset','folder'] as const;
export type Kind=typeof KINDS[number];
/** Both authenticated graphs must include terminal nodes. Any malformed
 * adjacency anywhere makes the complete graph unknown, including unchanged rows. */
export function affectedSet(before:Record<string,any>,target:Record<string,any>,complete=true):string[]|null {
 if(!complete)return null;
 for(const graph of [before,target])for(const row of Object.values(graph)){
  if(!row||typeof row!=='object'||Array.isArray(row)||row.authenticated===false||row.dependenciesComplete===false)return null;
  if(Object.hasOwn(row,'dependencies')){if(!Array.isArray(row.dependencies))return null;for(const dep of row.dependencies)if(typeof dep!=='string'||!dep.length)return null;}
 }
 const result=new Set<string>(),pending:string[]=[];
 for(const id of new Set([...Object.keys(before),...Object.keys(target)]))if(Object.hasOwn(before,id)!==Object.hasOwn(target,id)||canonical(before[id]??null)!==canonical(target[id]??null))pending.push(id);
 while(pending.length){const id=pending.pop()!;if(result.has(id))continue;if(!Object.hasOwn(before,id)&&!Object.hasOwn(target,id))return null;result.add(id);for(const graph of [before,target])if(Object.hasOwn(graph,id))for(const dep of graph[id].dependencies??[])if(!result.has(dep))pending.push(dep);}
 return [...result].sort();
}

/** Portable strict canonical JSON decode for QuickJS hosts without TextDecoder.
 * Byte equality also rejects duplicate keys, whitespace and noncanonical text. */
export function parseCanonicalJson(input:Uint8Array){
 let at=0,text='';while(at<input.length){const part=decodeUtf8Chunk(input,at);if(part.next<=at)throw Error('invalid_encoding');text+=part.text;at=part.next;}
 let value:any;try{value=JSON.parse(text);}catch{throw Error('invalid_encoding');}const encoded=jsonBytes(value);
 if(encoded.length!==input.length||encoded.some((b,i)=>b!==input[i]))throw Error('invalid_encoding');return value;
}

export function validateScope(scope:Scope){exact(scope,['repoId','libraryEpoch','contentGeneration']);hexId(scope.repoId,32);if(checkD64(scope.libraryEpoch)==='0'||checkD64(scope.contentGeneration)==='0')throw Error('invalid_schema');}

/** Local retention of already-decoded v13/v14 JSON. Fractional legacy reading
 * progress is valid here; it is not accepted as a v2 wire JSON number. */
export function canonicalLegacy(value:any):string {
 if(typeof value==='number'){if(!Number.isFinite(value))throw Error('invalid_encoding');return JSON.stringify(value);}
 if(Array.isArray(value)){for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,i))throw Error('invalid_encoding');return '['+value.map(canonicalLegacy).join(',')+']';}
 if(value&&typeof value==='object'){const keys=Object.keys(value);exact(value,keys);return '{'+keys.sort().map(key=>JSON.stringify(text(key,245760))+':'+canonicalLegacy(value[key])).join(',')+'}';}
 return canonical(value);
}
