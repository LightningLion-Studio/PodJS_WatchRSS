/** Authenticate historical body closure without caching an old snapshot. */
import {ContentSha256} from '@podjs/framework/content-sha256';
import {canonical,exact,parseCanonicalJson} from './protocol';
import {openV2,objectOid,type EnvelopeCrypto} from './sealed';
import {recipe,recipeBlock,contentIdFromHash} from './content-schema';
import {verifySigned,type SigningPort} from './signing';
import {sameScope} from './wire';
import type {SyncV2Http} from './http';
import type {ApprovedKey} from './head-pins';
export function accountBodyVerifier(http:SyncV2Http,crypto:EnvelopeCrypto&SigningPort,keys:{id:Uint8Array;content:Uint8Array;version:number},approved:(id:string)=>Promise<ApprovedKey>){return async(row:any,windowId:string)=>{
 if(row.bodyRevision===null)return;const objects:{oid:string;storedBytes:number}[]=[];if(row.recipeOid===null)throw Error('closure_incomplete');
 const opened=await (async()=>{const raw=await http.object(row.recipeOid,undefined,windowId);objects.push({oid:row.recipeOid,storedBytes:raw.length});return openV2(crypto,keys.id,keys.content,http.scope,row.recipeOid,raw);})();if(opened.header.keyVersion!==keys.version)throw Error('unsupported_feature');const r=recipe(opened.value);
 if(r.entityKey!==row.entityKey||r.bodyRevision!==row.bodyRevision||r.totalPlainBytes!==row.contentBytes||r.opaqueContentId!==row.opaqueContentId)throw Error('body_revision_changed');
 const mapping=await http.recipeRefs(windowId,row.recipeOid);sameScope(mapping.scope,http.scope);if(mapping.parentOid!==row.recipeOid)throw Error('closure_incomplete');const raw=await http.object(mapping.refsOid,undefined,windowId);if(raw.length!==mapping.totalBytes||objectOid('recipe-refs',raw)!==mapping.refsOid)throw Error('hash_mismatch');objects.push({oid:mapping.refsOid,storedBytes:raw.length});const refs=parseCanonicalJson(raw);exact(refs,['body','signature']);const key=await approved(mapping.authorDeviceId);if(key.keyId!==mapping.keyId)throw Error('signature_invalid');await verifySigned(crypto,key.publicKey,'wrss.sync.v2/recipe-refs-sign',refs.body,refs.signature);if(canonical(refs.body)!==canonical({scope:http.scope,recipeOid:row.recipeOid,blobOids:r.blocks.map(b=>b.oid)}))throw Error('closure_incomplete');
 const hash=new ContentSha256();for(let i=0;i<r.blocks.length;i++){const id=r.blocks[i]!.oid,raw=await http.object(id,undefined,windowId),block=await openV2(crypto,keys.id,keys.content,http.scope,id,raw);objects.push({oid:id,storedBytes:raw.length});if(block.header.keyVersion!==keys.version)throw Error('unsupported_feature');recipeBlock(r,i,block.plain,keys.id,http.scope);hash.update(block.plain);}
 if(hash.finish()!==r.plaintextSha256||contentIdFromHash(keys.id,http.scope,'recipe',r.plaintextSha256)!==r.opaqueContentId)throw Error('hash_mismatch');return {objects};
 };}
