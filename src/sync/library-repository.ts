import {cancellableSql} from '../core/sql-cancellation';
import type {SqlCancellationCheck} from '../core/types';
import {playbackWork} from '../core/playback-work';
import type {ReceiptBoundary} from './library-resume/store';
import type {FrozenResumeInventory,FrozenResumeArticle} from './library-resume/repository';
import {hash as resumeHash,CHUNK_BYTES as RESUME_CHUNK_BYTES} from './library-resume/wire';
import {idleHit} from '../diagnostics/idle-counters';
import type {FileCheckpoint} from '@podjs/framework/work-window';
import {mergeLegacyBookReading,legacyBookReadingArticle} from '../books/legacy-cloud-reading';
import {CloudReadingStore} from './cloud-reading-store';
import {utf8Encode} from '../cloud/types';
import type {RepositoryDiagnostic} from './repository-work';
import {LibraryClearError,type LibraryClearControl} from '../core/library-clear';
import {knownRecordValue} from '../cloud/compatibility';
import {ArticleRegisterStore} from './article-register-store';
import type {RecordDocument} from '../cloud/records';
import {ManifestContention,LibrarySnapshotBusyError} from './manifest-contention';
import {SqlDomainDefinitions,projectionGuard} from './domain-definitions';
import {LibraryProjectionCache,PROJECTION_EVENT_RETENTION} from './projection-cache';
import type {AfterReadingAck} from '../books/reading-delta';
import type {BookState,BookReading} from '../books/protocol';
import {BookSyncActions} from '../books/actions';
import type {BookFileInfo} from '../books/files';
import {stableArticleId} from './local-manifest';
import {libraryInventory} from './library-inventory';
import {PeerEchoStore} from './echo-store';
import {canonicalRssUrl,isLocalOnlyRssSource} from '../cloud/rss-identity';
import {querySyncPages} from './sql-pages.ts';
import type {SqlDatabase,SqlParams} from '../core/types.ts';
import {SyncArticleReceiver,type StagedArticleBody} from './article-receiver.ts';
import {LocalArticleManifestStore} from './local-manifest.ts';
import {SyncArticleDeletionStore} from './deletion-store.ts';
import {SqlSourceSyncStore,binaryChannelProjectionSchema,normalizeSourceUrl} from './source-store.ts';
import {SqlLibrarySequenceStore} from './sequence-store.ts';
import {reconcileSnapshotLog} from './snapshot-log.ts';
import {noteAssetKeys} from '../notes/cloud-assets';
import {libraryRevision,revisionGuard} from './revision.ts';
import {prepareArticle,bodyForRequest,type PreparedArticle,type ExportedArticle} from './article-export.ts';
import {isImportedContentUrl} from '../core/imported-content.ts';
import type {LibrarySessionRepository,LibraryWindow,PendingSyncSuccess} from './session.ts';
import type {ReceivedArticle,RequestedArticleBody} from './article-batches.ts';
import type {SyncedSource} from './library-wire.ts';
import type {ArticleManifest} from './manifest.ts';
import {SqlLibraryBodyRepository,type SqlLibraryRepositoryPorts,type RemovedLibraryContent} from './library-body-repository';
export type {SqlLibraryRepositoryPorts,RemovedLibraryContent} from './library-body-repository';
let snapshotScope=0;
const libraryProjectionScope=(canonical:boolean,books:boolean)=>(canonical?':canonical':'')+(books?':books-v1':'');
/** One shared instance serializes session operations. UI writes remain concurrent
 * and are detected by revision guards before advertising a sequence boundary. */
export class SqlLibraryCloudRepository extends SqlLibraryBodyRepository implements LibrarySessionRepository {
 /** Read-only C export: no RSS merge, cursor repair, reading migration or cache
  * publication. Each body's exact encoding is checked and discarded after its
  * bounded descriptor is captured; source reads later revalidate the version. */
 resumeFreeze(check:()=>void=()=>{}):Promise<FrozenResumeInventory>{return this.run(async()=>{
  const id=await this.identity(),revision=await libraryRevision(this.db);
  const local=new LocalArticleManifestStore(this.db,this.ports.codec,this.ports.text,this.ports.files,async()=>{throw Error('resume_read_only');});
  const prepared=await local.snapshot(true,false,!!this.books,check,undefined,true),bindings=local.projectionBindings(),articles:FrozenResumeArticle[]=[];
  for(const p of prepared){check();const full=p.manifest.bodyAvailable?await local.materializeRequested(p,undefined,true):p,bytes=full.encodedBody;
   const hashes:string[]=[];if(bytes)for(let at=0;at<bytes.length;at+=RESUME_CHUNK_BYTES)hashes.push(resumeHash(bytes.subarray(at,at+RESUME_CHUNK_BYTES)));
   articles.push({prepared:{article:{...full.article,contentHtml:null,contentText:''},manifest:full.manifest,encodedBody:null},binding:bindings.get(p.article.articleId)??null,chunkHashes:hashes});
  }
  const sources=await this.sources.export(id,undefined,true);check();if(await libraryRevision(this.db)!==revision)throw Error('SOURCE_CHANGED');
  return {articles,sources};
 });}
 resumeReadBody(item:FrozenResumeArticle):Promise<Uint8Array>{return this.run(async()=>{
  const local=new LocalArticleManifestStore(this.db,this.ports.codec,this.ports.text,this.ports.files,async()=>{throw Error('resume_read_only');});
  if(item.binding===null)throw Error('SOURCE_CHANGED');local.restoreProjectionBindings(new Map([[item.prepared.article.articleId,item.binding]]));
  try{const actual=await local.materializeRequested(item.prepared);if(!actual.encodedBody)throw Error('SOURCE_CHANGED');return actual.encodedBody;}catch(e){if(e instanceof Error&&/^Cached sync body/.test(e.message))throw new Error('SOURCE_CHANGED',{cause:e});throw e;}
 });}
 /** The B2 snapshot must not prepare the legacy article inventory. */
 binaryFreezeSources(check:()=>void){return this.run(async()=>{
  const id=await this.identity(),revision=await libraryRevision(this.db);
  const sources=await this.sources.export(id,undefined,true);
  check();if(await libraryRevision(this.db)!==revision)throw Error('SOURCE_CHANGED');
  return sources;
 });}
 private binaryArticleSchema?:Promise<unknown>;
 private initializeBinaryArticles(){
  return this.binaryArticleSchema??=this.db.transaction([{sql:`CREATE TABLE IF NOT EXISTS library_binary_article_versions(
   item_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
   updated_at INTEGER NOT NULL,source_device_id TEXT NOT NULL)`},{sql:binaryChannelProjectionSchema}]).catch(error=>{this.binaryArticleSchema=undefined;throw error;});
 }
 async binaryReceiveArticle(entry:ReceivedArticle,remote:string,receipt:ReceiptBoundary,staged:StagedArticleBody|null){
  await this.initializeBinaryArticles();
  return this.receiveArticle(entry,remote,false,receipt,{staged});
 }
 resumeReceiveArticle(entry:ReceivedArticle,remote:string,receipt:ReceiptBoundary){return this.receiveArticle(entry,remote,false,receipt);}
 binaryReceiveSource(source:SyncedSource,remote:string,receipt:ReceiptBoundary){return this.run(async()=>{
  if(source.deleted)await this.initializeBinaryArticles();
  return this.sources.merge([source],remote,await this.migrate(),false,receipt,true);
 });}
 resumeReceiveSource(source:SyncedSource,remote:string,receipt:ReceiptBoundary){return this.run(async()=>this.sources.merge([source],remote,await this.migrate(),false,receipt));}
 private receivedCount=0;
 private readonly receiver:SyncArticleReceiver;private readonly deletion:SyncArticleDeletionStore;
 private readonly sources:SqlSourceSyncStore;private readonly sequence:SqlLibrarySequenceStore;
 private readonly echo:PeerEchoStore;
 private readonly registerProjectionIds=new Map<string,string>();
 private peerCanonical=new Map<string,boolean>();private peerBooks=new Map<string,boolean>();
 private readonly projection:LibraryProjectionCache;
 private cloudProgress?:((unit:string)=>Promise<void>);
 setCloudProgress(sink?:(unit:string)=>Promise<void>){this.cloudProgress=sink;this.local.setCloudProgress(sink);}
 setCloudDiagnostic(sink?:RepositoryDiagnostic){this.cloudDiagnostic=sink;}
 private readonly definitions:SqlDomainDefinitions;private projectionGeneration?:string;
 private snapshotCache:{canonical:boolean;bookMode:boolean;revision:number;projectionSeq:number;articles:readonly PreparedArticle[];sources:readonly SyncedSource[];manifests:readonly ArticleManifest[]}|undefined;
 constructor(db:SqlDatabase,ports:SqlLibraryRepositoryPorts){
  super(db,ports);db=this.db;ports=this.ports;
  this.projection=new LibraryProjectionCache(db,()=>ports.text.yieldTurn?.()??db.query('SELECT 1'),f=>this.report(f));this.definitions=new SqlDomainDefinitions(db,ports.codec,undefined,undefined,f=>this.report(f));
  this.echo=new PeerEchoStore(db,ports.codec);
  this.receiver=new SyncArticleReceiver(db,ports.codec,ports.files,ports.migrateReading,this.now,(a,target)=>this.local.resolveIncomingBody(a,target),()=>this.projectionGeneration,(stage,ms)=>this.perf.add(stage,ms));
  this.deletion=new SyncArticleDeletionStore(db,ports.codec,(a,target)=>this.local.resolveIncomingBody(a,target),itemIds=>ports.cleanupRemovedContent({itemIds,channels:[]}));this.sources=new SqlSourceSyncStore(db,ports.uri,this.now,removed=>ports.cleanupRemovedContent({itemIds:removed.itemIds,channels:[removed.channel]}));this.sequence=new SqlLibrarySequenceStore(db,this.now);
 }
 async collectCloudNoteAssets(check:()=>void){
  if(!this.ports.noteAssetCollector)return 0;
  await this.mergeCloudNotes([],check);
  const references=async()=>{check();const rows=await this.db.query("SELECT markdown,base_markdown FROM memo_notes WHERE deleted=0"),conflicts=await this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='note_merge_conflicts'");
   const texts=rows.flatMap(r=>[String(r.markdown),String(r.base_markdown)]);
   if(conflicts.length)for(const r of await this.db.query('SELECT base_markdown,local_markdown,remote_markdown FROM note_merge_conflicts'))texts.push(String(r.base_markdown),String(r.local_markdown),String(r.remote_markdown));
   return new Set(texts.flatMap(text=>[...noteAssetKeys(text)]));
  };return this.ports.noteAssetCollector(references,check);
 }
 private async snapshotRetry(attempt:number,canonical:boolean,revision:number,sequence:number,reason:string){
  this.report({event:'library-work',stage:'snapshot-retry',outcome:'deferred',attempt,reason,durationMillis:0});
  if(!this.ports.diagnostic&&!this.cloudDiagnostic)return;
  try{const counts:Record<string,number>={source:0,url:0,bodyUrl:0,full:0,none:0,bookUrl:0,bookBodyUrl:0,bookOnly:0,cacheUrl:0,cacheNone:0,other:0};
   for(const row of await this.db.query('SELECT kind,COUNT(*) AS n FROM sync_projection_events WHERE seq>? GROUP BY kind',[sequence])){const key=String(row.kind);counts[Object.hasOwn(counts,key)?key:'other']+=Number(row.n);}
   this.report({stage:'repository.snapshot.retry',attempt,canonical:canonical?1:0,reason,revision,observedRevision:await libraryRevision(this.db),projectionSeq:sequence,observedProjectionSeq:await this.projection.sequence(),events:JSON.stringify(counts)});
  }catch{/* Diagnostics must not hide storage errors or change retry decisions. */}
 }
 private async legacySnapshot<T>(action:(articles:readonly PreparedArticle[],sources:readonly SyncedSource[],id:string)=>Promise<T>,canonical=false,bookMode=false,check?:()=>void):Promise<T>{
  await playbackWork.wait(check);
  idleHit(49);return this.work('legacySnapshot',async()=>{
  await this.prepareFastProjection();const generation=this.projectionGeneration!;
  this.local.restoreReusableBodies([]);check?.();
  const started=Date.now(),trace=(stage:string)=>this.report({stage,elapsedMs:Date.now()-started});
  const id=await this.migrate();if(bookMode)await this.books?.registerLocal([],check);trace('repository.migrate');
  const contention=new ManifestContention(this.db,()=>this.ports.text.yieldTurn?.()??this.db.query('SELECT 1'),fields=>this.report(fields));
  for(let attempt=0;attempt<3;attempt++){
   if(attempt)await contention.settle(attempt,check);
   check?.();let revision=await libraryRevision(this.db);const projectionSeq=await this.projection.sequence();
   try{
    let cached=this.snapshotCache,preparedSources:readonly SyncedSource[]|undefined;
    // A full library exchange can outlast five minutes. The revision guard,
    // rather than wall-clock age, determines whether this session snapshot
    // remains valid until exportRequested releases it.
    if(!cached||cached.revision!==revision||cached.canonical!==canonical||cached.bookMode!==bookMode){
     // Legacy reading-state migration writes to the library. Finish it before
     // taking the revision used to guard the expensive manifest build.
     await this.local.prepareReadingForSnapshot();trace('repository.reading');
     // Source clock publication also mutates the revision. Complete it before
     // the expensive article snapshot, avoiding a self-invalidated full rebuild.
     preparedSources=await this.sources.export(id);trace('repository.sources.prepare');
     revision=await libraryRevision(this.db);
     cached=this.snapshotCache;
    }
    if(!cached||cached.revision!==revision||cached.canonical!==canonical||cached.bookMode!==bookMode){
     const articles=await this.local.snapshot(true,canonical,bookMode,check);trace('repository.articles');this.report({stage:'manifest.inventory',canonical:canonical?1:0,inventory:JSON.stringify(libraryInventory(articles.map(a=>({...a.article,deleted:a.manifest.deleted}))))});const sourceRows=preparedSources??await this.sources.export(id),bookSources=bookMode?await this.books?.sourceUrls():undefined,sources=bookSources?sourceRows.filter(s=>!bookSources.has(s.url)):sourceRows;trace('repository.sources');
     await reconcileSnapshotLog(this.db,this.ports.codec,revision,id,articles.map(a=>a.manifest),sources,this.now(),libraryProjectionScope(canonical,bookMode),undefined,await this.needsProjectionSeed());trace('repository.fingerprints');
     if(await libraryRevision(this.db)!==revision){this.snapshotCache=undefined;await this.snapshotRetry(attempt+1,canonical,revision,projectionSeq,'revision');continue;}
     cached={canonical,bookMode,revision,projectionSeq:0,articles,sources,manifests:articles.map(a=>a.manifest)};this.snapshotCache=cached;
    }
    await this.db.transaction([projectionGuard(generation),{sql:"UPDATE sync_fast_definitions SET seeded=1 WHERE domain='library' AND generation=?",params:[generation]}]);
    const {articles,sources}=cached;
    const result=await action(articles,sources,id);if(await libraryRevision(this.db)===revision)return result;
    this.snapshotCache=undefined;
   }catch(error){check?.();if(await this.definitions.libraryGeneration()===generation&&await libraryRevision(this.db)===revision&&await this.projection.sequence()===projectionSeq)throw error;this.snapshotCache=undefined;await this.snapshotRetry(attempt+1,canonical,revision,projectionSeq,'validation');continue;}
   await this.snapshotRetry(attempt+1,canonical,revision,projectionSeq,'action');
  }
  throw new LibrarySnapshotBusyError();
  });
 }
 private async snapshot<T>(action:(articles:readonly PreparedArticle[],sources:readonly SyncedSource[],id:string,manifests:readonly ArticleManifest[])=>Promise<T>,canonical=false,bookMode=false,check?:()=>void,legacyCloud=false):Promise<T>{
  await playbackWork.wait(check);
  idleHit(48);if(!canonical&&legacyCloud)return this.legacySnapshot((articles,sources,id)=>action(articles,sources,id,articles.map(a=>a.manifest)),canonical,bookMode,check);check?.();
  await this.prepareFastProjection();const generation=this.projectionGeneration!;
  const started=Date.now(),trace=(stage:string)=>this.report({stage,elapsedMs:Date.now()-started});
  const id=await this.migrate();trace('repository.migrate');
  const contention=new ManifestContention(this.db,()=>this.ports.text.yieldTurn?.()??this.db.query('SELECT 1'),fields=>this.report(fields));
  let quickRetry=false;
  for(let attempt=0;attempt<3;attempt++){
   if(attempt&&!quickRetry)await contention.settle(attempt,check);
   quickRetry=false;
   check?.();let revision=await libraryRevision(this.db);const projectionSeq=await this.projection.sequence();
   try{
    let cached=this.snapshotCache;
    if(!cached||cached.revision!==revision||cached.projectionSeq!==projectionSeq||cached.canonical!==canonical||cached.bookMode!==bookMode){
     const scope=libraryProjectionScope(canonical,bookMode);
     let plan=await this.perf.time("snapshot.projection.plan",()=>this.projection.plan(scope,revision,bookMode));
     if(bookMode&&(!plan||plan.urls?.some(isImportedContentUrl))){await this.books?.registerLocal([],check);revision=await libraryRevision(this.db);plan=await this.projection.plan(scope,revision,bookMode);}
     if(!plan||plan.urls!==undefined)await this.perf.time("snapshot.reading",()=>this.local.prepareReadingForSnapshot(plan?.readingUrls??plan?.urls));
     trace('repository.reading');
     const sourceRows=await this.sources.export(id);trace('repository.sources.prepare');
     const preparedRevision=await libraryRevision(this.db);
     if(preparedRevision!==revision)plan=await this.projection.plan(scope,preparedRevision,bookMode);
     revision=preparedRevision;
     const dirty=new Set(plan?.urls),dirtyBodies=new Set(plan?.bodyUrls);
     this.local.restoreReusableBodies(plan?.rows.filter(r=>dirty.has(r.prepared.article.url)&&!dirtyBodies.has(r.prepared.article.url))??[],async p=>(await this.projection.full([p]))[0]!);
     if(plan)this.local.restoreProjectionBindings(new Map(plan.rows.filter(r=>!dirty.has(r.prepared.article.url)).map(r=>[r.prepared.article.articleId,r.sourceItem])));
     const observedSeq=plan?.seq??await this.projection.sequence();
     let articles:readonly PreparedArticle[],changedIds:Set<string>|undefined;
     if(plan&&plan.urls===undefined){articles=plan.rows.map(r=>r.prepared);changedIds=new Set();}
     else if(plan){
      const old=plan.rows.map(r=>r.prepared),changed=await this.local.snapshot(true,canonical,bookMode,check,plan.urls,false,!canonical);
      const kept=old.filter(p=>!dirty.has(p.article.url)),keptIds=new Set(kept.map(p=>p.article.articleId));
      const oldDirty=old.filter(p=>dirty.has(p.article.url)),oldIds=new Set(oldDirty.map(p=>p.article.articleId));
      const changedKeys=new Set(changed.map(p=>p.article.articleId));
      const unsafe=changed.some(p=>keptIds.has(p.article.articleId)||!dirty.has(p.article.url))||
       (!canonical&&(new Set(oldDirty.map(p=>p.article.url)).size!==dirty.size||oldIds.size!==changedKeys.size||[...oldIds].some(id=>!changedKeys.has(id))));
      if(unsafe){
       plan=undefined;this.local.restoreReusableBodies([]);
       await this.local.prepareReadingForSnapshot();
       articles=await this.local.snapshot(true,canonical,bookMode,check);
      }else{changedIds=new Set([...oldIds,...changedKeys]);articles=[...kept,...changed];}
     }else articles=await this.local.snapshot(true,canonical,bookMode,check);
     trace('repository.articles');
     const bookSources=bookMode?await this.books?.sourceUrls():undefined,sources=bookSources?sourceRows.filter(s=>!bookSources.has(s.url)):sourceRows;trace('repository.sources');
     const manifests=canonical?await this.perf.time('snapshot.wireManifests',()=>this.canonicalWireManifests(articles)):articles.map(a=>a.manifest);
     await reconcileSnapshotLog(this.db,this.ports.codec,revision,id,manifests,sources,this.now(),scope,changedIds,await this.needsProjectionSeed(),canonical);trace('repository.fingerprints');
     if(await libraryRevision(this.db)!==revision){this.snapshotCache=undefined;await this.snapshotRetry(attempt+1,canonical,revision,projectionSeq,'revision');continue;}
     if(!plan||plan.urls!==undefined)await this.projection.publish(scope,revision,articles,this.local.projectionBindings(),plan,plan?.urls,observedSeq,generation,!plan&&!canonical&&this.local.hasLegacyCoverage());
     const afterSeq=await this.projection.sequence();
     if(afterSeq!==observedSeq){
      // Derived cache writes can change the manifest's content witness. Read
      // the dirty plan again immediately once; use normal contention backoff
      // when source mutations or an incomplete event journal are involved.
      quickRetry=attempt===0&&await this.projection.onlyDerivedEvents(observedSeq,afterSeq);
      this.snapshotCache=undefined;await this.snapshotRetry(attempt+1,canonical,revision,observedSeq,'projection');continue;
     }
     this.report({stage:'repository.projection',cached:plan?1:0,dirtyUrls:plan?.urls?.length??0,articles:articles.length});
     cached={canonical,bookMode,revision,projectionSeq:observedSeq,articles,sources,manifests};this.snapshotCache=cached;
    }
    await this.db.transaction([projectionGuard(generation),{sql:"UPDATE sync_fast_definitions SET seeded=1 WHERE domain='library' AND generation=?",params:[generation]}]);
    const {articles,sources,manifests}=cached;
    const result=await action(articles,sources,id,manifests);if(await libraryRevision(this.db)===revision&&await this.projection.sequence()===cached.projectionSeq)return result;
    this.snapshotCache=undefined;
   }catch(error){check?.();if(await this.definitions.libraryGeneration()===generation&&await libraryRevision(this.db)===revision&&await this.projection.sequence()===projectionSeq)throw error;this.snapshotCache=undefined;await this.snapshotRetry(attempt+1,canonical,revision,projectionSeq,'validation');continue;}
   await this.snapshotRetry(attempt+1,canonical,revision,projectionSeq,'action');
  }
  throw new LibrarySnapshotBusyError();
 }
 private async needsProjectionSeed(){return !Number((await this.db.query("SELECT seeded FROM sync_fast_definitions WHERE domain='library'"))[0]?.seeded);}
 async prepareFastProjection(){await playbackWork.wait();idleHit(33);return this.work('prepareFastProjection',async()=>{
  await this.projection.initialize();await this.definitions.ensure();await this.projection.initialize();
  const generation=await this.definitions.libraryGeneration();
  if(this.projectionGeneration!==generation){this.projectionGeneration=generation;this.snapshotCache=undefined;this.local.setEncodingGeneration(generation);}
 });
 }
 async canSkipLibrary(peer:string){
  await this.prepareFastProjection();if(await this.changedIdentityMode(peer)||await this.sequence.fastPathRequiresFull(peer))return false;
  const scope=libraryProjectionScope(!!this.peerCanonical.get(peer),!!this.peerBooks.get(peer));
  // The selected scope must still cover the retained event journal. The
  // domain root witnesses relevant changes after that projection was built.
  return !!(await this.db.query(`WITH latest(seq) AS (SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='sync_projection_events'),0))
   SELECT 1 FROM sync_fast_library_baseline b
   JOIN sync_fast_definitions d ON d.domain='library' AND d.generation=b.generation AND d.seeded=1
   JOIN sync_projection_header h ON h.scope=? JOIN latest
   WHERE b.peer=? AND b.generation=? AND h.seq BETWEEN max(0,latest.seq-?) AND latest.seq
   AND h.revision<=(SELECT revision FROM sync_library_revision WHERE id=1)
   AND (h.seq=latest.seq OR h.seq+1>=COALESCE((SELECT MIN(seq) FROM sync_projection_events),latest.seq+1))`,[scope,peer,this.projectionGeneration,PROJECTION_EVENT_RETENTION]))[0];
 }
 domainDefinitions(){return this.definitions;}
 configurePeer(peer:string,capabilities:{supportsRssCanonicalIds?:boolean;supportsBookSyncV1?:boolean}){this.peerCanonical.set(peer,capabilities.supportsRssCanonicalIds===true);this.peerBooks.set(peer,!!this.books&&capabilities.supportsBookSyncV1===true);}
 private async changedIdentityMode(peer:string){const previous=(await this.db.query('SELECT rss_canonical,book_sync FROM sync_peer_features WHERE peer_device_id=?',[peer]))[0];return previous?!!Number(previous.rss_canonical)!==!!this.peerCanonical.get(peer)||!!Number(previous.book_sync)!==!!this.peerBooks.get(peer):!!this.peerCanonical.get(peer)||!!this.peerBooks.get(peer);}
 /** The manifest window captures its own upper bound after source merge. Never
  * acknowledge or fabricate a sequence to avoid materializing before that merge. */
 exchangeCursor(peer:string){return this.run(async()=>{await this.migrate();await this.prepareFastProjection();const c=await this.sequence.cursor(peer);return await this.changedIdentityMode(peer)?{...c,lastRemoteSeqApplied:0,lastLocalSeqAckedByPeer:0}:c;});}
 cursor(peer:string,check?:()=>void){return this.run(()=>this.snapshot(async()=>{const c=await this.sequence.cursor(peer);return await this.changedIdentityMode(peer)?{...c,lastRemoteSeqApplied:0,lastLocalSeqAckedByPeer:0}:c;},!!this.peerCanonical.get(peer),!!this.peerBooks.get(peer),check));}
 mergeSources(sources:readonly SyncedSource[],remote:string,authoritative:boolean,check?:SqlCancellationCheck){return this.run(async()=>this.sources.merge(sources,remote,await this.migrate(),authoritative,undefined,false,check));}
 prepareWindow(peer:string,peerAppliedLocalSeq:number,check?:()=>void):Promise<LibraryWindow>{return this.run(()=>this.perf.time("window.total",()=>this.snapshot(async(_articles,sources,id,manifests)=>{
   const window=await this.sequence.prepareWindow(peer,id,manifests,async urls=>urls?sources.filter(s=>urls.includes(s.url)):sources,peerAppliedLocalSeq,{snapshotReconciled:true});
   window.projectionGeneration=this.projectionGeneration;window.fullRssSources=sources;
   if(await this.changedIdentityMode(peer))return {...window,articleManifest:manifests,rssSources:sources,fullSnapshot:true,fromSeqExclusive:0,fallbackReason:'articleIdentityChanged'};
   if(!(await this.db.query('SELECT peer FROM sync_fast_library_baseline WHERE peer=? AND generation=?',[peer,this.projectionGeneration])).length)return {...window,articleManifest:manifests,rssSources:sources,fullSnapshot:true,fromSeqExclusive:0,fallbackReason:'projectionChanged'};
   return window.fullSnapshot?window:{...window,...await this.echo.filter(peer,window.articleManifest,window.rssSources)};
  },!!this.peerCanonical.get(peer),!!this.peerBooks.get(peer),check)).finally(()=>this.perf.flush("window.perf")));}
 private async canonicalWireManifests(articles:readonly PreparedArticle[]){
  const urls=[...new Set(articles.filter(p=>p.article.rssSourceUrl&&!isImportedContentUrl(p.article.rssSourceUrl)).map(p=>p.article.url))];
  const identities=await this.local.wireRssIdentitiesForUrls(urls,this.projectionGeneration!);
  const counts=new Map<string,number>(),byId=new Map<string,typeof identities>();
  for(const row of identities){
   counts.set(row.nativeArticleId,(counts.get(row.nativeArticleId)??0)+1);
   const group=byId.get(row.articleId)??[];group.push(row);byId.set(row.articleId,group);
  }
  return articles.map(p=>{
   const rows=byId.get(p.article.articleId);if(!rows)return p.manifest;
   const legacy=[...new Set(rows.flatMap(r=>[r.localArticleId,...(counts.get(r.nativeArticleId)===1?[r.nativeArticleId]:[])]))].filter(id=>id!==p.article.articleId);
   return legacy.length?{...p.manifest,legacyArticleIds:legacy}:p.manifest;
  });
 }

 exportSources(peer?:string,check?:()=>void){return this.run(()=>this.snapshot(async(_a,sources)=>sources,!!this.peerCanonical.get(peer??''),!!this.peerBooks.get(peer??''),check));}
 receiveArticle(entry:ReceivedArticle,remote:string,authoritative:boolean,boundary?:ReceiptBoundary|SqlCancellationCheck,binary?:{staged:StagedArticleBody|null}){
  const cancel=typeof boundary==='function'?boundary:undefined,db=cancellableSql(this.db,cancel);
  const receipt:ReceiptBoundary|undefined=typeof boundary==='function'?{check:boundary,transaction:db.transaction,transactionChanges:db.transactionChanges,before:[],after:()=>[]}:boundary;
  return this.run(()=>this.perf.time('receive.total',async()=>{await this.perf.time('receive.migrate',()=>this.migrate());if(!binary&&!this.projectionGeneration)await this.prepareFastProjection();const mapped=await this.perf.time('receive.bookMapping',async()=>this.books?.mapping(entry.article.articleId,entry.article.url));if(mapped){const book=(await this.books!.states()).find(b=>b.bookId===mapped.bookId);if(book&&(book.deleted||book.deletedChapters.includes(mapped.chapterIndex))){if(receipt){receipt.check?.();await (receipt.transaction??this.db.transaction)([...receipt.before,...receipt.after('retainedLocal')]);}return 0;}}let target;
   if(entry.article.rssSourceUrl&&!isImportedContentUrl(entry.article.rssSourceUrl)){const candidates=(await this.perf.time('receive.identity',()=>this.local.cloudRssIdentities({sourceUrl:entry.article.rssSourceUrl!,url:entry.article.url,ids:[entry.article.articleId,...entry.article.legacyArticleIds??[]]},binary?receipt?.check:undefined,!!binary))).filter(r=>r.sourceUrl===entry.article.rssSourceUrl);target=this.peerCanonical.get(remote)?candidates.find(r=>r.articleId===entry.article.articleId)??candidates.find(r=>r.legacyMaterialized&&r.url===entry.article.url&&entry.article.legacyArticleIds?.includes(r.localArticleId)):candidates.find(r=>r.canonicalBinding&&r.localArticleId===entry.article.articleId&&r.url===entry.article.url);if(!target&&!this.peerCanonical.get(remote)){const legacy=candidates.filter(r=>r.canonicalBinding&&r.nativeArticleId===entry.article.articleId&&r.url===entry.article.url);if(legacy.length===1)target=legacy[0];}}
   const article=target?{...entry.article,articleId:target.localArticleId,legacyArticleIds:[...new Set([...entry.article.legacyArticleIds??[],entry.article.articleId])].filter(id=>id!==target.localArticleId)}:entry.article,body={...entry.body,articleId:article.articleId};
   const canonical=this.peerCanonical.get(remote)&&!article.deleted&&article.rssSourceUrl&&!isImportedContentUrl(article.rssSourceUrl)?{sql:`INSERT INTO cloud_rss_article_ids(item_id,article_id) SELECT item_id,? FROM sync_article_ids WHERE article_id=? AND item_id IS NOT NULL ON CONFLICT(item_id) DO UPDATE SET article_id=excluded.article_id WHERE cloud_rss_article_ids.article_id IS NOT excluded.article_id`,params:[entry.article.articleId,article.articleId]}:undefined;const atomic=receipt&&canonical?{...receipt,after:(outcome:import('./library-resume/wire').Outcome)=>[canonical,...receipt.after(outcome)]}:receipt;const applied=article.deleted?await this.deletion.receive(article,body,remote,authoritative,atomic,!!receipt&&!cancel,binary?this.local.resolveIncomingItem.bind(this.local):undefined):await this.receiver.receiveWithStats(article,body,remote,authoritative,target?.itemId,!!target,atomic,binary);if(canonical&&!receipt)await this.db.execute(canonical.sql,canonical.params);if(++this.receivedCount%100===0)this.perf.flush('receive.perf');return applied;
  }));}
 exportRequested(requests:readonly RequestedArticleBody[],peer?:string){return this.run(async()=>{
  this.perf.flush('receive.perf.final');
  try{
   if(requests.length===0)return [];
   const canonical=!!(peer&&this.peerCanonical.get(peer));
   return await this.snapshot(async(articles,_sources,_device,manifests)=>{
    const ids=new Set(requests.map(r=>r.articleId));
    const selected=articles.filter(a=>ids.has(a.article.articleId)&&a.manifest.bodyAvailable),outgoing:PreparedArticle[]=[];
    for(let start=0;start<selected.length;start+=32)outgoing.push(...await this.local.materializeRequestedBatch(await this.projection.full(selected.slice(start,start+32))));
    if(!canonical)return outgoing;
    const byId=new Map(manifests.filter(m=>ids.has(m.articleId)).map(m=>[m.articleId,m]));
    // Alias uniqueness was established over the entire window.
    return outgoing.map(p=>{
     const manifest=byId.get(p.article.articleId)!;
     return {...p,manifest,article:{...p.article,...(manifest.legacyArticleIds?{legacyArticleIds:manifest.legacyArticleIds}:{})}};
    });
   },canonical,!!(peer&&this.peerBooks.get(peer)));
  }finally{
   if(this.snapshotCache&&this.snapshotCache.articles.reduce((n,a)=>n+(a.encodedBody?.length??0)+2*(a.article.contentHtml?.length??0)+2*a.article.contentText.length,0)>32*1024*1024)this.snapshotCache=undefined;
  }
 });}

 private sourceProjection(s:SyncedSource){return JSON.stringify([s.title,s.sortOrder,s.isPinned,s.deleted,s.deletedAt]);}
 private async cloudSourcesForExport(sources:readonly SyncedSource[],device:string,readOnly=false){
  const state=new Map((await querySyncPages(this.db,'SELECT * FROM cloud_source_state ORDER BY url')).map(r=>[String(r.url),r]));const out:SyncedSource[]=[];
  for(const source of sources){const projection=this.sourceProjection(source),old=state.get(source.url);let clock=old?Number(old.changed_at):Math.max(1,source.deletedAt,source.createdAt),provenance=old?String(old.device):device;
   if(old&&old.projection!==projection){clock=Math.max(this.now(),clock+1,source.deletedAt);provenance=device;}
   if((!old||old.projection!==projection)&&!readOnly)await this.db.execute('INSERT OR REPLACE INTO cloud_source_state(url,projection,changed_at,device) VALUES(?,?,?,?)',[source.url,projection,clock,provenance]);out.push({...source,updatedAt:clock,sourceDeviceId:provenance});
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

 cloudBooks(check?:()=>void){return this.run(async()=>{await this.migrate();await this.books?.registerLocal([],check);return {books:await this.books?.states()??[],reading:await this.books?.readingStates()??[],mappings:await this.books?.mappings()??[]};});}
 mergeCloudBooks(books:readonly BookState[],reading:readonly BookReading[],check?:()=>void){return this.run(async()=>{await this.migrate();if(!this.books)throw Error('book_storage_unavailable');await this.books.prepareCloudMerge(books,reading,check);let applied=0;for(const b of books){check?.();applied+=await this.books.merge(b);}for(let at=0;at<reading.length;at+=100){check?.();applied+=await this.books.mergeReadingBatch(reading.slice(at,at+100));}return applied;});}
 get receiveCloudBookFile(){
  return this.ports.bookFiles?.adopt? (id:string,file:BookFileInfo,checkpoint:FileCheckpoint)=>this.installCloudBookFile(id,file,checkpoint):undefined;
 }
 private installCloudBookFile(id:string,file:BookFileInfo,checkpoint:FileCheckpoint){
  return this.run(async()=>{
   await this.migrate();
   const books=this.books,adopt=this.ports.bookFiles?.adopt;
   if(!books||!adopt)throw Error('book_storage_unavailable');
   await checkpoint.check();
   const published=await adopt(file,id);
   return books.installPackage(published,id,checkpoint,true);
  });
 }
 // Reading needs verified saved metadata, not a fresh legacy body manifest.
 // Hydrate lazy projection metadata before inspecting save clocks and orders.
 cloudSources(){return this.run(()=>this.work('cloudSources',async()=>{await this.cloudState();const id=await this.identity();const sources=await this.sources.export(id,undefined,true),books=await this.books?.sourceUrls();return this.cloudSourcesForExport(books?sources.filter(s=>!books.has(s.url)):sources,id,true);}));}
 cloudReadingRevision(){return this.run(()=>libraryRevision(this.db));}
 private readingStore?:CloudReadingStore;
 private readingIndex?:{revision:number;hashes:Map<string,number[]>};
 private async readingCandidates(check?:()=>void,hashes?:readonly string[],work?:<T>(stage:import('../cloud/records').RecordWorkProgress['stage'],units:number,run:()=>Promise<T>)=>Promise<T>){idleHit(32);
  check?.();await this.cloudState();let revision=await libraryRevision(this.db);
  if(!this.readingIndex||this.readingIndex.revision!==revision){
   const values=await (work?work('reading-index',1,()=>this.local.cloudReadingIndex(check)):this.local.cloudReadingIndex(check)),index=new Map<string,number[]>();for(const r of values)for(const key of ['article_hash','url_hash','legacy_hash','bound_hash']){const hash=String(r[key]??'');if(hash){const ids=index.get(hash)??[];if(!ids.includes(Number(r.item_id)))ids.push(Number(r.item_id));index.set(hash,ids);}}
   if(await libraryRevision(this.db)!==revision)throw new LibrarySnapshotBusyError();this.readingIndex={revision,hashes:index};
  }
  const ids=[...new Set(hashes?hashes.flatMap(h=>this.readingIndex!.hashes.get(h)??[]):[...this.readingIndex.hashes.values()].flat())],out:ExportedArticle[]=[];
  for(let at=0;at<ids.length;at+=100){check?.();const page=await this.local.cloudRestoreMetadata({itemIds:ids.slice(at,at+100),limit:100},check);out.push(...page.articles);}check?.();return out;
 }
 cloudReadingCandidates(check?:()=>void,hashes?:readonly string[],work?:<T>(stage:import('../cloud/records').RecordWorkProgress['stage'],units:number,run:()=>Promise<T>)=>Promise<T>){return this.run(()=>this.work('cloudReading',()=>this.readingCandidates(check,hashes,work)));}
 mergeCloudLegacyBookReading(articles:readonly ExportedArticle[],check:()=>void=()=>{}){return this.run(()=>this.work('cloudLegacyBookReading',async()=>{check();const selected=articles.filter(legacyBookReadingArticle);if(!selected.length||!this.books)return {changed:0,remaining:[...articles]};const result=await mergeLegacyBookReading(this.db,this.books,selected,check),accepted=new Set(selected.filter(a=>!result.remaining.includes(a)));if(result.changed)this.snapshotCache=undefined;return {changed:result.changed,remaining:articles.filter(a=>!accepted.has(a))};}));}
 mergeCloudReading(articles:readonly ExportedArticle[],check:()=>void=()=>{}){return this.run(()=>this.work('cloudReading',async()=>{await this.cloudState();const before=await libraryRevision(this.db),result=await (this.readingStore??=new CloudReadingStore(this.db,async ids=>{if(this.ports.prepareReadingMigration)return this.ports.prepareReadingMigration(ids);if(this.ports.migrateReadingMany)await this.ports.migrateReadingMany(ids);else for(const id of ids)await this.ports.migrateReading(id);return [];})).merge(articles,check,false,before);if(this.readingIndex?.revision===before)this.readingIndex.revision=result.revision;else this.readingIndex=undefined;if(result.remaining.length)throw Error('cloud_reading_target_changed');if(result.changed)this.snapshotCache=undefined;return result.changed;}));}
 async mergeCloudPublicMetadata(articles:readonly ExportedArticle[],check:()=>void=()=>{},work?:<T>(stage:import('../cloud/records').RecordWorkProgress['stage'],units:number,run:()=>Promise<T>)=>Promise<T>){return this.run(async()=>{
  const hashes=await Promise.all(articles.map(a=>this.ports.codec.sha256(utf8Encode(a.articleId)))),candidates=await this.readingCandidates(check,hashes,work),byKey=new Map(candidates.map(a=>[a.rssSourceUrl+'\0'+a.articleId,a]));
  const targeted=articles.map(a=>({...a,cloudReadingItemId:byKey.get(a.rssSourceUrl+'\0'+a.articleId)?.cloudReadingItemId})),before=await libraryRevision(this.db),result=await (this.readingStore??=new CloudReadingStore(this.db,async ids=>{if(this.ports.prepareReadingMigration)return this.ports.prepareReadingMigration(ids);if(this.ports.migrateReadingMany)await this.ports.migrateReadingMany(ids);else for(const id of ids)await this.ports.migrateReading(id);return [];})).merge(targeted,check,true,before);
  if(this.readingIndex?.revision===before)this.readingIndex.revision=result.revision;else this.readingIndex=undefined;if(result.changed)this.snapshotCache=undefined;return result;
 });}


 private async registerProjectionId(item:number,url:string){const key=String(item)+'\0'+url;let id=this.registerProjectionIds.get(key);if(!id){id=await stableArticleId(url,this.ports.text.parseUri,this.ports.codec);if(this.registerProjectionIds.size>=8192)this.registerProjectionIds.delete(this.registerProjectionIds.keys().next().value!);this.registerProjectionIds.set(key,id);}return id;}
 cloudArticleRegisters(){return this.run(async()=>{const docs=await new ArticleRegisterStore(this.db,this.ports.codec.sha256).documents(),byId=new Map(docs.map(d=>[d.value.articleId,d])),rows=await querySyncPages(this.db,'SELECT p.article_id,a.id,COALESCE(a.link,a.dedup_key) AS url,r.article_id AS rss_id FROM article_register_state p JOIN articles a ON a.id=p.item_id LEFT JOIN cloud_rss_article_ids r ON r.item_id=a.id ORDER BY p.article_id');for(const row of rows){const doc=byId.get(String(row.article_id));if(!doc)continue;const id=await this.registerProjectionId(Number(row.id),String(row.url));doc.projectionAliases=[id,...(row.rss_id?[String(row.rss_id)]:[])];}return docs;});}
 mergeCloudArticleRegisters(documents:RecordDocument[]){return this.run(()=>this.work('cloudMetadata',async()=>{await this.cloudState();await this.migrate();const store=new ArticleRegisterStore(this.db,this.ports.codec.sha256);let changed=0;
  for(let at=0;at<documents.length;at+=20){const part=documents.slice(at,at+20),page=await this.local.cloudRestoreMetadata({ids:part.map(d=>String(d.value.articleId)),urls:part.flatMap(d=>typeof d.value.url==='string'?[d.value.url]:[]),limit:100}),local=new Map<string,ExportedArticle>();for(const a of page.articles)for(const id of [a.articleId,...(a.cloudLegacyArticleIds??[])])local.set(id,a);
   for(const doc of part){const old=local.get(doc.value.articleId),result=await store.apply(doc,old?{kind:'article',value:{...knownRecordValue('article',old),articleId:doc.value.articleId}}:undefined);changed+=result.changed;if(result.removed.length)await this.ports.cleanupRemovedContent({itemIds:result.removed,channels:[]});}
  }if(changed)this.snapshotCache=undefined;return changed;}));}

 cloudSnapshot(full:boolean,check?:()=>void){return this.run(()=>this.work('cloudSnapshot',async()=>{await this.cloudState();
  // An incomplete private body still depends on the legacy encoding witness.
  // Keep that path until receive certifies the body; completed restores share
  // the canonical projection with reading replay instead of rebuilding it.
  const canonical=!(await this.db.query(`SELECT 1 FROM cloud_article_state m JOIN sync_article_ids s ON s.article_id=m.article_id JOIN articles a ON a.id=s.item_id JOIN channels c ON c.id=a.channel_id
   WHERE m.body_ready=0 AND (c.url='watchrss://phone-imports' OR c.url LIKE 'https://watchrss.local/import-%' OR a.is_saved=1
    OR EXISTS(SELECT 1 FROM article_saved_states v WHERE v.article_id=a.id AND v.saved=1)
    OR EXISTS(SELECT 1 FROM sync_saved_states v WHERE v.item_id=a.id AND v.saved=1)) LIMIT 1`)).length;
  return this.snapshot(async(light,sources,device)=>{
  const articles=await this.projection.full(light);
  const identities=await this.local.cloudRssIdentities(undefined,check),byCanonical=new Map(identities.map(r=>[r.articleId,r])),byNative=new Map(identities.flatMap(r=>[[r.localArticleId,r],[r.nativeArticleId,r]] as const)),byUrl=new Map(identities.map(r=>[r.sourceUrl+'\0'+r.url,r]));
  const cloudIdentity=(a:ExportedArticle)=>{if(a.cloudRssArticleId)return a;if(!a.rssSourceUrl||isImportedContentUrl(a.rssSourceUrl)||isImportedContentUrl(a.url)||isLocalOnlyRssSource(a.rssSourceUrl))return a;const row=byNative.get(a.articleId)??byUrl.get(a.rssSourceUrl+'\0'+a.url);return row?{...a,articleId:row.articleId,cloudRssArticleId:row.articleId,cloudLegacyArticleIds:[row.localArticleId,row.nativeArticleId].filter(id=>id!==row.articleId),url:row.url}:undefined;};
  const exported:ExportedArticle[]=[];
  // Cloud export uses the same bounded, verified batches as phone sync.
  // Prefetching body rows also keeps small cached text inline, instead of two
  // SQL text reads and a separate row SELECT for every article.
  const privateBody=(a:ExportedArticle)=>isImportedContentUrl(a.url)||isImportedContentUrl(a.rssSourceUrl)||!a.rssSourceUrl?.trim()||a.favoriteSaved||a.watchLaterSaved;
  for(let at=0;at<articles.length;at+=32){check?.();const page=articles.slice(at,at+32),requested=page.filter(item=>full&&privateBody(item.article));
   const bodies=await this.local.materializeRequestedBatch(requested);let next=0;
   for(const item of page)exported.push(full&&privateBody(item.article)?bodies[next++]!.article:{...item.article,contentHtml:null,contentText:''});
  }
  const states=new Map(exported.map(a=>[a.articleId,a]));
  const bookIds=await this.books?.chapterIds();for(const a of await this.local.cloudReadingStates(false,check)){if(bookIds?.has(a.articleId))continue;const old=states.get(a.articleId);if(!old)states.set(a.articleId,a);else if(!old.independentSaved&&!old.rssSourceUrl)states.set(a.articleId,{...old,rssSourceUrl:a.rssSourceUrl,rssSourceTitle:a.rssSourceTitle,readingProgress:a.readingProgress,readingPositionBytes:a.readingPositionBytes,readingPositionContentHash:a.readingPositionContentHash,readingPositionChangedAt:a.readingPositionChangedAt,isRead:a.isRead});}
  // Saved-state tombstones in the phone protocol omit their RSS origin. Restore
  // the local origin before cloud retention decisions so unsaving drops the body.
  const origins=await querySyncPages(this.db,`SELECT m.article_id,c.url,c.title FROM sync_article_ids m JOIN articles a ON a.id=m.item_id JOIN channels c ON c.id=a.channel_id WHERE c.url LIKE 'http://%' OR c.url LIKE 'https://%' ORDER BY a.id,m.article_id`);
  const originById=new Map(origins.map(r=>[String(r.article_id),r]));
  const origin=(a:ExportedArticle)=>{const identity=byNative.get(a.articleId),row=originById.get(a.articleId)??(identity?{url:identity.sourceUrl,title:sources.find(s=>s.url===identity.sourceUrl)?.title??''}:undefined);return row&&!a.independentSaved&&!a.rssSourceUrl?{...a,rssSourceUrl:String(row.url),rssSourceTitle:String(row.title)}:a;};
  for(const [id,a]of states)states.set(id,origin(a));

  // A canonical projection may retain a prior full metadata row while its
  // manifest advances a save cancellation. Read the authoritative logical
  // saved registers before exporting; never echo the cached former save.
  const savedRegisters=new Map((await querySyncPages(this.db,"SELECT article_id,save_type,saved,changed_at,sort_order FROM sync_saved_states WHERE save_type IN ('favorite','watchLater') ORDER BY article_id,save_type")).map(r=>[String(r.article_id)+'\0'+String(r.save_type),r]));
  const savedState=(a:ExportedArticle)=>{const identity=byNative.get(a.articleId)??byCanonical.get(a.articleId),ids=[...new Set([a.articleId,identity?.localArticleId,identity?.nativeArticleId].filter((id):id is string=>!!id))];let out=a;
   for(const type of ['favorite','watchLater'] as const){let selected:Record<string,unknown>|undefined;for(const id of ids){const row=savedRegisters.get(id+'\0'+type);if(row&&(!selected||Number(row.changed_at)>Number(selected.changed_at)))selected=row;}
    if(selected&&Number(selected.changed_at)>=(type==='favorite'?a.favoriteChangedAt:a.watchLaterChangedAt))out={...out,[type+'Saved']:!!Number(selected.saved),[type+'ChangedAt']:Number(selected.changed_at),[type+'SortOrder']:Number(selected.sort_order)};
   }return out;
  };
  const bodyHashes=new Map(articles.map(p=>[p.article.articleId,p.manifest.bodyHash]));
  const metadata=new Map((await querySyncPages(this.db,'SELECT * FROM cloud_article_state ORDER BY article_id')).map(r=>[String(r.article_id),r]));
  const normalize=(a:ExportedArticle)=>{const m=metadata.get(a.articleId)??metadata.get((byNative.get(a.articleId)??byCanonical.get(a.articleId))?.localArticleId??'');return m?{...a,...((bodyHashes.get(a.articleId)===m.body_hash||a.contentHash===m.body_hash)?{contentHash:String(m.content_hash)}:{}),...(m.reading_source&&a.readingPositionChangedAt===Number(m.reading_clock)?{sourceDeviceId:String(m.reading_source)}:{})}:a;};
  const pendingPrivateArticleIds=exported.filter(a=>{const m=metadata.get(a.articleId)??metadata.get((byNative.get(a.articleId)??byCanonical.get(a.articleId))?.localArticleId??'');return !a.deleted&&(a.independentSaved||a.favoriteSaved||a.watchLaterSaved||isImportedContentUrl(a.url)||isImportedContentUrl(a.rssSourceUrl))&&m&&(bodyHashes.get(a.articleId)===m.body_hash||a.contentHash===m.body_hash)&&!Number(m.body_ready);}).map(a=>a.articleId);
  const project=(rows:ExportedArticle[])=>rows.map(cloudIdentity).filter((a):a is ExportedArticle=>!!a);
  return {articles:project(exported.map(origin).map(savedState).map(normalize)),sources:await this.cloudSourcesForExport(sources,device),stateArticles:project([...states.values()].map(savedState).map(normalize)),pendingPrivateBodies:pendingPrivateArticleIds.length>0,pendingPrivateArticleIds:pendingPrivateArticleIds.map(id=>byNative.get(id)?.articleId??id)};
 },canonical,!!this.books,check,true);}));}
 mergeCloud(sources:readonly SyncedSource[],articles:readonly ExportedArticle[],remote:string,check?:()=>void){return this.run(async()=>{
  await this.cloudState();const id=await this.migrate();const publicUrls=articles.filter(a=>a.rssSourceUrl&&!isImportedContentUrl(a.rssSourceUrl)&&!isLocalOnlyRssSource(a.rssSourceUrl)).map(a=>a.url),identities=publicUrls.length?await this.local.cloudRssIdentitiesForUrls(publicUrls,check,await this.local.cloudReadingItemIds(await Promise.all(articles.map(a=>this.ports.codec.sha256(utf8Encode(a.articleId)))),check)):[];let changed=remote==='cloud-records'?await this.mergeCloudSources(sources,id):await this.sources.merge(sources,remote,id,false);
  const protectedIds=new Set((await querySyncPages(this.db,'SELECT article_id FROM article_register_state ORDER BY article_id')).map(r=>String(r.article_id)));
  for(const incoming of articles){check?.();
   if(protectedIds.has(incoming.articleId)){if(!incoming.deleted&&(incoming.contentText.trim()||incoming.contentHtml?.trim()))changed+=await new ArticleRegisterStore(this.db,this.ports.codec.sha256).restoreBody(incoming,await this.prepareCloudArticle(incoming),this.ports.files);continue;}
   const bookMapping=await this.books?.mapping(incoming.articleId,incoming.url);if(bookMapping){const state=(await this.books!.states()).find(b=>b.bookId===bookMapping.bookId)!;if(incoming.deleted&&state.lifecycle&&(incoming.deletedAt||incoming.updatedAt||0)<=state.lifecycle.startedAt)continue;const values={bookId:bookMapping.bookId,chapterIndex:bookMapping.chapterIndex,isRead:incoming.isRead,readingProgress:incoming.readingProgress,readingPositionBytes:incoming.readingPositionBytes,readingPositionContentHash:incoming.readingPositionContentHash,readingPositionChangedAt:incoming.readingPositionChangedAt,sourceDeviceId:incoming.sourceDeviceId,favoriteSaved:incoming.favoriteSaved,favoriteChangedAt:incoming.favoriteChangedAt,favoriteSortOrder:incoming.favoriteSortOrder,watchLaterSaved:incoming.watchLaterSaved,watchLaterChangedAt:incoming.watchLaterChangedAt,watchLaterSortOrder:incoming.watchLaterSortOrder};changed+=await this.books!.mergeReading(values);if(incoming.deleted){const state=(await this.books!.states()).find(b=>b.bookId===bookMapping.bookId)!;changed+=await this.books!.merge({...state,deletedChapters:[...new Set([...state.deletedChapters,bookMapping.chapterIndex])].sort((a,b)=>a-b),deletionClock:Math.max(state.deletionClock,incoming.deletedAt,incoming.updatedAt)});}continue;}
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
   // Fold the accepted wire witness into the existing metadata lookup. All
   // lookups use primary keys; do not scan RSS IDs once per imported article.
   const metaRow=(await this.db.query(`SELECT m.*,CASE WHEN e.body_hash=c.body_hash THEN c.body_hash END AS wire_body_hash
    FROM (SELECT 1) LEFT JOIN cloud_article_state m ON m.article_id=?
    LEFT JOIN article_sync_content c ON c.item_id=COALESCE(?,(SELECT item_id FROM sync_article_ids WHERE article_id=?))
    LEFT JOIN article_sync_encoding_cache e ON e.item_id=c.item_id`,[article.articleId,targetItemId??null,article.articleId]))[0];
   const oldMeta=metaRow?.article_id==null?undefined:metaRow;
   if(remote==='cloud-records'){const existing=(await this.db.query('SELECT a.title,a.description,a.image_url,a.fetched_at FROM sync_article_ids m JOIN articles a ON a.id=m.item_id WHERE m.article_id=?',[article.articleId]))[0];if(existing&&Number(existing.fetched_at)>article.updatedAt)article={...article,title:String(existing.title),excerpt:String(existing.description??''),imageUrl:existing.image_url==null?null:String(existing.image_url),updatedAt:Number(existing.fetched_at),contentHash:oldMeta?String(oldMeta.content_hash):article.contentHash};}
   const prepared=await prepareArticle(article,this.ports.codec,true,typeof metaRow?.wire_body_hash==='string'?metaRow.wire_body_hash:undefined);
   const body=bodyForRequest(prepared,{articleId:article.articleId,bodyHash:'',metadataOnly:false,chunkIndexes:[]});
   changed+=article.deleted?await this.deletion.receive(article,body,remote,false):await this.receiver.receiveWithStats(article,body,remote==='cloud-records'||remote==='cloud-rss-inventory'?remote:targetItemId?'cloud-'+remote:remote,false,targetItemId);
   if(publicId&&!article.deleted&&(remote==='cloud-rss-inventory'||incoming.cloudRssArticleId)){await this.db.execute(`INSERT INTO cloud_rss_article_ids(item_id,article_id) SELECT item_id,? FROM sync_article_ids WHERE article_id=? AND item_id IS NOT NULL ON CONFLICT(item_id) DO UPDATE SET article_id=excluded.article_id`,[publicId,article.articleId]);const row=identities.find(r=>r.itemId===targetItemId);if(row){row.articleId=publicId;row.legacyMaterialized=false;}}
   if(remote==='cloud-rss-inventory'){const media=(incoming as ExportedArticle&{cloudMedia?:{audioUrl:string|null;videoUrl:string|null;publishedAt:string|null}}).cloudMedia;if(media)await this.db.execute('UPDATE articles SET audio_url=?,video_url=?,pub_date=? WHERE id=(SELECT item_id FROM sync_article_ids WHERE article_id=?)',[media.audioUrl,media.videoUrl,media.publishedAt,article.articleId]);}
   if(remote!=='cloud-rss-inventory'&&!article.deleted){const row=(await this.db.query('SELECT c.body_hash FROM article_sync_content c JOIN sync_article_ids m ON m.item_id=c.item_id WHERE m.article_id=?',[article.articleId]))[0];if(row){const realBody=!!(article.contentText.trim()||article.contentHtml?.trim()),ready=realBody||oldMeta?.content_hash===article.contentHash&&Number(oldMeta.body_ready)===1||String(row.body_hash)===article.contentHash;await this.db.execute(`INSERT INTO cloud_article_state(article_id,content_hash,body_hash,body_ready) VALUES(?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET content_hash=excluded.content_hash,body_hash=excluded.body_hash,body_ready=excluded.body_ready`,[article.articleId,article.contentHash,String(row.body_hash),ready?1:0]);}}
  }
  if(changed>0)this.snapshotCache=undefined;return changed;
 });}

 private async prepareCloudArticle(article:ExportedArticle,targetItemId?:number){
  const cached=(await this.db.query(`SELECT c.body_hash FROM article_sync_content c JOIN article_sync_encoding_cache e ON e.item_id=c.item_id AND e.body_hash=c.body_hash
   WHERE c.item_id=COALESCE(?,(SELECT item_id FROM sync_article_ids WHERE article_id=?),(SELECT item_id FROM article_register_state WHERE article_id=?))`,[targetItemId??null,article.articleId,article.articleId]))[0];
  return prepareArticle(article,this.ports.codec,true,cached?String(cached.body_hash):undefined);
 }

 resetPeerState(check?:SqlCancellationCheck){return this.run(()=>this.sequence.reset(cancellableSql(this.db,check)));}
 markSuccess(pending:PendingSyncSuccess,check?:SqlCancellationCheck){return this.run(()=>this.perf.time("markSuccess.total",()=>this.snapshot(async(_articles,sources,_device,manifests)=>{const peer=pending.remoteDeviceId,proof=await this.echo.stage(peer,manifests,sources,pending.receivedArticleManifest??[],pending.receivedSources??[]);await cancellableSql(this.db,check).transaction([this.sequence.successStatement(pending),...(pending.fullSnapshot&&pending.projectionGeneration?[{sql:"INSERT INTO sync_fast_library_baseline(peer,generation) SELECT ?,? WHERE EXISTS(SELECT 1 FROM sync_fast_definitions WHERE domain='library' AND generation=?) ON CONFLICT(peer) DO UPDATE SET generation=excluded.generation",params:[peer,pending.projectionGeneration,pending.projectionGeneration]}]:[]),{sql:'INSERT INTO sync_peer_features(peer_device_id,rss_canonical,book_sync) VALUES(?,?,?) ON CONFLICT(peer_device_id) DO UPDATE SET rss_canonical=excluded.rss_canonical,book_sync=excluded.book_sync',params:[peer,this.peerCanonical.get(peer)?1:0,this.peerBooks.get(peer)?1:0]},...proof]);},!!this.peerCanonical.get(pending.remoteDeviceId),!!this.peerBooks.get(pending.remoteDeviceId))).finally(()=>this.perf.flush("markSuccess.perf")));}
 /** Phone clearLibrary removes the RSS library and sync cursors while keeping
  * the watch identity, standalone notes, account and reader configuration.
  * privateData is reserved for the explicit local ownership-clear service. */
 clearLibrary(options:{privateData?:boolean;control?:LibraryClearControl;database?:SqlDatabase}={}){return this.run(async()=>{
  const control=options.control,db=options.database??this.db;control?.check();
  await this.cloudState(db);control?.check();
  const pending=(await db.query('SELECT private_data,content_json FROM library_clear_journal WHERE id=1'))[0];
  const privateData=!!options.privateData||!!Number(pending?.private_data);
  const retained=pending?JSON.parse(String(pending.content_json)) as RemovedLibraryContent&{bookPaths:{path:string}[]}:undefined;
  control?.progress('database');
  control?.check();
  const revision=await libraryRevision(db);
  const caches=(await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_projection_light','sync_projection_rows','sync_projection_header','sync_projection_legacy_coverage','sync_projection_events','sync_fast_encoded_cache','sync_fast_library_baseline','sync_fast_roots','sync_fast_receipts','sync_stable_article_ids')")).map(row=>String(row.name));
  const privateTables=privateData?(await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('douyin_local_state','external_saved_migrations','sync_snapshot_retained','note_merge_conflicts','note_merge_guard','note_cloud_receipts','note_asset_files','library_binary_snapshot_refs','library_binary_snapshot_files','library_binary_source_files','library_binary_request_quota','library_binary_cancellations','library_binary_assets','library_binary_guarded_jobs','library_binary_connections','library_binary_peaks','library_binary_jobs','library_binary_objects','library_binary_requests','library_binary_pages','library_binary_snapshots','library_binary_prepare_requests','library_binary_preparations','library_binary_peer_ack')")).map(row=>String(row.name)):[];
  const channels=[...(retained?.channels??[]),...(await querySyncPages(db,'SELECT id,url FROM channels ORDER BY id')).map(r=>({id:Number(r.id),url:String(r.url)}))];
  const itemIds=[...new Set([...(retained?.itemIds??[]),...(await querySyncPages(db,'SELECT id FROM articles ORDER BY id')).map(r=>Number(r.id))])];
  const bookPaths=[...(retained?.bookPaths??[]),...await querySyncPages(db,'SELECT package_path AS path FROM sync_books WHERE package_path IS NOT NULL UNION SELECT path FROM sync_book_parts')];
  control?.check();
  await db.transaction([revisionGuard(revision),{sql:'INSERT INTO library_clear_journal(id,private_data,content_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET private_data=excluded.private_data,content_json=excluded.content_json',params:[privateData?1:0,JSON.stringify({itemIds,channels,bookPaths})]},{sql:'UPDATE sync_book_context SET remote=1 WHERE id=1'},{sql:'DELETE FROM channels'},
   ...['sync_book_reading_peers','sync_book_reading_hashes','sync_book_reading_book_hashes','sync_book_reading_hash_dirty','sync_book_reading_dirty','sync_book_reading_versions','sync_book_reading_journal','sync_book_registration_cache','sync_book_display_dirty','sync_book_parts','sync_book_validation','sync_book_install','sync_book_stage','sync_book_aliases','sync_book_chapters','sync_book_reading','sync_book_events','sync_book_delete_members','sync_book_display','sync_books'].map(table=>({sql:`DELETE FROM ${table}`})),{sql:'UPDATE sync_book_context SET remote=0 WHERE id=1'},
   ...['sync_book_reading_history','sync_book_reading_versions','sync_book_reading_hash_dirty','sync_book_reading_book_hashes','sync_book_reading_hashes'].map(table=>({sql:`DELETE FROM ${table}`})),{sql:'UPDATE sync_book_reading_meta SET epoch=lower(hex(randomblob(16))),root=NULL,count=0 WHERE id=1'},
   ...['article_register_conflicts','article_register_state','cloud_rss_article_ids','cloud_article_state','cloud_source_state','sync_saved_states','sync_article_deletions','sync_article_keeps','sync_article_ids','sync_article_aliases','local_article_deletions',
    'sync_source_states','sync_change_log','sync_peer_state','sync_snapshot_fingerprints','offline_media_jobs','sync_article_keep_aliases','article_deletion_cleanup',...caches].map(table=>({sql:`DELETE FROM ${table}`})),
   ...(privateData?['memo_notes','memo_folders','llm_token_usage',...privateTables].map(table=>({sql:`DELETE FROM ${table}`})):[]),
   {sql:'UPDATE sync_library_revision SET revision=revision+1 WHERE id=1'}]);
  this.snapshotCache=undefined;
  control?.progress('files');
  await this.resumeClear(control,db);
 });}
 /** Authorized intent survives SQL commit, cancellation and process death. No account required. */
 resumeLibraryClear(control?:LibraryClearControl,database:SqlDatabase=this.db){return this.run(()=>this.resumeClear(control,database));}
 private async resumeClear(control?:LibraryClearControl,db:SqlDatabase=this.db){
  control?.check();
  const journal=(await db.query('SELECT private_data,content_json FROM library_clear_journal WHERE id=1'))[0];if(!journal)return;
  control?.progress('files');
  const content=JSON.parse(String(journal.content_json)) as RemovedLibraryContent&{bookPaths:{path:string}[]};
  if(this.ports.clearContentFiles)await this.ports.clearContentFiles(!!Number(journal.private_data),control);
  else{control?.check();await this.ports.cleanupRemovedContent({itemIds:content.itemIds,channels:content.channels});for(const r of content.bookPaths){control?.check();await this.ports.bookFiles?.remove(String(r.path));}}
  control?.check();await this.ports.finishLibraryClear?.(!!Number(journal.private_data),()=>control?.check());
  control?.progress('verification');
  for(const table of ['channels','articles','sync_books','sync_book_reading','article_reading_state']){control?.check();if(Number((await db.query(`SELECT count(*) n FROM ${table}`))[0]?.n))throw new LibraryClearError('clear_library_changed');}
  control?.check();await db.execute('DELETE FROM library_clear_journal WHERE id=1');
 }
 finalizeSnapshot(articleIds:readonly string[],sourceUrls:readonly string[],peer?:string,check?:SqlCancellationCheck){return this.run(async()=>{
  const commit=cancellableSql(this.db,check);
  await this.migrate();const revision=await libraryRevision(this.db),ids=new Set(articleIds),urls=new Set(sourceUrls.map(normalizeSourceUrl));if(peer&&this.peerBooks.get(peer)&&this.books){for(const m of await this.books.mappings())ids.add(m.articleId);for(const url of await this.books.sourceUrls(true))urls.add(normalizeSourceUrl(url));}
  if(peer&&this.peerCanonical.get(peer)){const matches=(await this.local.cloudRssIdentities()).filter(r=>ids.has(r.articleId)),keep=new Set(matches.map(r=>r.itemId));for(const r of matches)ids.add(r.localArticleId);for(const row of await querySyncPages(this.db,'SELECT id,dedup_key FROM articles ORDER BY id'))if(keep.has(Number(row.id)))ids.add(String(row.dedup_key));}
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
    ...['sync_saved_states','sync_article_deletions','sync_article_keeps','sync_article_ids'].map(table=>({sql:`DELETE FROM ${table} WHERE article_id NOT IN (${keepArticle})`,params:[scope]})),
    {sql:`DELETE FROM sync_source_states WHERE url NOT IN (${keepSource})`,params:[scope]},
    ...['sync_change_log','sync_peer_state','sync_snapshot_fingerprints'].map(table=>({sql:`DELETE FROM ${table}`})),
    {sql:'UPDATE sync_library_revision SET revision=revision+1 WHERE id=1'}];
   await commit.transaction(statements);await this.ports.cleanupRemovedContent({itemIds,channels});
  }finally{await this.db.execute('DELETE FROM sync_snapshot_retained WHERE scope=?',[scope]);}
 });}
}

/** The foreground session also serves the v1 book wire protocol. Headless
 * cloud workers use the same book store without linking its wire handlers. */
export class SqlLibrarySessionRepository extends SqlLibraryCloudRepository {
 private readonly bookActions?:BookSyncActions;
 constructor(db:SqlDatabase,ports:SqlLibraryRepositoryPorts){
  super(db,ports);
  if(this.books)this.bookActions=new BookSyncActions(this.db,this.books);
 }
 syncBooks(request:import('./protocol').JsonObject,session?:object,afterAck?:AfterReadingAck,check?:import('../sync-v2/local-transfer-intake').LocalTransferWrite,cancel?:SqlCancellationCheck,readingFence?:string){return this.run(async()=>{if(!this.bookActions)throw Error('book_sync_unavailable');await this.migrate();return this.bookActions.apply(request,session,afterAck?commit=>afterAck(()=>this.run(commit)):undefined,check,cancel,readingFence);});}
}
