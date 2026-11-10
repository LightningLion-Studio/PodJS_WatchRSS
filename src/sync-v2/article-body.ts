/** P6-9: same plaintext selection, revision domain and block grammar as Mini
 * de7e5f5. Sealing is local only; this adapter never uploads a content object. */
import {encodeUtf8} from '@podjs/framework/bytes';
import {sha256Hex} from '@podjs/framework/crypto';
import {digest,jsonBytes,type Scope} from './protocol';
import {sealV2,type EnvelopeCrypto,type ObjectKeys} from './sealed';
import {recipe,contentIdFromHash} from './content-schema';
import type {BodyManifest,BodyResolver} from './publisher';
import type {PreparedArticle} from '../sync/article-export';
export const ARTICLE_BLOCK_BYTES=262144;
export function articleBodyBytes(value:{contentText?:string;contentHtml?:string|null}){
 const text=value.contentText||value.contentHtml;return text?encodeUtf8(text,'replacement'):null;
}
export const articleBodyRevision=(entityKey:string,plain:Uint8Array)=>digest(['wrss.sync.v2/article-body',entityKey,sha256Hex(plain)]).slice(0,32);
export async function buildArticleBody(crypto:EnvelopeCrypto,keys:ObjectKeys,scope:Scope,entityKey:string,plain:Uint8Array){
 if(!plain.length)throw Error('invalid_schema');
 const blocks=[],objects=[];
 for(let offset=0;offset<plain.length;offset+=ARTICLE_BLOCK_BYTES){const part=plain.subarray(offset,offset+ARTICLE_BLOCK_BYTES),sealed=await sealV2(crypto,keys.id,keys.content,scope,'blob',keys.version,part);blocks.push({index:blocks.length,oid:sealed.oid,plainBytes:part.length,opaqueContentId:sealed.header.opaqueContentId});objects.push(sealed);}
 const hash=sha256Hex(plain),body=recipe({version:2,entityKey,bodyRevision:articleBodyRevision(entityKey,plain),opaqueContentId:contentIdFromHash(keys.id,scope,'recipe',hash),totalPlainBytes:plain.length,plaintextSha256:hash,blocks,ranges:[]});
 const sealed=await sealV2(crypto,keys.id,keys.content,scope,'recipe',keys.version,jsonBytes(body));objects.push(sealed);
 const binding:BodyManifest={bodyRevision:body.bodyRevision,promiseId:null,recipeOid:sealed.oid,opaqueContentId:body.opaqueContentId,contentBytes:plain.length};
 return {recipe:body,objects,binding};
}
/** A recipe may enter an index only after the content lane has made its closure
 * durable. With contentWrite closed, retain the deterministic revision and
 * placeholder, or reuse an already published recipe for the exact same bytes. */
export function articleBodyResolver(options:{crypto:EnvelopeCrypto;keys:ObjectKeys;scope:Scope;read:(id:string)=>Promise<PreparedArticle|undefined>}):BodyResolver{
 return async(entry,existing)=>{
  if(entry.candidate.meta.kind!=='article')return null;
  const prepared=await options.read(entry.candidate.meta.logicalId);if(!prepared?.manifest.bodyAvailable)return null;
  const plain=articleBodyBytes(prepared.article);if(!plain)return null;
  const revision=articleBodyRevision(entry.entityKey,plain);
  if(existing?.row.bodyRevision===revision)return Object.fromEntries(['bodyRevision','promiseId','recipeOid','opaqueContentId','contentBytes'].map(k=>[k,existing.row[k]])) as unknown as BodyManifest;
  // Validate the real mapping even while the content upload gate is closed.
  const mapped=await buildArticleBody(options.crypto,options.keys,options.scope,entry.entityKey,plain);
  return {...mapped.binding,promiseId:revision,recipeOid:null,opaqueContentId:null,contentBytes:null};
 };
}
