import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {initializeSchema} from '../../src/core/schema.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
import {SyncSavedStateStore} from '../../src/sync/saved-state.ts';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository.ts';
import {LocalArticleManifestStore,stableArticleId,type SyncTextPort} from '../../src/sync/local-manifest.ts';
import {encodeBodyJson,type SyncBodyCodec} from '../../src/sync/article-body.ts';
import {prepareArticle,type ExportedArticle} from '../../src/sync/article-export.ts';
import {buildChunkedResponseFrames,buildManifestResponse} from '../../src/sync/library-wire.ts';
import {parseChunkedArticleFrames} from '../../src/sync/article-batches.ts';
import {parseArticleManifest,selectArticleBodyRequests} from '../../src/sync/manifest.ts';
import {WatchRssRepository} from '../../src/core/repository.ts';
import {MemoRepository} from '../../src/notes/repository.ts';
import type {MemoNote} from '../../src/notes/types.ts';
import {syncNotes} from '../../src/sync/note-actions.ts';

const codec:SyncBodyCodec={sha256:async b=>new Bun.CryptoHasher('sha256').update(b).digest('hex'),encode:async b=>gzipSync(encodeBodyJson(b)),decode:async b=>gunzipSync(b).toString('utf8')};
const text:SyncTextPort={parseUri:async value=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};},htmlText:async s=>s};
const files={storeText:async(_k:string,v:string)=>v,hydrate:async(v:string)=>v};
async function peer(path:string,id:string){
 const sql=new Database(path);sql.exec('PRAGMA foreign_keys=ON');
 const run=(q:string,p:readonly unknown[]=[])=>sql.query(q).run(...p as any[]);
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{run(q,p);},transaction:async ss=>{sql.transaction(()=>{for(const s of ss)run(s.sql,s.params);})();},transactionChanges:async ss=>sql.transaction(()=>ss.map(s=>{run(s.sql,s.params);return (sql.query('SELECT changes() AS n').get() as {n:number}).n;}))()};
 await initializeSchema(db);await new SyncSavedStateStore(db).initializeDevice(id);
 // Production constructor path: omit optional now, transport is local wire only.
 const repository=new SqlLibrarySessionRepository(db,{codec,text,uri:{parseUri:text.parseUri,parseAndroid:text.parseUri},files,migrateReading:async()=>{},cleanupRemovedContent:async()=>{}});
 const local=new LocalArticleManifestStore(db,codec,text,files,async()=>{});
 return {id,sql,db,repository,local};
}
type Peer=Awaited<ReturnType<typeof peer>>;
async function trio(action:(peers:Peer[],dir:string)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'wrss-clock-'));const peers:Peer[]=[];
 try{for(const id of ['peer-a','peer-b','peer-c'])peers.push(await peer(join(dir,id+'.sqlite'),id));await action(peers,dir);}
 finally{for(const p of peers)p.sql.close();rmSync(dir,{recursive:true,force:true});}
}
async function article(source:string|null=null):Promise<ExportedArticle>{
 const url='https://example.test/clock-article';
 return {articleId:await stableArticleId(url,text.parseUri,codec),sourceDeviceId:'origin',url,title:'Clock',siteName:'Fixture',excerpt:'',imageUrl:null,contentHash:'',contentHtml:null,contentText:'unchanged relay body',importedAt:100,updatedAt:100,rssSourceUrl:source,rssSourceTitle:source?'Fixture':null,independentSaved:source===null,independentChangedAt:source===null?100:0,independentSortOrder:source===null?100:0,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,deleted:false,deletedAt:0,readingProgress:.25,readingPositionBytes:4,readingPositionContentHash:'position',readingPositionChangedAt:900,isRead:true};
}
async function receive(target:Peer,a:ExportedArticle,sender='origin'){
 const p=await prepareArticle(a,codec),frames=buildChunkedResponseFrames(sender,[p],[],0,0,true);
 for(const entry of parseChunkedArticleFrames(frames))await target.repository.receiveArticle(entry,sender,false);
}
async function manifest(p:Peer){
 const w=await p.repository.prepareWindow('test-peer',0);
 return parseArticleManifest(buildManifestResponse(p.id,w.fullArticleManifest,[],w.rssSources,0,{fromSeqExclusive:0,toSeqInclusive:w.toSeqInclusive,fullSnapshot:true,fallbackReason:''}));
}
async function exported(p:Peer,id:string){
 const request={articleId:id,bodyHash:'',chunkIndexes:[],metadataOnly:false};
 const out=await p.repository.exportRequested([request]);expect(out).toHaveLength(1);
 const entries=parseChunkedArticleFrames(buildChunkedResponseFrames(p.id,out,[request],0,0,true));expect(entries).toHaveLength(1);return entries[0]!;
}
async function relay(from:Peer,to:Peer,id:string,selected=true){
 const remote=await manifest(from),local=await manifest(to);
 if(selected)expect(selectArticleBodyRequests(local,remote,{supportsMetadataOnly:true}).some(r=>r.articleId===id)).toBe(true);
 const entry=await exported(from,id);await to.repository.receiveArticle(entry,from.id,false);return entry;
}
async function assertClock(p:Peer,id:string,type:'favorite'|'watchLater',saved:boolean,at:number){
 const m=(await manifest(p)).find(a=>a.articleId===id)!;expect(m[`${type}ChangedAt`]).toBe(at);
 const entry=await exported(p,id);expect(entry.article[`${type}ChangedAt`]).toBe(at);expect(entry.article[`${type}Saved`]).toBe(saved);
 const row=(await p.db.query('SELECT saved,changed_at FROM sync_saved_states WHERE article_id=? AND save_type=?',[id,type]))[0];expect(row).toEqual({saved:saved?1:0,changed_at:at});
 const cloud=await p.repository.cloudSnapshot(true),projected=cloud.articles.find(a=>a.articleId===id||a.cloudLegacyArticleIds?.includes(id));expect(projected?.[`${type}ChangedAt`]).toBe(at);if(projected?.cloudRssArticleId)expect(projected.articleId).toBe(projected.cloudRssArticleId);
}
for(const source of [null,'https://watchrss.local/import-txt-novel/book','https://feed.test/rss'])for(const type of ['favorite','watchLater'] as const){
 test(`file SQLite A→B→C / A→B→A preserves ${type} cancellation and re-save (${source??'independent'})`,async()=>trio(async([a,b,c])=>{
  const base=await article(source),id=base.articleId;
  const change=(saved:boolean,at:number):ExportedArticle=>({...base,[`${type}Saved`]:saved,[`${type}ChangedAt`]:at,[`${type}SortOrder`]:at});
  await receive(a!,change(true,3000));await relay(a!,b!,id);await relay(b!,c!,id);
  // Cache a prior manifest, then receive cancellation into the same instance.
  await receive(a!,change(false,4000));await assertClock(a!,id,type,false,4000);
  await relay(a!,b!,id);await assertClock(b!,id,type,false,4000);
  await relay(b!,c!,id);await assertClock(c!,id,type,false,4000);
  await relay(b!,a!,id,false);await assertClock(a!,id,type,false,4000);
  // Older save after cancellation must never revive the list.
  for(const p of [a!,b!,c!]){await receive(p,change(true,3500),'z-old');await assertClock(p,id,type,false,4000);}
  await receive(a!,change(true,5000));await relay(a!,b!,id);await relay(b!,c!,id);await relay(b!,a!,id,false);
  for(const p of [a!,b!,c!]){await receive(p,change(false,4500),'z-old');await assertClock(p,id,type,true,5000);}
 }));
}
for(const reverse of [false,true])test(`equal clocks retain native sender tie-break across relay (reverse=${reverse})`,async()=>trio(async([a,b,c])=>{
 const base=await article(),id=base.articleId,save={...base,favoriteSaved:true,favoriteChangedAt:4000,favoriteSortOrder:4000},cancel={...save,favoriteSaved:false};
 for(const p of [a!,b!])for(const [value,sender] of reverse?[[cancel,'z-winner'],[save,'a-loser']] as const:[[save,'a-loser'],[cancel,'z-winner']] as const)await receive(p,value,sender);
 await relay(a!,c!,id);await relay(c!,b!,id,false);
 for(const p of [a!,b!,c!])await assertClock(p,id,'favorite',false,4000);
}));
test('local cancel/re-save and file reopen export journal clocks without receiver now injection',async()=>trio(async([a,b],dir)=>{
 const base=await article(),id=base.articleId;await receive(a!,{...base,favoriteSaved:true,favoriteChangedAt:3000,favoriteSortOrder:3000});
 const item=Number((await a!.db.query('SELECT item_id FROM sync_article_ids WHERE article_id=?',[id]))[0]!.item_id);
 const repo=new WatchRssRepository(a!.db,async()=>'',files.hydrate);
 for(const saved of [false,true,false]){
  await repo.setSaved(item,saved);const at=Number((await a!.db.query("SELECT changed_at FROM sync_saved_states WHERE article_id=? AND save_type='favorite'",[id]))[0]!.changed_at);
  expect(at).toBeGreaterThan(3000);await assertClock(a!,id,'favorite',saved,at);await relay(a!,b!,id);await assertClock(b!,id,'favorite',saved,at);
 }
 const at=Number((await b!.db.query("SELECT changed_at FROM sync_saved_states WHERE article_id=? AND save_type='favorite'",[id]))[0]!.changed_at);
 const reopened=await peer(join(dir,b!.id+'.sqlite'),b!.id);try{await assertClock(reopened,id,'favorite',false,at);}finally{reopened.sql.close();}
}));
test('clearing one list retains both independent saved clocks while the other list stays active',async()=>trio(async([a,b,c])=>{
 const base=await article(),id=base.articleId;
 await receive(a!,{...base,favoriteSaved:false,favoriteChangedAt:4000,favoriteSortOrder:4000,watchLaterSaved:true,watchLaterChangedAt:3500,watchLaterSortOrder:3500});
 await relay(a!,b!,id);await relay(b!,c!,id);
 for(const p of [a!,b!,c!]){await assertClock(p,id,'favorite',false,4000);await assertClock(p,id,'watchLater',true,3500);}
}));
test('note tombstones preserve updatedAt/deletedAt/modifiedBy through two default-clock repositories',async()=>trio(async([a,b,c])=>{
 const initial={noteId:'relay-note',folderId:null,title:'Deleted',markdown:'body',plainText:'body',contentHash:'body-hash',baseContentHash:'body-hash',baseMarkdown:'body',pinned:false,createdAt:100,updatedAt:4000,modifiedBy:'origin',deleted:true,deletedAt:4000};
 let notes:MemoNote[]=[initial];for(const p of [a!,b!,c!]){
  const repository=new MemoRepository(p.db,p.id);const response=await syncNotes({notes},repository,async()=>p.id);
  notes=(await repository.allIncludingDeleted());expect(notes).toEqual([initial]);expect(response.notes).toEqual([Object.fromEntries(Object.entries(initial).filter(([key])=>key!=='plainText'))]);
 }
}));

test('active article progress/read clocks survive relay and stale metadata receipt',async()=>trio(async([a,b,c])=>{
 const base=await article(),id=base.articleId;
 await receive(a!,{...base,favoriteChangedAt:4000});await relay(a!,b!,id);await relay(b!,c!,id);
 await receive(c!,{...base,readingPositionChangedAt:100,readingPositionBytes:1,readingProgress:.1,isRead:false});
 for(const p of [a!,b!,c!])expect((await exported(p,id)).article).toMatchObject({readingPositionChangedAt:900,readingPositionBytes:4,readingProgress:.25,isRead:true});
}));
