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
import {entityKey,digest,type Scope} from './protocol';
/** Explicit opt-in factory. No runtime registration, cloud transport, UI,
 * scheduler, key creation or original business writes are introduced in P1. */
export function watchLocalProjection(options:{enabled?:boolean;noteSegments?:boolean;host:CloudHostRequest;identity:Pick<WatchIdentityStore,'installed'>;descriptor:unknown;scope:Scope;libraryId:string;accountScope:string;metadata:Pick<LocalArticleManifestStore,'cloudRestoreMetadata'>}){
 const gate=new ProjectionGate(options.enabled??false);let opened:Promise<{store:WatchProjectionStore;source:SqlBusinessSource;rebuild:()=>Promise<void>}>|undefined;
 gate.onClose(()=>stopExistingProjection(projectionSql(options.host)));
 return {
  gate,
  open(){if(!gate.isEnabled)return stopExistingProjection(projectionSql(options.host)).then(()=>null);return opened??=(async()=>{
   // Approved identity access ends before any SQL writer or content work starts.
   const installed=await options.identity.installed(options.descriptor),db=projectionSql(options.host),key=unhex(installed.idKeyHex);
   const store=new WatchProjectionStore(db,localProjectionCipher(options.host,options.accountScope),gate,options.scope,options.libraryId,key,async()=>{await options.identity.installed(options.descriptor);},{noteSegments:options.noteSegments===true});
   await store.initialize();const source=await SqlBusinessSource.open(db,watchMaterializer(db,options.metadata,(table,locator)=>store.readCandidateBySource(table,locator),(kind,id)=>store.readCandidate(entityKey(key,options.scope.repoId,kind,id))));return {store,source,async rebuild(){if(await store.checkpoint())await store.restartScan();else await store.beginScan({schema:'v2-rc6c-business-2',descriptorPin:digest(options.descriptor),accountScope:options.accountScope,capability:'p5-history-rebuild'});for(;;){const cp=await store.checkpoint();if(cp!.phase==='complete')break;if(cp!.phase==='tail')await store.catchUpPage(source);else await store.scanPage(source);}}};
  })().catch(error=>{opened=undefined;throw error;});},
 };
}
export {watchSyncV2} from './runtime';

export {watchSpaceV2} from './space-runtime';
export {watchLocalObjectsV2} from './local-session';
export {localObjectAuthenticator} from './local-auth';

export {WatchAccountControl} from './account-control';
export {WatchAccountBusinessSql} from './account-business';
export {accountBodyVerifier} from './account-body';
