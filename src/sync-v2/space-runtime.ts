import {ResourceQuota} from '@podjs/framework/resource-journal';
import type {WatchContentEngine} from './content-engine';
import type {WatchProjectionStore} from './store';
import type {CloudHostRequest} from '../cloud/host-ports';
import {localProjectionCipher,projectionSql} from './host';
import {WatchSpaceStore,type CachedBody} from './space-store';
import {WatchSpaceV2} from './space';
import {WatchRecovery,type RecoveryPort} from './recovery';
/** Caller-owned isolated entry. No account write, timer, original-body delete,
 * lease/custody action or UI string. Reuse the authenticated P3 receive cache. */
export async function watchSpaceV2(options:{enabled?:boolean;host:CloudHostRequest;projection:WatchProjectionStore;content:WatchContentEngine;accountScope:string;trustedNow:()=>number|null;recovery:Pick<RecoveryPort,'source'>&Partial<Pick<RecoveryPort,'reserve'>>;event?:ConstructorParameters<typeof WatchSpaceV2>[1]['event']}){
 if(options.enabled!==true)return null;const {content,host,projection}=options,binding=content.store.prefix,store=new WatchSpaceStore(projectionSql(host),localProjectionCipher(host,'space:'+options.accountScope+':'+binding),content.store.files,binding);await store.init();
 const space=new WatchSpaceV2(store,{projection,remote:content.remote,trustedNow:options.trustedNow,event:options.event,
  capacity:async()=>{const stat=await host<{usableBytes?:number}>('file.stat',{path:binding});return Number.isSafeInteger(stat.usableBytes)?stat.usableBytes!:null;},
  detach:body=>content.prepareEviction(body.item.entityKey,body.item.bodyRevision),
  localProof:async body=>{
   const state=await projection.readState(),current=state.cloud?.current;if(state.hasUnsentEdits||!state.account||!current||current.commitOid!==state.account.oid)throw Error('closure_incomplete');
   const entry=await projection.cloudRow(current.treeRoot,body.item.entityKey),row=entry?.row;
   if(!row||row.entityKey!==body.item.entityKey||row.bodyRevision!==body.item.bodyRevision||row.recipeOid!==body.item.recipeOid||row.deleted)throw Error('closure_incomplete');
   const descriptor=await content.verifiedBody(row.entityKey,row.bodyRevision);if(descriptor.recipeOid!==row.recipeOid)throw Error('closure_incomplete');
   const kind=entry.meta.kind==='book'?'import':entry.meta.kind==='article'?(descriptor.item.importedFile?'import':'rss'):null;
   if(kind===null||body.item.kind!==kind||body.item.addedAtMillis!==row.addedAtMillis||body.item.addedAtSource!==entry.meta.addedAtSource)throw Error('closure_incomplete');
   return {accountOid:state.account.oid,scope:content.remote.http.scope,entityKey:row.entityKey,bodyRevision:row.bodyRevision,recipeOid:row.recipeOid,blobOids:descriptor.recipe.blocks.map(b=>b.oid),keyVersion:content.keys.version,authenticated:true};
  },
 });
 const quota=new ResourceQuota(store.journal.db,binding),recovery=new WatchRecovery(projection,store,{...options.recovery,reserve:options.recovery.reserve??(async bytes=>{const stat=await host<{usableBytes?:number}>('file.stat',{path:binding});if(!Number.isSafeInteger(stat.usableBytes))throw Error('storage_pressure');return quota.reserve(Array.from(await content.crypto.random(16),b=>b.toString(16).padStart(2,'0')).join(''),bytes,Math.max(0,stat.usableBytes!-1048576));}),cipher:localProjectionCipher(host,'recovery:'+options.accountScope+':'+binding),trustedNow:options.trustedNow,randomId:async()=>Array.from(await content.crypto.random(16),b=>b.toString(16).padStart(2,'0')).join('')});
 return {store,space,recovery,
  async adopt(body:CachedBody){if(body.status!=='ready')throw Error('content_not_ready');const descriptor=await content.derivedBody(body.item.entityKey,body.item.bodyRevision);if(body.plaintextSha256!==descriptor.recipe.plaintextSha256||body.item.recipeOid!==descriptor.recipeOid||body.item.localBytes!==descriptor.recipe.totalPlainBytes)throw Error('hash_mismatch');for(let at=0;at<descriptor.resources.length;at+=32)await store.register(descriptor.resources.slice(at,at+32));await store.add(body,descriptor.resources.map(r=>r.id));},
  async readRange(id:string,offset:number,length:number){const row=await store.journal.row(id);if(!row)throw Error('object_missing');const body=await store.open(row);if(body.status!=='ready')throw Error('content_not_ready');return content.readRange(id,body.item.bodyRevision,offset,length);},
 };
}
