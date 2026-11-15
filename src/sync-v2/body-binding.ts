import {fromWire} from './business';
/** Body identity fields only. Reading/favorite/title edits do not invent a new
 * body version; changed content identity cannot reuse an old completed plan. */
import {digest,type Kind} from './protocol';
export function businessBodyWitness(kind:Kind,value:Record<string,any>){
 const fields=kind==='article'?['articleId','url','contentHash']:kind==='book'?['bookId','fingerprint','chapterCount','kind','instanceId']:kind==='asset'?['assetId','mime','updatedAt']:null;
 if(!fields)throw Error('unsupported_feature');return digest({kind,fields:Object.fromEntries(fields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]))});
}

export function sameIndependentIdentity(kind:string,a:any,b:any){
 if(a?.meta?.kind!==kind||b?.meta?.kind!==kind||a.meta.logicalId!==b.meta.logicalId)return false;
 if(kind==='asset')return a.meta.payload.assetId===b.meta.payload.assetId;
 return businessBodyWitness(kind as any,fromWire(kind as any,a.meta.payload,a.state.payload))===businessBodyWitness(kind as any,fromWire(kind as any,b.meta.payload,b.state.payload));
}

/** A deletion fact needs no body proof, even on the first R0 migration. */
export const bodylessTombstone=(candidate:any)=>['book','asset'].includes(candidate.meta.kind)&&candidate.state.payload.deleted===true;
export const emptyBodyDescription=()=>({bodyRevision:null,promiseId:null,recipeOid:null,opaqueContentId:null,contentBytes:null});
