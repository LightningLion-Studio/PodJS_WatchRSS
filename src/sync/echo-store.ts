import type {SqlDatabase,SqlParams} from '../core/types';
import type {ArticleManifest} from './manifest';
import type {SyncedSource} from './library-wire';
import type {SyncBodyCodec} from './article-body';
import {hashJavaText} from './article-export';
let generationCounter=0;
const key=(kind:string,id:string)=>kind+'\0'+id;
export class PeerEchoStore {
 constructor(private readonly db:SqlDatabase,private readonly codec:SyncBodyCodec){}
 private signature(value:object){const row=value as Record<string,unknown>;return hashJavaText(JSON.stringify(Object.fromEntries(Object.keys(row).sort().filter(k=>k!=='legacyArticleIds').map(k=>[k,row[k]]))),this.codec);}
 private async records(peer:string){return this.db.query('SELECT e.* FROM sync_peer_echo e JOIN sync_peer_echo_generation g ON g.peer_device_id=e.peer_device_id AND g.generation=e.generation WHERE e.peer_device_id=?',[peer]);}
 async filter(peer:string,articles:readonly ArticleManifest[],sources:readonly SyncedSource[]){
  const proof=new Map((await this.records(peer)).map(r=>[key(String(r.kind),String(r.entity_id)),r]));
  const keep=async(kind:string,id:string,row:{sourceDeviceId:string})=>row.sourceDeviceId!==peer||String(proof.get(key(kind,id))?.local_signature??'')!==await this.signature(row);
  const articleManifest:ArticleManifest[]=[],rssSources:SyncedSource[]=[];
  for(const a of articles)if(await keep('article',a.articleId,a))articleManifest.push(a);
  for(const s of sources)if(await keep('rssSource',s.url,s))rssSources.push(s);
  return {articleManifest,rssSources};
 }
 /** Stage bounded rows first; only the cursor transaction publishes this generation.
  * Failed receives/ACKs never reach this method; failed staging cannot activate proof. */
 async stage(peer:string,articles:readonly ArticleManifest[],sources:readonly SyncedSource[],incoming:readonly ArticleManifest[],incomingSources:readonly SyncedSource[]):Promise<{sql:string;params:SqlParams}[]> {
  const proof=new Map((await this.records(peer)).map(r=>[key(String(r.kind),String(r.entity_id)),r]));
  const remote=new Map<string,ArticleManifest|SyncedSource>([...incoming.map(a=>[key('article',a.articleId),a] as const),...incomingSources.map(s=>[key('rssSource',s.url),s] as const)]);
  const gen=Date.now()+':'+(++generationCounter),writes:{sql:string;params:SqlParams}[]=[];
  for(const [kind,id,value]of [...articles.map(a=>['article',a.articleId,a] as const),...sources.map(s=>['rssSource',s.url,s] as const)]){
   if(value.sourceDeviceId!==peer)continue;const stamp=await this.signature(value),received=remote.get(key(kind,id)),old=proof.get(key(kind,id));
   const incomingStamp=received?.sourceDeviceId===peer?await this.signature(received):old&&String(old.local_signature)===stamp?String(old.incoming_signature):undefined;
   if(!incomingStamp)continue;
   writes.push({sql:'INSERT INTO sync_peer_echo(peer_device_id,generation,kind,entity_id,incoming_signature,local_signature) VALUES(?,?,?,?,?,?)',params:[peer,gen,kind,id,incomingStamp,stamp]});
  }
  for(let at=0;at<writes.length;at+=400)await this.db.transaction(writes.slice(at,at+400));
  return [{sql:'INSERT INTO sync_peer_echo_generation(peer_device_id,generation) VALUES(?,?) ON CONFLICT(peer_device_id) DO UPDATE SET generation=excluded.generation',params:[peer,gen]},
   {sql:'DELETE FROM sync_peer_echo WHERE peer_device_id=? AND generation!=?',params:[peer,gen]}];
 }
}
