import {AckedStateVector,projectionVersionRootText,checkedStateReceipts,receiptIsCurrent,type StateRoots,type StateReceipts,type ProjectionVersions} from '@podjs/framework/acked-state-vector';
import type {SqlDatabase} from '../core/types';
import type {SyncBodyCodec} from './article-body';
import {hashJavaText} from './article-export';
import {SqlDomainDefinitions,SYNC_DOMAINS,type SyncDomain,DOMAIN_ENCODERS} from './domain-definitions';
export {SYNC_DOMAINS,type SyncDomain} from './domain-definitions';
export const PHONE_SAFETY_CHECK_MS=24*60*60*1000;
export const DOMAIN_FAST_PATH_PROFILE='rss-canonical-books-reading-v1:merge:domain-v2';
export interface DomainExternalState {scope:string;roots:Partial<Record<SyncDomain,string>>;revalidate?():Promise<DomainExternalState>}
export interface DomainVectorProvider {open(peer:string,profile:string):Promise<AckedStateVector>}
let windowSerial=0;
export class SqlDomainVectorStore implements DomainVectorProvider {
 private definitions:SqlDomainDefinitions;
 constructor(private readonly db:SqlDatabase,private readonly codec:Pick<SyncBodyCodec,'sha256'>,private readonly external:()=>Promise<DomainExternalState>,private readonly options:{now?:()=>number;canSkipLibrary?:(peer:string)=>Promise<boolean>;encoders?:Record<SyncDomain,number>;definitions?:SqlDomainDefinitions}={}){this.definitions=options.definitions??new SqlDomainDefinitions(db,codec,options.encoders??DOMAIN_ENCODERS);}
 /** A grant delivery receipt is the current complete account-domain root.
  * It does not publish, replace or authorize a frozen session proof. */
 async accountStateRoot(account:{scope:string;root:string}):Promise<string>{
  if(!/^[0-9a-f]{64}$/.test(account.scope)||!/^[0-9a-f]{64}$/.test(account.root))throw Error('invalid_account_domain_state');
  const def=(await this.definitions.ensure()).account,row=(await this.db.query("SELECT revision FROM sync_fast_versions WHERE domain='account'"))[0];
  if(!row)throw Error('missing_account_domain_revision');
  const base=await this.versionRoot('account',def,account.scope,Number(row.revision));
  return hashJavaText(JSON.stringify(['watchrss.ble.domain-composite.v2',base,account.root]),this.codec);
 }
 private async versionRoot(domain:SyncDomain,def:import('./domain-definitions').DomainDefinition,scope:string,revision:number){
  const epoch=(await hashJavaText('watchrss.ble.domain-owner.v2\n'+def.epoch+'\n'+scope,this.codec)).slice(0,32);
  return hashJavaText(projectionVersionRootText(domain,def,epoch,revision),this.codec);
 }
 async open(peer:string,profile:string){
  if(!peer||peer.length>512||profile!==DOMAIN_FAST_PATH_PROFILE)throw Error('invalid_domain_profile');
  // One file inventory per connection/window. Subsequent calls only revalidate
  // known stat tokens. Never refresh a digest to sign a post-summary mutation.
  const initial=await this.external(),scope=initial.scope;if(!/^[0-9a-f]{64}$/.test(scope))throw Error('invalid_domain_scope');
  const composites=new Map<string,string>();
  let first=true,versions:ProjectionVersions={},frozenEpochs:Record<string,string>|undefined;
  const roots=async():Promise<StateRoots>=>{
   const current=first?initial:initial.revalidate?await initial.revalidate():await this.external();first=false;
   const defs=await this.definitions.ensure();versions=Object.fromEntries(SYNC_DOMAINS.map(d=>[d,{encoder:defs[d].encoder,schema:defs[d].schema,definition:defs[d].definition}]));
   if(current.scope!==scope)return {};
   const epochs=Object.fromEntries(SYNC_DOMAINS.map(d=>[d,defs[d].epoch]));frozenEpochs??=epochs;
   const rows=await this.db.query("SELECT v.domain,v.revision,r.root,r.revision cached_revision FROM sync_fast_versions v JOIN sync_fast_definitions d ON d.domain=v.domain LEFT JOIN sync_fast_roots r ON r.domain=v.domain AND r.scope=?||':'||d.generation",[scope]),out:StateRoots={};
   for(const row of rows){const d=String(row.domain) as SyncDomain;if(!SYNC_DOMAINS.includes(d)||frozenEpochs[d]!==epochs[d])continue;
    const def=defs[d],revision=Number(row.revision);
    let root=Number(row.cached_revision)===revision&&/^[0-9a-f]{64}$/.test(String(row.root))?String(row.root):undefined;
    if(!root){root=await this.versionRoot(d,def,scope,revision);await this.db.execute('INSERT OR REPLACE INTO sync_fast_roots(scope,domain,revision,root) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM sync_fast_definitions WHERE domain=? AND generation=?)',[scope+':'+def.generation,d,revision,root,d,def.generation]);}
    if(d==='library'){
     const gap=(await this.db.query('SELECT (SELECT revision FROM sync_library_revision WHERE id=1)-(SELECT real_events FROM sync_projection_totals WHERE id=1) gap'))[0]?.gap;
     if(gap===undefined)continue;const key=JSON.stringify(['watchrss.ble.library-witness.v2',root,Number(gap)]);root=composites.get(key)??await hashJavaText(key,this.codec);composites.set(key,root);
    }
    if(['books','reader','notes','account'].includes(d)){
     const extra=current.roots[d];if(!extra||!/^[0-9a-f]{64}$/.test(extra))continue;
     const key=JSON.stringify(['watchrss.ble.domain-composite.v2',root,extra]);root=composites.get(key)??await hashJavaText(key,this.codec);composites.set(key,root);
    }
    out[d]=root;
   }return out;
  };
  const now=()=> (this.options.now??Date.now)();
  const nonce=String((await this.db.query('SELECT lower(hex(randomblob(16))) nonce'))[0]!.nonce);
  return new AckedStateVector(SYNC_DOMAINS,roots,async()=>{
   const receipts:StateReceipts={};for(const r of await this.db.query('SELECT * FROM sync_fast_receipts WHERE peer=? AND scope=? AND profile=?',[peer,scope,profile])){
    if(receiptIsCurrent(Number(r.verified_at),now())&&now()-Number(r.verified_at)<PHONE_SAFETY_CHECK_MS&&SYNC_DOMAINS.includes(String(r.domain) as SyncDomain))receipts[String(r.domain)]={localRoot:String(r.local_root),remoteRoot:String(r.remote_root)};
   }return checkedStateReceipts(receipts,SYNC_DOMAINS);
  },async(receipts,publication)=>{
   const time=now();await this.db.transaction(Object.entries(receipts).map(([d,r])=>publication.completedDomains.includes(d)?{
    sql:'INSERT OR REPLACE INTO sync_fast_receipts(peer,scope,profile,domain,local_root,remote_root,verified_at) VALUES(?,?,?,?,?,?,?)',params:[peer,scope,profile,d,r.localRoot,r.remoteRoot,time]
   }:{
    // No INSERT for SKIP. Revalidation/GC during the exchange must not resurrect
    // a removed credential, and warm rounds never move verified_at forward.
    sql:'UPDATE sync_fast_receipts SET local_root=local_root WHERE peer=? AND scope=? AND profile=? AND domain=? AND local_root=? AND remote_root=? AND verified_at>0 AND verified_at<=? AND verified_at>?',params:[peer,scope,profile,d,r.localRoot,r.remoteRoot,time,time-PHONE_SAFETY_CHECK_MS]
   }));
  },()=>nonce+'-'+(++windowSerial),{versions:()=>versions,allowSkip:async d=>d!=='library'||!!await this.options.canSkipLibrary?.(peer)});
 }
}
