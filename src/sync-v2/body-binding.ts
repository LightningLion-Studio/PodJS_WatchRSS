/** Body identity fields only. Reading/favorite/title edits do not invent a new
 * body version; changed content identity cannot reuse an old completed plan. */
import {digest,type Kind} from './protocol';
export function businessBodyWitness(kind:Kind,value:Record<string,any>){
 const fields=kind==='article'?['articleId','url','contentHash']:kind==='book'?['bookId','fingerprint','chapterCount','kind','instanceId']:kind==='asset'?['assetId','mime','updatedAt']:null;
 if(!fields)throw Error('unsupported_feature');return digest({kind,fields:Object.fromEntries(fields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]))});
}
