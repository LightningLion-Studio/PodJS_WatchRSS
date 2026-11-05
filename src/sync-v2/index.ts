import type {CloudHostRequest} from '../cloud/host-ports';
import type {LocalArticleManifestStore} from '../sync/local-manifest';
import {unhex} from '@podjs/framework/crypto';
import {ProjectionGate} from './gate';
import {stopExistingProjection} from './business-revision';
import {WatchProjectionStore} from './store';
import {SqlBusinessSource} from './source';
import {watchMaterializer} from './materializer';
import {localProjectionCipher,projectionSql} from './host';
import type {WatchIdentityStore} from './identity-store';
import {entityKey,type Scope} from './protocol';
/** Explicit opt-in factory. No runtime registration, cloud transport, UI,
 * scheduler, key creation or original business writes are introduced in P1. */
export function watchLocalProjection(options:{enabled?:boolean;host:CloudHostRequest;identity:Pick<WatchIdentityStore,'installed'>;descriptor:unknown;scope:Scope;libraryId:string;accountScope:string;metadata:Pick<LocalArticleManifestStore,'cloudRestoreMetadata'>}){
 const gate=new ProjectionGate(options.enabled??false);let opened:Promise<{store:WatchProjectionStore;source:SqlBusinessSource}>|undefined;
 gate.onClose(()=>stopExistingProjection(projectionSql(options.host)));
 return {
  gate,
  open(){if(!gate.isEnabled)return stopExistingProjection(projectionSql(options.host)).then(()=>null);return opened??=(async()=>{
   // Approved identity access ends before any SQL writer or content work starts.
   const installed=await options.identity.installed(options.descriptor),db=projectionSql(options.host),key=unhex(installed.idKeyHex);
   const store=new WatchProjectionStore(db,localProjectionCipher(options.host,options.accountScope),gate,options.scope,options.libraryId,key,async()=>{await options.identity.installed(options.descriptor);});
   await store.initialize();const source=await SqlBusinessSource.open(db,watchMaterializer(db,options.metadata,(table,locator)=>store.readCandidateBySource(table,locator),(kind,id)=>store.readCandidate(entityKey(key,options.scope.repoId,kind,id))));return {store,source};
  })().catch(error=>{opened=undefined;throw error;});},
 };
}
export {watchSyncV2} from './runtime';
