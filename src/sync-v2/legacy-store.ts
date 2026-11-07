/** SQL integration of the rc6c equivalent-content branch. Never edits a body. */
import {LegacyEquivalentPlanner} from './legacy-equivalent';
import {canonical,digest,exact,parseCanonicalJson} from './protocol';
import {fromWire,toWire} from './business';
import type {WatchProjectionStore} from './store';
import type {LocalCipher} from './store';
import type {ProjectionSql} from '@podjs/framework/sql-projection';
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const value of Object.values(v))freeze(value);Object.freeze(v);}return v;};
export class WatchEquivalentLegacy {
 private plans=new WeakMap<object,any>();
 constructor(private readonly store:WatchProjectionStore,private readonly db:ProjectionSql,private readonly cipher:LocalCipher,private readonly scopeKey:string,private readonly aad:(kind:string,key:string)=>string){}
 private async snapshot(){
  const state=await this.store.readState(),rows:Record<string,any>={},kinds=new Map<string,any>(),legacyInbox:Record<string,any>={},legacyQueues:Record<string,string[]>={},raw:Record<string,any>={},sealedRows=[];let after='';
  if((await this.store.checkpoint())?.phase!=='complete')throw Error('merge_not_safe');
  for(;;){const page=await this.store.candidatePage(after,32);if(!page.length)break;for(const r of page){const c=r.candidate;fromWire(c.meta.kind,c.meta.payload,c.state.payload);rows[r.entityKey]={identity:c.meta.logicalId,...c.meta.payload,...c.state.payload};kinds.set(r.entityKey,c.meta.kind);sealedRows.push(r);}after=page.at(-1)!.entityKey;}
  const inbox=await this.db.query('SELECT rowid,inbox_key,input_hash,body FROM syncv2_legacy_inbox WHERE scope=? ORDER BY rowid',[this.scopeKey]);
  for(const row of inbox){const key=String(row.inbox_key),value=await this.cipher.open(this.aad('legacy',key),String(row.body));
   const {route,applied,...original}=value;if(!(route==='discarded-for-cloud'&&value.discardedInputHash===row.input_hash)&&digest(original)!==row.input_hash)throw Error('merge_not_safe');raw[key]=value;
   const body=JSON.parse(value.body);if(!body||Object.getPrototypeOf(body)!==Object.prototype)throw Error('merge_not_safe');
   for(const [id,input]of Object.entries(body) as [string,any][]){const kind=kinds.get(id);if(!kind||!input||Object.getPrototypeOf(input)!==Object.prototype)throw Error('merge_not_safe');const {identity,...business}=input;try{const wire=toWire(kind,business);body[id]={identity,...wire.meta,...wire.state};}catch{throw Error('merge_not_safe');}}
   const removedEntityKeys:string[]=[],bodyRefsByEntity={};const intent={body,entityKeys:value.entityKeys,removedEntityKeys,bodyRefsByEntity};
   legacyInbox[key]={...intent,hash:digest(intent),peer:value.peer,cursor:value.cursor,route,applied};(legacyQueues[value.peer]??=[]).push(key);
  }
  const checkpoint=await this.store.checkpoint(),model=new LegacyEquivalentPlanner({...state,rows,legacyInbox,legacyQueues,legacyAckIndex:{},received:{},applied:state.applied});
  const source={state,rows:sealedRows,raw,inbox,checkpoint};return {state,model,raw,sourceHash:digest(source)};
 }
 async planLegacyMerge(key:string){const snap=await this.snapshot(),inner=snap.model.planLegacyMerge(key),proof=freeze({...inner,sourceHash:snap.sourceHash});this.plans.set(proof,{...snap,inner,key});return proof;}
 async resolveLegacyMerge(key:string,proof:any,hook?:()=>void){
  const saved=proof&&typeof proof==='object'?this.plans.get(proof):undefined;if(!saved||saved.key!==key)throw Error('choice_stale');
  const current=await this.snapshot();if(current.sourceHash!==saved.sourceHash)throw Error('choice_stale');
  const result=saved.model.resolveLegacyMerge(key,saved.inner);if(canonical(saved.model.state.rows)!==canonical(current.model.state.rows))throw Error('merge_not_safe');
  const candidate=saved.model.state,entry={...current.raw[key],applied:true,route:'resolve-merge'},next={...current.state,applied:candidate.applied,pendingChoice:candidate.pendingChoice};
  const sealed=await this.cipher.seal(this.aad('legacy',key),entry);if(hook)hook();const final=await this.snapshot();if(final.sourceHash!==saved.sourceHash)throw Error('choice_stale');
  await this.store.controlUpdate(current.state,next,[{sql:'UPDATE syncv2_legacy_inbox SET body=? WHERE scope=? AND inbox_key=?',params:[sealed,this.scopeKey,key]}]);this.plans.delete(proof);return result;
 }
 async resolveLegacy(key:string,choice:string){if(choice!=='merge')throw Error('feature_disabled');return this.resolveLegacyMerge(key,await this.planLegacyMerge(key));}
}
