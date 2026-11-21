import {compareLifecycleTokens} from '@podjs/framework/lifecycle-token';
import type {FileCheckpoint} from '@podjs/framework/work-window';
import type {PublicationDeadline} from '../cloud/publication-deadline';
import {utf8Encode} from '../cloud/types';
import type {LibraryClearControl} from '../core/library-clear';
import type {SqlDatabase,SqlParams} from '../core/types';
import {idleHit} from '../diagnostics/idle-counters';
import type {BookFiles} from '../books/files';
import type {BookState} from '../books/protocol';
import {SqlBookStore} from '../books/store';
import {noteAssetKeys} from '../notes/cloud-assets';
import {MemoRepository} from '../notes/repository';
import type {MemoNote} from '../notes/types';
import type {SyncBodyCodec} from './article-body';
import type {ArticleReceiveFiles} from './article-receiver';
import {migrateLocalDeletionJournal} from './deletion-journal';
import {FullSyncPerf} from './full-sync-perf';
import {LocalArticleManifestStore,stableArticleId,type ReencodedBody,type SyncTextPort} from './local-manifest';
import {repositoryWork,type RepositoryDiagnostic} from './repository-work';
import type {SourceUriPort} from './source-store';

export interface RemovedLibraryContent {itemIds:readonly number[];channels:readonly {id:number;url:string}[]}
export interface SqlLibraryRepositoryPorts {
 noteAssetReader?:(key:string,check?:()=>void)=>Promise<Uint8Array>;
 noteAssetWriter?:(key:string,bytes:Uint8Array,expectedTargetSha256?:string|null,deadline?:PublicationDeadline)=>Promise<number>;
 noteAssetCollector?:(references:()=>Promise<ReadonlySet<string>>,check:()=>void)=>Promise<number>;
 reencodeStoredBodies?:(ids:readonly number[])=>Promise<readonly ReencodedBody[]>;
 clearContentFiles?:(privateData:boolean,control?:LibraryClearControl)=>Promise<void>;
 finishLibraryClear?:(privateData:boolean,check:()=>void)=>Promise<void>;
 bookFiles?:BookFiles;codec:SyncBodyCodec;text:SyncTextPort;uri:SourceUriPort;files:ArticleReceiveFiles;
 migrateReading(id:number):Promise<void>;
 prepareReadingMigration?:(ids:readonly number[])=>Promise<{sql:string;params:SqlParams}[]>;
 migrateReadingMany?:(ids:readonly number[])=>Promise<void>;
 /** Release offline media and channel-specific preview caches for removed rows. */
 cleanupRemovedContent(content:RemovedLibraryContent):Promise<void>;
 diagnostic?:(fields:Record<string,string|number>)=>void;
 now?:()=>number;
}
/** The local metadata and installed-body repository used by Sync v2.
 * The full repository adds the legacy snapshot and local transfer protocols. */
export class SqlLibraryBodyRepository {
 protected readonly db:SqlDatabase;
 protected readonly ports:SqlLibraryRepositoryPorts;
 protected readonly perf:FullSyncPerf;
 protected readonly local:LocalArticleManifestStore;
 protected readonly now:()=>number;
 protected cloudDiagnostic?:RepositoryDiagnostic;
 readonly books:SqlBookStore|undefined;
 private tail:Promise<unknown>=Promise.resolve();
 private cloudMemo?:Promise<MemoRepository>;

 constructor(db:SqlDatabase,ports:SqlLibraryRepositoryPorts){
  this.perf=new FullSyncPerf(ports.diagnostic);
  this.db=db=this.perf.database(db);
  this.ports=ports={...ports,codec:this.perf.codec(ports.codec)};
  this.now=ports.now??Date.now;
  this.local=new LocalArticleManifestStore(db,ports.codec,ports.text,ports.files,ports.migrateReading,ports.migrateReadingMany,f=>this.report(f),ports.reencodeStoredBodies);
  if(ports.bookFiles)this.books=new SqlBookStore(db,{sha256:ports.codec.sha256,files:ports.bookFiles,text:ports.files,stableId:url=>stableArticleId(url,ports.text.parseUri,ports.codec),deviceId:()=>this.identity(),warn:code=>this.report({stage:code}),diagnostic:fields=>this.report(fields),profile:(stage,ms)=>this.perf.add(stage,ms)});
 }
 protected work<T>(stage:string,run:()=>Promise<T>){return repositoryWork(f=>this.report(f),stage,run,this.ports.now);}
 protected report(fields:Record<string,string|number>){try{this.ports.diagnostic?.(fields);if(fields.event==='library-work')this.cloudDiagnostic?.(fields);}catch{/* Diagnostics never change the exchange. */}}
 protected run<T>(action:()=>Promise<T>):Promise<T>{const result=this.tail.then(action);this.tail=result.catch(()=>{});return result;}
 protected async identity():Promise<string>{const row=(await this.db.query('SELECT device_id FROM sync_local_identity WHERE id=1'))[0];if(!row||!String(row.device_id).trim())throw new Error('Initialize sync identity first');return String(row.device_id);}
 protected async migrate(){idleHit(30);const id=await this.identity();await migrateLocalDeletionJournal(this.db,id,this.ports.text,this.ports.codec);return id;}
 deviceId(){return this.identity();}
 /** Cloud uses the same serialization lane and transactional entity merge as phone sync. */
 private cloudReady?:Promise<void>;
 protected cloudState(db:SqlDatabase=this.db):Promise<void>{const run=async()=>{await db.execute(`CREATE TABLE IF NOT EXISTS cloud_reading_commit(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL)`);await db.execute(`CREATE TABLE IF NOT EXISTS cloud_rss_article_ids(item_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,article_id TEXT NOT NULL)`);await db.execute(`CREATE TABLE IF NOT EXISTS cloud_article_state(article_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,body_hash TEXT NOT NULL,body_ready INTEGER NOT NULL DEFAULT 0,reading_clock INTEGER NOT NULL DEFAULT 0,reading_source TEXT NOT NULL DEFAULT '')`);await db.execute(`CREATE TABLE IF NOT EXISTS cloud_source_state(url TEXT PRIMARY KEY,projection TEXT NOT NULL,changed_at INTEGER NOT NULL,device TEXT NOT NULL)`);};if(db!==this.db)return run();return this.cloudReady??=run().catch(error=>{this.cloudReady=undefined;throw error;});}

 async mergeCloudNotes(notes:readonly MemoNote[],check:()=>void=()=>{}){
  const repository=await (this.cloudMemo??=(async()=>{const value=new MemoRepository(this.db,await this.deviceId(),undefined,this.now);await value.initialize();return value;})().catch(error=>{this.cloudMemo=undefined;throw error;}));let changed=0;
  for(const note of notes){check();changed+=await repository.applyRemote(note);check();}return changed;
 }
 async cloudNotes(check:()=>void=()=>{}){
  await this.mergeCloudNotes([],check);check();
  const notes=await new MemoRepository(this.db,await this.deviceId()).allIncludingDeleted();
  const texts=notes.filter(n=>!n.deleted).flatMap(n=>[n.markdown,n.baseMarkdown]);
  if((await this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='note_merge_conflicts'")).length)for(const row of await this.db.query('SELECT base_markdown,local_markdown,remote_markdown FROM note_merge_conflicts'))texts.push(String(row.base_markdown),String(row.local_markdown),String(row.remote_markdown));
  check();return {notes,assetKeys:[...new Set(texts.flatMap(t=>[...noteAssetKeys(t)]))].sort()};
 }
 async cloudNoteAsset(key:string,check?:()=>void){if(!this.ports.noteAssetReader)throw Error('cloud_note_assets_unavailable');return this.ports.noteAssetReader(key,check);}
 async mergeCloudNoteAsset(key:string,bytes:Uint8Array,expectedTargetSha256?:string|null,deadline?:PublicationDeadline){if(!this.ports.noteAssetWriter)throw Error('cloud_note_assets_unavailable');return this.ports.noteAssetWriter(key,bytes,expectedTargetSha256,deadline);}
 /** Conservative empty adoption: logical saved/deleted/pending state also
  * belongs to its old owner, even if no visible article remains. */
 hasLocalPrivateContent(){return this.run(async()=>{
  const optional=['memo_notes','memo_folders','sync_books','sync_book_reading','sync_book_stage','sync_book_parts','article_register_state','article_register_conflicts','sync_saved_states','sync_article_deletions','sync_article_keeps','local_article_deletions','sync_source_states','cloud_source_state','cloud_article_state'];
  const tables=(await this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+optional.map(()=>'?').join(',')+")",optional)).map(r=>String(r.name));
  return !!(await this.db.query("SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM articles) OR EXISTS(SELECT 1 FROM channels WHERE url NOT IN ('builtin:bili','builtin:douyin')) OR EXISTS(SELECT 1 FROM notes)"+tables.map(t=>' OR EXISTS(SELECT 1 FROM '+t+')').join(''))).length;
 });}
 cloudRestoreMetadata(request:{ids?:readonly string[];urls?:readonly string[];itemIds?:readonly number[];after?:number;limit?:number}={},check?:()=>void){return this.run(()=>this.work('cloudMetadata',async()=>{await this.cloudState();return this.local.cloudRestoreMetadata(request,check);}));}
 /** P6 article bytes use the existing verified v1 cache and its native aliases. */
 cloudArticleBody(id:string){return this.run(async()=>{
  const article=await this.cloudArticleSource(id);
  return article?this.local.cloudArticleBody(article):undefined;
 });}
 cloudArticlePlain(id:string){return this.run(async()=>{
  const article=await this.cloudArticleSource(id),item=article?.cloudReadingItemId;
  return item===undefined?undefined:this.local.cloudArticlePlain(item);
 });}
 private async cloudArticleSource(id:string){
  await this.cloudState();const itemIds=await this.local.cloudReadingItemIds([await this.ports.codec.sha256(utf8Encode(id))]);if(itemIds.length>100)throw Error('source_identity_missing');
  const page=await this.local.cloudRestoreMetadata({ids:[id],itemIds,limit:100}),exact=page.articles.filter(a=>a.articleId===id||a.cloudLegacyArticleIds?.includes(id));
  const matches=exact.length?exact:page.articles.filter(a=>a.cloudReadingItemId!==undefined&&itemIds.includes(a.cloudReadingItemId));if(matches.length>1)throw Error('source_identity_missing');
  return matches[0];
 }

 private readonly cloudBookProofs=new Map<string,{token:string;sha256:string;size:number}>();
 async cloudBookWitness(id:string,expected:Pick<BookState,'bookId'|'fingerprint'|'chapterCount'|'instanceId'|'lifecycle'>){
  const binding=()=>this.run(async()=>{
   await this.migrate();
   const file=await this.books?.package(id);if(!file)return;
   const state=await this.books!.transferState(id);
   if(!state||state.deleted||state.bookId!==expected.bookId||state.fingerprint!==expected.fingerprint||state.chapterCount!==expected.chapterCount||state.instanceId!==expected.instanceId||compareLifecycleTokens(state.lifecycle,expected.lifecycle)!==0)throw Error('body_revision_changed');
   return file;
  });
  const file=await binding();if(!file)return;
  const files=this.ports.bookFiles!,before=await files.stat(file.path);
  if(!before.exists||before.size!==file.size)throw Error('cloud_book_package_changed');
  const cached=this.cloudBookProofs.get(file.path),token=before.changeToken;
  const actual=token&&cached?.token===token&&cached.sha256===file.sha256&&cached.size===file.size?cached:await files.hash(file.path);
  const current=await binding(),after=await files.stat(file.path);
  if(actual.sha256!==file.sha256||actual.size!==file.size||current?.path!==file.path||current.sha256!==file.sha256||current.size!==file.size||!after.exists||after.size!==file.size||after.changeToken!==token)throw Error('cloud_book_package_changed');
  if(token){
   this.cloudBookProofs.delete(file.path);
   if(this.cloudBookProofs.size>=32)this.cloudBookProofs.delete(this.cloudBookProofs.keys().next().value!);
   this.cloudBookProofs.set(file.path,{token,sha256:actual.sha256,size:actual.size});
  }
  return {sha256:actual.sha256,size:actual.size};
 }
 cloudBookPreview(id:string){return this.run(async()=>{
  await this.migrate();const file=await this.books?.package(id);if(!file)return;
  if(file.size>256*1024*1024)throw Error('cloud_book_capacity_pending');
  const files=this.ports.bookFiles!,actual=await files.hash(file.path);
  if(actual.sha256!==file.sha256||actual.size!==file.size)throw Error('cloud_book_package_changed');
  const part=await files.read(file.path,0,65536);
  if(part.size!==file.size||!part.bytes.length)throw Error('cloud_book_package_changed');
  const end=part.bytes.indexOf(10);if(end<0)return; // Oversized header keeps the existing full reader.
  return {prefix:part.bytes.subarray(0,end+1),size:file.size,sha256:file.sha256};
 });}
 cloudBookBody(id:string){return this.run(async()=>{await this.migrate();const file=await this.books?.package(id);if(!file)return;const files=this.ports.bookFiles!;if(file.size>256*1024*1024)throw Error('cloud_book_capacity_pending');const actual=await files.hash(file.path);if(actual.sha256!==file.sha256||actual.size!==file.size)throw Error('cloud_book_package_changed');const bytes=new Uint8Array(file.size);for(let at=0;at<file.size;){const part=await files.read(file.path,at,65536);if(part.size!==file.size||!part.bytes.length||at+part.bytes.length>file.size)throw Error('cloud_book_package_changed');bytes.set(part.bytes,at);at+=part.bytes.length;}return bytes;});}
 receiveCloudBook(id:string,bytes:Uint8Array,checkpoint?:FileCheckpoint,deadline?:PublicationDeadline){return this.run(async()=>{await this.migrate();if(!this.books||!this.ports.bookFiles)throw Error('book_storage_unavailable');deadline?.check();const stage=deadline?undefined:checkpoint,file=await this.ports.bookFiles.writeBytes(bytes,stage,id);try{return await this.books.installPackage(file,id,stage,true,deadline?.check,deadline);}finally{if(!stage?.scope)await this.ports.bookFiles.remove(file.path);}});}
}
