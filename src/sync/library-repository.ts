import {querySyncPages} from './sql-pages.ts';
import type {SqlDatabase,SqlParams} from '../core/types.ts';
import type {SyncBodyCodec} from './article-body.ts';
import {SyncArticleReceiver,type ArticleReceiveFiles} from './article-receiver.ts';
import {LocalArticleManifestStore,type SyncTextPort} from './local-manifest.ts';
import {SyncArticleDeletionStore} from './deletion-store.ts';
import {SqlSourceSyncStore,normalizeSourceUrl,type SourceUriPort} from './source-store.ts';
import {SqlLibrarySequenceStore} from './sequence-store.ts';
import {migrateLocalDeletionJournal} from './deletion-journal.ts';
import {reconcileSnapshotLog} from './snapshot-log.ts';
import {libraryRevision,revisionGuard} from './revision.ts';
import {prepareArticle,bodyForRequest,type PreparedArticle,type ExportedArticle} from './article-export.ts';
import {isImportedContentUrl} from '../core/imported-content.ts';
import type {LibrarySessionRepository,LibraryWindow,PendingSyncSuccess} from './session.ts';
import type {ReceivedArticle,RequestedArticleBody} from './article-batches.ts';
import type {SyncedSource} from './library-wire.ts';
export interface RemovedLibraryContent {itemIds:readonly number[];channels:readonly {id:number;url:string}[]}
export interface SqlLibraryRepositoryPorts {
 codec:SyncBodyCodec;text:SyncTextPort;uri:SourceUriPort;files:ArticleReceiveFiles;
 migrateReading(id:number):Promise<void>;
 migrateReadingMany?:(ids:readonly number[])=>Promise<void>;
 /** Release offline media and channel-specific preview caches for removed rows. */
 cleanupRemovedContent(content:RemovedLibraryContent):Promise<void>;
 now?:()=>number;
}
let snapshotScope=0;
/** One shared instance serializes session operations. UI writes remain concurrent
 * and are detected by revision guards before advertising a sequence boundary. */
export class SqlLibrarySessionRepository implements LibrarySessionRepository {
 private readonly local:LocalArticleManifestStore;private readonly receiver:SyncArticleReceiver;private readonly deletion:SyncArticleDeletionStore;
 private readonly sources:SqlSourceSyncStore;private readonly sequence:SqlLibrarySequenceStore;private readonly now:()=>number;
 private tail:Promise<unknown>=Promise.resolve();
 private snapshotCache:{revision:number;articles:readonly PreparedArticle[];sources:readonly SyncedSource[]}|undefined;
 constructor(private readonly db:SqlDatabase,private readonly ports:SqlLibraryRepositoryPorts){
  this.now=ports.now??Date.now;this.local=new LocalArticleManifestStore(db,ports.codec,ports.text,ports.files,ports.migrateReading,ports.migrateReadingMany);
  this.receiver=new SyncArticleReceiver(db,ports.codec,ports.files,ports.migrateReading,this.now,a=>this.local.resolveIncomingBody(a));
  this.deletion=new SyncArticleDeletionStore(db,ports.codec,a=>this.local.resolveIncomingBody(a),itemIds=>ports.cleanupRemovedContent({itemIds,channels:[]}));this.sources=new SqlSourceSyncStore(db,ports.uri,this.now,removed=>ports.cleanupRemovedContent({itemIds:removed.itemIds,channels:[removed.channel]}));this.sequence=new SqlLibrarySequenceStore(db,this.now);
 }
 private run<T>(action:()=>Promise<T>):Promise<T>{const result=this.tail.then(action);this.tail=result.catch(()=>{});return result;}
 private async identity():Promise<string>{const row=(await this.db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0];if(!row||!String(row.device_id).trim())throw new Error('Initialize sync identity first');return String(row.device_id);}
 private async migrate(){const id=await this.identity();await migrateLocalDeletionJournal(this.db,id,this.ports.text,this.ports.codec);return id;}
 private async snapshot<T>(action:(articles:readonly PreparedArticle[],sources:readonly SyncedSource[],id:string)=>Promise<T>):Promise<T>{
  const id=await this.migrate();
  for(let attempt=0;attempt<3;attempt++){
   let revision=await libraryRevision(this.db);
   try{
    let cached=this.snapshotCache;
    // A full library exchange can outlast five minutes. The revision guard,
    // rather than wall-clock age, determines whether this session snapshot
    // remains valid until exportRequested releases it.
    if(!cached||cached.revision!==revision){
     // Legacy reading-state migration writes to the library. Finish it before
     // taking the revision used to guard the expensive manifest build.
     await this.local.prepareReadingForSnapshot();
     revision=await libraryRevision(this.db);
     cached=this.snapshotCache;
    }
    if(!cached||cached.revision!==revision){
     const articles=await this.local.snapshot(true),sources=await this.sources.export(id);
     await reconcileSnapshotLog(this.db,this.ports.codec,revision,id,articles.map(a=>a.manifest),sources,this.now());
     if(await libraryRevision(this.db)!==revision){this.snapshotCache=undefined;continue;}
     cached={revision,articles,sources};this.snapshotCache=cached;
    }
    const {articles,sources}=cached;
    const result=await action(articles,sources,id);if(await libraryRevision(this.db)===revision)return result;
    this.snapshotCache=undefined;
   }catch(error){if(await libraryRevision(this.db)===revision)throw error;this.snapshotCache=undefined;}
  }
  throw new Error('Library changed repeatedly while preparing sync');
 }
 deviceId(){return this.run(()=>this.identity());}
 cursor(peer:string){return this.run(()=>this.snapshot(()=>this.sequence.cursor(peer)));}
 mergeSources(sources:readonly SyncedSource[],remote:string,authoritative:boolean){return this.run(async()=>this.sources.merge(sources,remote,await this.migrate(),authoritative));}
 prepareWindow(peer:string,peerAppliedLocalSeq:number):Promise<LibraryWindow>{return this.run(()=>this.snapshot((articles,sources,id)=>this.sequence.prepareWindow(peer,id,articles.map(a=>a.manifest),async urls=>urls?sources.filter(s=>urls.includes(s.url)):sources,peerAppliedLocalSeq,{snapshotReconciled:true})));}
 exportSources(){return this.run(()=>this.snapshot(async(_a,sources)=>sources));}
 receiveArticle(entry:ReceivedArticle,remote:string,authoritative:boolean){return this.run(async()=>{await this.migrate();return entry.article.deleted?this.deletion.receive(entry.article,entry.body,remote,authoritative):this.receiver.receiveWithStats(entry.article,entry.body,remote,authoritative);});}
 exportRequested(requests:readonly RequestedArticleBody[]){return this.run(async()=>{try{if(requests.length===0)return [];return await this.snapshot(async articles=>{const ids=new Set(requests.map(r=>r.articleId));const selected=articles.filter(a=>ids.has(a.article.articleId)&&a.manifest.bodyAvailable);const outgoing:PreparedArticle[]=[];for(let start=0;start<selected.length;start+=32)outgoing.push(...await this.local.materializeRequestedBatch(selected.slice(start,start+32)));return outgoing;});}finally{if(this.snapshotCache&&this.snapshotCache.articles.reduce((n,a)=>n+(a.encodedBody?.length??0)+2*(a.article.contentHtml?.length??0)+2*a.article.contentText.length,0)>32*1024*1024)this.snapshotCache=undefined;}});}
 /** Cloud uses the same serialization lane and transactional entity merge as phone sync. */
 cloudSnapshot(full:boolean){return this.run(()=>this.snapshot(async(articles,sources)=>{
  const exported:ExportedArticle[]=[];
  for(const item of articles){const a=item.article,privateBody=isImportedContentUrl(a.url)||isImportedContentUrl(a.rssSourceUrl)||!a.rssSourceUrl?.trim();
   exported.push(full&&privateBody?(await this.local.materializeRequested(item)).article:{...a,contentHtml:null,contentText:''});}
  const states=new Map(exported.map(a=>[a.articleId,a]));
  for(const a of await this.local.cloudReadingStates())if(!states.has(a.articleId))states.set(a.articleId,a);
  return {articles:exported,sources,stateArticles:[...states.values()]};
 }));}
 mergeCloud(sources:readonly SyncedSource[],articles:readonly ExportedArticle[],remote:string){return this.run(async()=>{
  const id=await this.migrate();let changed=await this.sources.merge(sources,remote,id,false);
  for(const incoming of articles){
   let article=incoming;
   if(remote==='cloud-rss-inventory'){
    const existing=(await this.db.query('SELECT fetched_at FROM articles a JOIN channels c ON c.id=a.channel_id WHERE c.url=? AND a.dedup_key=?',[incoming.rssSourceUrl,incoming.articleId]))[0];
    const at=existing?Number(existing.fetched_at):this.now();article={...incoming,importedAt:at,updatedAt:at};
   }
   const prepared=await prepareArticle(article,this.ports.codec,true);
   const body=bodyForRequest(prepared,{articleId:article.articleId,bodyHash:'',metadataOnly:false,chunkIndexes:[]});
   changed+=article.deleted?await this.deletion.receive(article,body,remote,false):await this.receiver.receiveWithStats(article,body,remote,false);
  }
  this.snapshotCache=undefined;return changed;
 });}
 resetPeerState(){return this.run(()=>this.sequence.reset());}
 markSuccess(pending:PendingSyncSuccess){return this.run(()=>this.sequence.markSuccess(pending));}
 /** Phone clearLibrary removes the RSS library and sync cursors while keeping
  * the watch identity, standalone notes, account and reader configuration. */
 clearLibrary(){return this.run(async()=>{
  const revision=await libraryRevision(this.db);
  const channels=(await querySyncPages(this.db,'SELECT id,url FROM channels ORDER BY id')).map(r=>({id:Number(r.id),url:String(r.url)}));
  const itemIds=(await querySyncPages(this.db,'SELECT id FROM articles ORDER BY id')).map(r=>Number(r.id));
  await this.db.transaction([revisionGuard(revision),{sql:'DELETE FROM channels'},
   ...['sync_saved_states','sync_article_deletions','sync_article_ids','sync_article_aliases','local_article_deletions',
    'sync_source_states','sync_change_log','sync_peer_state','sync_snapshot_fingerprints'].map(table=>({sql:`DELETE FROM ${table}`})),
   {sql:'UPDATE sync_library_revision SET revision=revision+1 WHERE id=1'}]);
  this.snapshotCache=undefined;
  await this.ports.cleanupRemovedContent({itemIds,channels});
 });}
 finalizeSnapshot(articleIds:readonly string[],sourceUrls:readonly string[]){return this.run(async()=>{
  await this.migrate();const revision=await libraryRevision(this.db),ids=new Set(articleIds),urls=new Set(sourceUrls.map(normalizeSourceUrl));
  const channels=(await querySyncPages(this.db,'SELECT id,url FROM channels ORDER BY id')).filter(r=>!urls.has(normalizeSourceUrl(String(r.url)))).map(r=>({id:Number(r.id),url:String(r.url)})),removedChannels=new Set(channels.map(c=>c.id));
  const itemIds=(await querySyncPages(this.db,'SELECT id,channel_id,dedup_key FROM articles ORDER BY id')).filter(r=>!ids.has(String(r.dedup_key))||removedChannels.has(Number(r.channel_id))).map(r=>Number(r.id));
  const scope=String(this.now())+':'+(++snapshotScope);
  await this.db.execute('CREATE TABLE IF NOT EXISTS sync_snapshot_retained(scope TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,PRIMARY KEY(scope,kind,entity_id))');
  try{
   const entries=[...[...ids].map(id=>['article',id]),...[...urls].map(url=>['rssSource',url]),...channels.map(c=>['dropChannel',String(c.id)])];
   for(let offset=0;offset<entries.length;offset+=400)await this.db.transaction([revisionGuard(revision),...entries.slice(offset,offset+400).map(([kind,id])=>({sql:'INSERT INTO sync_snapshot_retained(scope,kind,entity_id) VALUES(?,?,?)',params:[scope,kind!,id!]}))]);
   const keepArticle="SELECT entity_id FROM sync_snapshot_retained WHERE scope=? AND kind='article'",keepSource="SELECT entity_id FROM sync_snapshot_retained WHERE scope=? AND kind='rssSource'";
   const statements:{sql:string;params?:SqlParams}[]=[revisionGuard(revision),{sql:`DELETE FROM articles WHERE dedup_key NOT IN (${keepArticle})`,params:[scope]},
    {sql:"DELETE FROM channels WHERE id IN (SELECT entity_id FROM sync_snapshot_retained WHERE scope=? AND kind='dropChannel')",params:[scope]},
    ...['sync_saved_states','sync_article_deletions','sync_article_ids'].map(table=>({sql:`DELETE FROM ${table} WHERE article_id NOT IN (${keepArticle})`,params:[scope]})),
    {sql:`DELETE FROM sync_source_states WHERE url NOT IN (${keepSource})`,params:[scope]},
    ...['sync_change_log','sync_peer_state','sync_snapshot_fingerprints'].map(table=>({sql:`DELETE FROM ${table}`})),
    {sql:'UPDATE sync_library_revision SET revision=revision+1 WHERE id=1'}];
   await this.db.transaction(statements);await this.ports.cleanupRemovedContent({itemIds,channels});
  }finally{await this.db.execute('DELETE FROM sync_snapshot_retained WHERE scope=?',[scope]);}
 });}
}
