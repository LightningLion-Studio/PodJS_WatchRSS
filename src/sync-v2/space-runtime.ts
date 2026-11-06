import {WatchBusinessClosure} from './business-closure';
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
export async function watchSpaceV2(options:{enabled?:boolean;host:CloudHostRequest;projection:WatchProjectionStore;content:WatchContentEngine;accountScope:string;trustedNow:()=>number|null;recovery?:Partial<Pick<RecoveryPort,'reserve'>>;event?:ConstructorParameters<typeof WatchSpaceV2>[1]['event']}){
 if(options.enabled!==true)return null;const {content,host,projection}=options,binding=content.store.prefix,store=new WatchSpaceStore(projectionSql(host),localProjectionCipher(host,'space:'+options.accountScope+':'+binding),content.store.files,binding);await store.init();const closures=new WatchBusinessClosure(projection,content);
 const space=new WatchSpaceV2(store,{projection,remote:content.remote,trustedNow:options.trustedNow,event:options.event,
  capacity:async()=>{const stat=await host<{usableBytes?:number}>('file.stat',{path:binding});return Number.isSafeInteger(stat.usableBytes)?stat.usableBytes!:null;},
  detach:body=>content.prepareEviction(body.item.entityKey,body.item.bodyRevision),
  localProof:body=>closures.cloudProof(body),
 });
 const quota=new ResourceQuota(store.journal.db,binding),recovery=new WatchRecovery(projection,store,{source:(refs,changes)=>closures.source(refs,changes),reserve:options.recovery?.reserve??(async bytes=>{const stat=await host<{usableBytes?:number}>('file.stat',{path:binding});if(!Number.isSafeInteger(stat.usableBytes))throw Error('storage_pressure');return quota.reserve(Array.from(await content.crypto.random(16),b=>b.toString(16).padStart(2,'0')).join(''),bytes,Math.max(0,stat.usableBytes!-1048576));}),cipher:localProjectionCipher(host,'recovery:'+options.accountScope+':'+binding),trustedNow:options.trustedNow,randomId:async()=>Array.from(await content.crypto.random(16),b=>b.toString(16).padStart(2,'0')).join('')});
 const adopt=async(body:CachedBody)=>{if(body.status!=='ready')throw Error('content_not_ready');const descriptor=await content.derivedBody(body.item.entityKey,body.item.bodyRevision);if(body.plaintextSha256!==descriptor.recipe.plaintextSha256||body.item.recipeOid!==descriptor.recipeOid||body.item.localBytes!==descriptor.recipe.totalPlainBytes)throw Error('hash_mismatch');for(let at=0;at<descriptor.resources.length;at+=32)await store.register(descriptor.resources.slice(at,at+32));await store.add(body,descriptor.resources.map(r=>r.id));};
 return {store,space,recovery,closures,adopt,
  async adoptEntity(id:string,access:Parameters<WatchBusinessClosure['cachedBody']>[1]){const body=await closures.cachedBody(id,access);if(body)await adopt(body);return body;},

  async readRange(id:string,offset:number,length:number){const row=await store.journal.row(id);if(!row)throw Error('object_missing');const body=await store.open(row);if(body.status!=='ready')throw Error('content_not_ready');return content.readRange(id,body.item.bodyRevision,offset,length);},
 };
}
