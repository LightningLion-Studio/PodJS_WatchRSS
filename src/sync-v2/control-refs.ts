/** Immutable public reference tables authenticate the decrypted parent order. */
import {exact,oid,hexId,uint,canonical,parseCanonicalJson,type Scope} from './protocol';
import {sameScope} from './wire';
import {objectOid} from './sealed';
import {verifySigned,type SigningPort} from './signing';
import type {SyncV2Http} from './http';
import type {ApprovedKey} from './head-pins';
export async function readControlRefs(http:SyncV2Http,crypto:SigningPort,approved:(deviceId:string)=>Promise<ApprovedKey>,windowId:string,parent:{type:'state'|'recipe';oid:string;value:any}){
 oid(parent.oid,parent.type);const state=parent.type==='state',type=state?'state-refs':'recipe-refs',mapping=await(state?http.stateRefs(windowId,parent.oid):http.recipeRefs(windowId,parent.oid));
 exact(mapping,['version','scope','parentOid','refsOid','authorDeviceId','keyId','totalBytes']);sameScope(mapping.scope,http.scope);if(mapping.version!==2||mapping.parentOid!==parent.oid)throw Error('invalid_schema');oid(mapping.refsOid,type);hexId(mapping.authorDeviceId,32);hexId(mapping.keyId,32);if(uint(mapping.totalBytes,262144)===0)throw Error('invalid_schema');
 const raw=await http.object(mapping.refsOid);if(raw.length!==mapping.totalBytes||objectOid(type,raw)!==mapping.refsOid)throw Error('hash_mismatch');const refs=parseCanonicalJson(raw);exact(refs,['body','signature']);const b=refs.body;exact(b,['scope',state?'stateOid':'recipeOid',state?'segmentOids':'blobOids']);sameScope(b.scope,http.scope);
 const parentOid=state?b.stateOid:b.recipeOid,children=state?b.segmentOids:b.blobOids;
 if(parentOid!==parent.oid||!Array.isArray(children)||children.length>2048)throw Error('invalid_schema');for(const id of children)oid(id,state?'state':'blob');
 const expected=state?parent.value.noteSegments:Array.isArray(parent.value.blocks)?parent.value.blocks.map((block:any)=>block.oid):null;
 if(!Array.isArray(expected)||canonical(children)!==canonical(expected))throw Error('closure_incomplete');const key=await approved(mapping.authorDeviceId);if(key.deviceId!==mapping.authorDeviceId||key.keyId!==mapping.keyId)throw Error('signature_invalid');await verifySigned(crypto,key.publicKey,'wrss.sync.v2/'+type+'-sign',b,refs.signature);return {mapping,refs,raw};
}
