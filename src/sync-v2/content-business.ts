/** Maps already validated business candidates to the explicit content engine.
 * Body version comes from the application's immutable source, never a state clock. */
import type {WatchContentEngine} from './content-engine';
import type {BodyResolver} from './publisher';
import {fromWire} from './business';
import {businessBodyWitness} from './body-binding';
import {hexId,oid,uint} from './protocol';
export function contentBodyResolver(engine:WatchContentEngine,describe:(entry:any)=>Promise<{bodyRevision:string;sourceBinding:string;importedFile:boolean;parentEntityKey?:string;parentKind?:string}|null>):BodyResolver {
 return async(entry,existing)=>{
  const c=entry.candidate;fromWire(c.meta.kind,c.meta.payload,c.state.payload);
  if(!['article','book','asset'].includes(c.meta.kind))return null;
  const source=await describe(entry);if(!source)return null;
  hexId(source.bodyRevision,32);await engine.bindBusiness(entry.entityKey,c.meta.kind,c.meta.logicalId,source.bodyRevision,source.sourceBinding,businessBodyWitness(c.meta.kind,fromWire(c.meta.kind,c.meta.payload,c.state.payload)));const manifest=await engine.manifest(entry.entityKey,source.bodyRevision);
  await engine.enqueue({entityKey:entry.entityKey,bodyRevision:source.bodyRevision,sourceBinding:source.sourceBinding,kind:c.meta.kind==='article'?'rss':'file',importedFile:source.importedFile,addedAtMillis:c.addedAtMillis,deleted:c.state.payload.deleted===true,...(source.parentEntityKey?{parentEntityKey:source.parentEntityKey}:{}),...(source.parentKind?{parentKind:source.parentKind}:{})},'upload');
  if(manifest)return {...manifest,promiseId:null};
  return {bodyRevision:source.bodyRevision,promiseId:source.bodyRevision,recipeOid:null,opaqueContentId:null,contentBytes:null};
 };
}
/** C10: only an authenticated CURRENT account row may start availability/read.
 * Call after the P2 double CAS/pull; an uploaded candidate is not this proof. */
export async function queueAuthenticatedBody(engine:WatchContentEngine,entry:any,options:{importedFile?:boolean;parentKind?:string;parentEntityKey?:string}={}){
 const {row,meta,state}=entry;fromWire(meta.kind,meta.payload,state.payload);if(row.entityKey!==meta.entityKey||row.entityKey!==state.entityKey)throw Error('invalid_schema');
 if(row.recipeOid===null||row.deleted)return null;hexId(row.entityKey,64);hexId(row.bodyRevision,32);oid(row.recipeOid,'recipe');hexId(row.opaqueContentId,64);uint(row.contentBytes);
 return engine.enqueue({entityKey:row.entityKey,bodyRevision:row.bodyRevision,recipeOid:row.recipeOid,opaqueContentId:row.opaqueContentId,contentBytes:row.contentBytes,kind:meta.kind==='article'?'rss':'file',addedAtMillis:row.addedAtMillis,...options},'download');
}
