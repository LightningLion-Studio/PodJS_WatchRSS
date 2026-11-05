/** Strict control grammar. No IO, credentials or trust inferred from revisions. */
import {exact,hexId,uint,oid,checkD64,validateScope,canonical,jsonBytes,type Scope} from './protocol';
import {base64ToBytes,bytesToBase64} from '@podjs/framework/bytes';
export const b64=(b:Uint8Array)=>bytesToBase64(b).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export function unb64(s:any,length?:number){if(typeof s!=='string'||!/^[A-Za-z0-9_-]*$/.test(s))throw Error('invalid_encoding');const b=base64ToBytes(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4));if(b64(b)!==s||length!==undefined&&b.length!==length)throw Error('invalid_encoding');return b;}
export function sorted(xs:any,max:number,check:(x:any)=>void){if(!Array.isArray(xs)||xs.length>max)throw Error('invalid_schema');let before:string|undefined;for(const x of xs){check(x);if(before!==undefined&&before>=x)throw Error('invalid_schema');before=x;}}
export const features=(xs:any)=>sorted(xs,32,x=>{if(typeof x!=='string'||!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(x))throw Error('invalid_schema');});
export const nullableOid=(v:any,t:string)=>{if(v!==null)oid(v,t);};
export function sameScope(a:Scope,b:Scope){validateScope(a);validateScope(b);if(canonical(a)!==canonical(b))throw Error('scope_mismatch');}
export function commitBody(b:any){
 exact(b,['version','scope','authorDeviceId','deviceSequence','previousOwnCommit','mergedParents','treeRoot','requiredFeatures','createdAtMillis','observedRefs','indexComplete','accountParent','rollbackGeneration','operation']);
 if(b.version!==2||b.indexComplete!==true)throw Error('invalid_schema');validateScope(b.scope);hexId(b.authorDeviceId,32);if(checkD64(b.deviceSequence)==='0')throw Error('invalid_schema');checkD64(b.rollbackGeneration);uint(b.createdAtMillis);oid(b.treeRoot,'tree');nullableOid(b.previousOwnCommit,'commit');nullableOid(b.accountParent,'commit');
 sorted(b.mergedParents,64,x=>{oid(x,'commit');if(x===b.previousOwnCommit)throw Error('invalid_schema');});features(b.requiredFeatures);
 if(!Array.isArray(b.observedRefs)||b.observedRefs.length>64)throw Error('invalid_schema');let prev='';for(const r of b.observedRefs){exact(r,['deviceId','commitOid','refRevision']);hexId(r.deviceId,32);oid(r.commitOid,'commit');if(checkD64(r.refRevision)==='0'||r.deviceId<=prev)throw Error('invalid_schema');prev=r.deviceId;}
 exact(b.operation,['kind','rollbackTarget','resolvesGeneration']);const op=b.operation;
 if(op.kind==='normal'){if(op.rollbackTarget!==null||op.resolvesGeneration!==null)throw Error('invalid_schema');}
 else if(op.kind==='rollback'){oid(op.rollbackTarget,'commit');if(op.resolvesGeneration!==null||b.rollbackGeneration==='0')throw Error('invalid_schema');}
 else if(['resolve-local','resolve-merge'].includes(op.kind)){if(op.rollbackTarget!==null||checkD64(op.resolvesGeneration)==='0'||op.resolvesGeneration!==b.rollbackGeneration)throw Error('invalid_schema');}
 else throw Error('invalid_schema');
}
export function indexRow(r:any){
 exact(r,['entityKey','metaOid','stateOid','addedAtMillis','rowSequence','deleted','bodyRevision','promiseId','recipeOid','opaqueContentId','contentBytes','requiredFeatures']);hexId(r.entityKey,64);oid(r.metaOid,'meta');oid(r.stateOid,'state');uint(r.addedAtMillis);if(checkD64(r.rowSequence)==='0'||typeof r.deleted!=='boolean')throw Error('invalid_schema');features(r.requiredFeatures);
 if(r.bodyRevision!==null)hexId(r.bodyRevision,32);if(r.promiseId!==null)hexId(r.promiseId,32);nullableOid(r.recipeOid,'recipe');if(r.opaqueContentId!==null)hexId(r.opaqueContentId,64);if(r.contentBytes!==null)uint(r.contentBytes);
 if(r.recipeOid!==null&&r.opaqueContentId===null||r.bodyRevision===null&&r.opaqueContentId!==null)throw Error('invalid_schema');
 if((r.opaqueContentId===null)!==(r.contentBytes===null)||r.promiseId!==null&&r.recipeOid!==null||r.bodyRevision===null&&(r.promiseId!==null||r.recipeOid!==null)||r.bodyRevision!==null&&r.promiseId===null&&r.recipeOid===null)throw Error('invalid_schema');
 if(jsonBytes(r).length>262144)throw Error('object_too_large');
}
export function header(h:any,encodedLength:number){
 exact(h,['domain','version','scope','keyVersion','type','opaqueContentId','encoding','plainBytes','encodedBytes','salt','nonce']);if(h.domain!=='wrss.sync.v2/sealed'||h.version!==2||!['meta','state','blob','recipe'].includes(h.type)||!['identity','gzip'].includes(h.encoding))throw Error('invalid_schema');validateScope(h.scope);if(uint(h.keyVersion,4294967295)===0)throw Error('invalid_schema');hexId(h.opaqueContentId,64);unb64(h.salt,32);unb64(h.nonce,12);uint(h.plainBytes,262144);uint(h.encodedBytes,262144);
 if(h.encodedBytes!==encodedLength||h.encoding==='identity'&&h.encodedBytes!==h.plainBytes||h.encoding==='gzip'&&(h.plainBytes===0||h.encodedBytes*100>h.plainBytes*95))throw Error('invalid_schema');
}
