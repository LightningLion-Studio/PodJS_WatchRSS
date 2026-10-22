import {canonicalRssUrl,isLocalOnlyRssSource} from '../cloud/rss-identity';
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
  this.receiver=new SyncArticleReceiver(db,ports.codec,ports.files,ports.migrateReading,this.now,(a,target)=>this.local.resolveIncomingBody(a,target));
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
 private async cloudState(){await this.db.execute(`CREATE TABLE IF NOT EXISTS cloud_rss_article_ids(item_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,article_id TEXT NOT NULL)`);await this.db.execute(`CREATE TABLE IF NOT EXISTS cloud_article_state(article_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,body_hash TEXT NOT NULL,body_ready INTEGER NOT NULL DEFAULT 0,reading_clock INTEGER NOT NULL DEFAULT 0,reading_source TEXT NOT NULL DEFAULT '')`);await this.db.execute(`CREATE TABLE IF NOT EXISTS cloud_source_state(url TEXT PRIMARY KEY,projection TEXT NOT NULL,changed_at INTEGER NOT NULL,device TEXT NOT NULL)`);}
 private sourceProjection(s:SyncedSource){return JSON.stringify([s.title,s.sortOrder,s.isPinned,s.deleted,s.deletedAt]);}
 private async cloudSourcesForExport(sources:readonly SyncedSource[],device:string){
  const state=new Map((await this.db.query('SELECT * FROM cloud_source_state')).map(r=>[String(r.url),r]));const out:SyncedSource[]=[];
  for(const source of sources){const projection=this.sourceProjection(source),old=state.get(source.url);let clock=old?Number(old.changed_at):Math.max(1,source.deletedAt,source.createdAt),provenance=old?String(old.device):device;
   if(old&&old.projection!==projection){clock=Math.max(this.now(),clock+1,source.deletedAt);provenance=device;}
   if(!old||old.projection!==projection)await this.db.execute('INSERT OR REPLACE INTO cloud_source_state(url,projection,changed_at,device) VALUES(?,?,?,?)',[source.url,projection,clock,provenance]);out.push({...source,updatedAt:clock,sourceDeviceId:provenance});
  }return out;
 }
 private async mergeCloudSources(sources:readonly SyncedSource[],device:string){
  await this.cloudSourcesForExport(await this.sources.export(device),device);let changed=0;
  for(const source of sources){const old=(await this.db.query('SELECT * FROM cloud_source_state WHERE url=?',[source.url]))[0],clock=source.updatedAt||source.deletedAt||1,provenance=source.sourceDeviceId||'',projection=this.sourceProjection(source);
   if(old&&(clock<Number(old.changed_at)||clock===Number(old.changed_at)&&(provenance<String(old.device)||provenance===String(old.device)&&projection<=String(old.projection))))continue;
   const cached=(await this.db.query('SELECT description,image_url FROM channels WHERE url=?',[source.url]))[0];
   changed+=await this.sources.merge([{...source,description:String(cached?.description??source.description),imageUrl:cached?.image_url==null?source.imageUrl:String(cached.image_url)}],provenance,device,true);
   if(!source.deleted)await this.db.execute('UPDATE channels SET sort_order=? WHERE url=?',[-source.sortOrder,source.url]);
   await this.db.execute('INSERT OR REPLACE INTO cloud_source_state(url,projection,changed_at,device) VALUES(?,?,?,?)',[source.url,projection,clock,provenance]);
  }return changed;
 }

 cloudReadingCandidates(){return this.run(async()=>{await this.cloudState();return this.snapshot(async articles=>{const identities=await this.local.cloudRssIdentities(),localIds=new Map(identities.map(r=>[r.articleId,r.localArticleId]));const saved=new Map(articles.map(a=>[a.article.url,a.article])),savedById=new Map(articles.map(a=>[a.article.articleId,a.article])),metadata=new Map((await this.db.query('SELECT * FROM cloud_article_state')).map(r=>[String(r.article_id),r]));return (await this.local.cloudReadingStates(true)).map(a=>{const m=metadata.get(a.articleId)??metadata.get(localIds.get(a.articleId)??''),state=savedById.get(identities.find(r=>r.articleId===a.articleId)?.nativeArticleId??'')??saved.get(a.url),s=state?{...a,favoriteSaved:state.favoriteSaved,favoriteChangedAt:state.favoriteChangedAt,favoriteSortOrder:state.favoriteSortOrder,watchLaterSaved:state.watchLaterSaved,watchLaterChangedAt:state.watchLaterChangedAt,watchLaterSortOrder:state.watchLaterSortOrder}:a;return m?{...s,...(a.contentHash===m.body_hash?{contentHash:String(m.content_hash)}:{}),...(a.readingPositionChangedAt===Number(m.reading_clock)?{sourceDeviceId:String(m.reading_source)}:{})}:s;});});});}

 cloudSnapshot(full:boolean){return this.run(async()=>{await this.cloudState();return this.snapshot(async(articles,sources,device)=>{
  const identities=await this.local.cloudRssIdentities(),byCanonical=new Map(identities.map(r=>[r.articleId,r])),byNative=new Map(identities.flatMap(r=>[[r.localArticleId,r],[r.nativeArticleId,r]] as const)),byUrl=new Map(identities.map(r=>[r.sourceUrl+'\0'+r.url,r]));
  const cloudIdentity=(a:ExportedArticle)=>{if(a.cloudRssArticleId)return a;if(!a.rssSourceUrl||isImportedContentUrl(a.rssSourceUrl)||isImportedContentUrl(a.url)||isLocalOnlyRssSource(a.rssSourceUrl))return a;const row=byNative.get(a.articleId)??byUrl.get(a.rssSourceUrl+'\0'+a.url);return row?{...a,articleId:row.articleId,cloudRssArticleId:row.articleId,cloudLegacyArticleIds:[row.localArticleId,row.nativeArticleId].filter(id=>id!==row.articleId),url:row.url}:undefined;};
  const exported:ExportedArticle[]=[];
  for(const item of articles){const a=item.article,privateBody=isImportedContentUrl(a.url)||isImportedContentUrl(a.rssSourceUrl)||!a.rssSourceUrl?.trim()||a.favoriteSaved||a.watchLaterSaved;
   exported.push(full&&privateBody?(await this.local.materializeRequested(item)).article:{...a,contentHtml:null,contentText:''});}
  const states=new Map(exported.map(a=>[a.articleId,a]));
  for(const a of await this.local.cloudReadingStates()){const old=states.get(a.articleId);if(!old)states.set(a.articleId,a);else if(!old.independentSaved&&!old.rssSourceUrl)states.set(a.articleId,{...old,rssSourceUrl:a.rssSourceUrl,rssSourceTitle:a.rssSourceTitle,readingProgress:a.readingProgress,readingPositionBytes:a.readingPositionBytes,readingPositionContentHash:a.readingPositionContentHash,readingPositionChangedAt:a.readingPositionChangedAt,isRead:a.isRead});}
  // Saved-state tombstones in the phone protocol omit their RSS origin. Restore
  // the local origin before cloud retention decisions so unsaving drops the body.
  const origins=await this.db.query(`SELECT m.article_id,c.url,c.title FROM sync_article_ids m JOIN articles a ON a.id=m.item_id JOIN channels c ON c.id=a.channel_id WHERE c.url LIKE 'http://%' OR c.url LIKE 'https://%'`);
  const originById=new Map(origins.map(r=>[String(r.article_id),r]));
  const origin=(a:ExportedArticle)=>{const identity=byNative.get(a.articleId),row=originById.get(a.articleId)??(identity?{url:identity.sourceUrl,title:sources.find(s=>s.url===identity.sourceUrl)?.title??''}:undefined);return row&&!a.independentSaved&&!a.rssSourceUrl?{...a,rssSourceUrl:String(row.url),rssSourceTitle:String(row.title)}:a;};
  for(const [id,a]of states)states.set(id,origin(a));

  const metadata=new Map((await this.db.query('SELECT * FROM cloud_article_state')).map(r=>[String(r.article_id),r]));
  const normalize=(a:ExportedArticle)=>{const m=metadata.get(a.articleId)??metadata.get((byNative.get(a.articleId)??byCanonical.get(a.articleId))?.localArticleId??'');return m?{...a,...(a.contentHash===m.body_hash?{contentHash:String(m.content_hash)}:{}),...(a.readingPositionChangedAt===Number(m.reading_clock)?{sourceDeviceId:String(m.reading_source)}:{})}:a;};
  const pendingPrivateArticleIds=exported.filter(a=>{const m=metadata.get(a.articleId)??metadata.get((byNative.get(a.articleId)??byCanonical.get(a.articleId))?.localArticleId??'');return !a.deleted&&(a.independentSaved||a.favoriteSaved||a.watchLaterSaved||isImportedContentUrl(a.url)||isImportedContentUrl(a.rssSourceUrl))&&m&&a.contentHash===m.body_hash&&!Number(m.body_ready);}).map(a=>a.articleId);
  const project=(rows:ExportedArticle[])=>rows.map(cloudIdentity).filter((a):a is ExportedArticle=>!!a);
  return {articles:project(exported.map(origin).map(normalize)),sources:await this.cloudSourcesForExport(sources,device),stateArticles:project([...states.values()].map(normalize)),pendingPrivateBodies:pendingPrivateArticleIds.length>0,pendingPrivateArticleIds:pendingPrivateArticleIds.map(id=>byNative.get(id)?.articleId??id)};
 });});}
 mergeCloud(sources:readonly SyncedSource[],articles:readonly ExportedArticle[],remote:string){return this.run(async()=>{
  await this.cloudState();const id=await this.migrate();const identities=await this.local.cloudRssIdentities();let changed=remote==='cloud-records'?await this.mergeCloudSources(sources,id):await this.sources.merge(sources,remote,id,false);
  for(const incoming of articles){
   let article=incoming;let targetItemId:number|undefined;let publicId:string|undefined;
   if(incoming.rssSourceUrl&&!isImportedContentUrl(incoming.rssSourceUrl)&&!isImportedContentUrl(incoming.url)&&!isLocalOnlyRssSource(incoming.rssSourceUrl)){
    const candidates=identities.filter(r=>r.sourceUrl===incoming.rssSourceUrl);let target=candidates.find(r=>r.articleId===incoming.articleId)??(!incoming.cloudRssArticleId?candidates.find(r=>r.localArticleId===incoming.articleId||r.nativeArticleId===incoming.articleId):undefined);
    if(!target&&remote==='cloud-rss-inventory'){
     let link:string|undefined;try{link=canonicalRssUrl(incoming.url,false);}catch{}
     const matches=link?candidates.filter(r=>{if(!r.legacyMaterialized)return false;try{return canonicalRssUrl(r.url,false)===link;}catch{return false;}}):[];
     if(matches.length===1)target=matches[0];
    }
    publicId=remote==='cloud-rss-inventory'?incoming.articleId:target?.articleId??incoming.cloudRssArticleId??incoming.articleId;
    if(target){targetItemId=target.itemId;article={...incoming,articleId:target.localArticleId,url:target.url};}
   }
   if(!article.deleted&&remote!=='cloud-rss-inventory'){
    const deletion=(await this.db.query('SELECT changed_at FROM sync_article_deletions WHERE article_id=?',[article.articleId]))[0];
    const liveClock=Math.max(article.updatedAt,article.importedAt,article.independentChangedAt,article.favoriteSaved?article.favoriteChangedAt:0,article.watchLaterSaved?article.watchLaterChangedAt:0);
    // Replaying old cloud metadata/body must not undo a newer local deletion.
    if(deletion&&Number(deletion.changed_at)>=liveClock)continue;
   }
   if(remote==='cloud-rss-inventory'){
    const existing=(await this.db.query('SELECT a.fetched_at,a.title,a.description,a.image_url,EXISTS(SELECT 1 FROM article_saved_states s WHERE s.article_id=a.id AND s.saved=1) AS retained FROM articles a JOIN channels c ON c.id=a.channel_id WHERE c.url=? AND (a.id=? OR a.dedup_key=?) LIMIT 1',[incoming.rssSourceUrl,targetItemId??0,incoming.articleId]))[0];
    const at=existing?Number(existing.fetched_at):this.now();article={...article,importedAt:at,updatedAt:at,...(Number(existing?.retained)?{title:String(existing.title),excerpt:String(existing.description??''),imageUrl:existing.image_url==null?null:String(existing.image_url),contentHtml:null,contentText:''}:{})};
   }
   const oldMeta=(await this.db.query('SELECT * FROM cloud_article_state WHERE article_id=?',[article.articleId]))[0];
   if(remote==='cloud-records'){const existing=(await this.db.query('SELECT a.title,a.description,a.image_url,a.fetched_at FROM sync_article_ids m JOIN articles a ON a.id=m.item_id WHERE m.article_id=?',[article.articleId]))[0];if(existing&&Number(existing.fetched_at)>article.updatedAt)article={...article,title:String(existing.title),excerpt:String(existing.description??''),imageUrl:existing.image_url==null?null:String(existing.image_url),updatedAt:Number(existing.fetched_at),contentHash:oldMeta?String(oldMeta.content_hash):article.contentHash};}
   const prepared=await prepareArticle(article,this.ports.codec,true);
   const body=bodyForRequest(prepared,{articleId:article.articleId,bodyHash:'',metadataOnly:false,chunkIndexes:[]});
   changed+=article.deleted?await this.deletion.receive(article,body,remote,false):await this.receiver.receiveWithStats(article,body,remote==='cloud-records'?'cloud-records':targetItemId?'cloud-'+remote:remote,false,targetItemId);
   if(publicId&&!article.deleted){await this.db.execute(`INSERT INTO cloud_rss_article_ids(item_id,article_id) SELECT item_id,? FROM sync_article_ids WHERE article_id=? AND item_id IS NOT NULL ON CONFLICT(item_id) DO UPDATE SET article_id=excluded.article_id`,[publicId,article.articleId]);const row=identities.find(r=>r.itemId===targetItemId);if(row){row.articleId=publicId;row.legacyMaterialized=false;}}
   if(remote==='cloud-rss-inventory'){const media=(incoming as ExportedArticle&{cloudMedia?:{audioUrl:string|null;videoUrl:string|null;publishedAt:string|null}}).cloudMedia;if(media)await this.db.execute('UPDATE articles SET audio_url=?,video_url=?,pub_date=? WHERE id=(SELECT item_id FROM sync_article_ids WHERE article_id=?)',[media.audioUrl,media.videoUrl,media.publishedAt,article.articleId]);}
   if(remote!=='cloud-rss-inventory'&&!article.deleted){const row=(await this.db.query('SELECT c.body_hash FROM article_sync_content c JOIN sync_article_ids m ON m.item_id=c.item_id WHERE m.article_id=?',[article.articleId]))[0];if(row){const realBody=!!(article.contentText.trim()||article.contentHtml?.trim()),ready=realBody||oldMeta?.content_hash===article.contentHash&&Number(oldMeta.body_ready)===1||String(row.body_hash)===article.contentHash;await this.db.execute(`INSERT INTO cloud_article_state(article_id,content_hash,body_hash,body_ready) VALUES(?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET content_hash=excluded.content_hash,body_hash=excluded.body_hash,body_ready=excluded.body_ready`,[article.articleId,article.contentHash,String(row.body_hash),ready?1:0]);}}
  }
  this.snapshotCache=undefined;return changed;
 });}

 resetPeerState(){return this.run(()=>this.sequence.reset());}
 markSuccess(pending:PendingSyncSuccess){return this.run(()=>this.sequence.markSuccess(pending));}
 /** Phone clearLibrary removes the RSS library and sync cursors while keeping
  * the watch identity, standalone notes, account and reader configuration.
  * privateData is reserved for the explicit local ownership-clear service. */
 clearLibrary(options:{privateData?:boolean}={}){return this.run(async()=>{
  await this.cloudState();
  const revision=await libraryRevision(this.db);
  const privateTables=options.privateData?(await this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('douyin_local_state','external_saved_migrations','sync_snapshot_retained')")).map(row=>String(row.name)):[];
  const channels=(await querySyncPages(this.db,'SELECT id,url FROM channels ORDER BY id')).map(r=>({id:Number(r.id),url:String(r.url)}));
  const itemIds=(await querySyncPages(this.db,'SELECT id FROM articles ORDER BY id')).map(r=>Number(r.id));
  await this.db.transaction([revisionGuard(revision),{sql:'DELETE FROM channels'},
   ...['cloud_rss_article_ids','cloud_article_state','cloud_source_state','sync_saved_states','sync_article_deletions','sync_article_ids','sync_article_aliases','local_article_deletions',
    'sync_source_states','sync_change_log','sync_peer_state','sync_snapshot_fingerprints'].map(table=>({sql:`DELETE FROM ${table}`})),
   ...(options.privateData?['memo_notes','memo_folders','llm_token_usage','article_deletion_cleanup',...privateTables].map(table=>({sql:`DELETE FROM ${table}`})):[]),
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
