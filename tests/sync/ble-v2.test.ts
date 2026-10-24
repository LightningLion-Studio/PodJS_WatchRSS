import {test,expect} from 'bun:test';
import {MemoRepository} from '../../src/notes/repository';
import {noteManifest} from '../../src/sync/note-manifest';
import {NoteAssetReceiver} from '../../src/sync/note-assets';
import {createApplicationActionHandler} from '../../src/sync/application-actions';
import {encodeFrame} from '../../src/sync/protocol';
import {readTokenUsagePage} from '../../src/sync/token-usage';
import {parseAccountSyncRequest,syncAccount} from '../../src/sync/account-actions';
import {selectArticleBodyRequests} from '../../src/sync/manifest';
import {bodyForRequest,prepareArticle} from '../../src/sync/article-export';
import {notifyLibrarySqlCommit,subscribeLibraryMutations} from '../../src/core/library-mutations';
import {initializeSchema} from '../../src/core/schema';
import {rssArticleId} from '../../src/cloud/rss-identity';
import {fixture,article,sha,parseUri} from './ble-v2-fixture';
import type {MemoNote} from '../../src/notes/types';
const note=(i=0):MemoNote=>({noteId:'note-'+i,folderId:null,title:'title',markdown:'note body 中文🙂'.repeat(400),plainText:'note body 中文🙂'.repeat(400),contentHash:sha('body'+i),baseContentHash:sha('body'+i),baseMarkdown:'',pinned:false,createdAt:100,updatedAt:100,modifiedBy:'phone',deleted:false,deletedAt:0});
const wire=(n:MemoNote)=>{const {plainText,...row}=n;return row;};
test('BLE v2 identical notes/assets sends zero full notes/chunks; legacy fallback and byte counts',async()=>{
 const f=await fixture();try{
  const notes=new MemoRepository(f.db,'watch');await notes.initialize();const rows=Array.from({length:100},(_,i)=>note(i));await notes.merge(rows);
  const data=Buffer.alloc(16384,17),digest=sha(data),assets=Array.from({length:24},(_,i)=>({storageKey:'img-'+i+'.png',sha256:digest,size:data.length}));
  const receiver=new NoteAssetReceiver({stat:async()=>({file:true,size:data.length}),hash:async()=>({sha256:digest,size:data.length}),remove:async()=>{},write:async()=>{throw Error('Unexpected write');},append:async()=>{throw Error('Unexpected write');},commit:async()=>{throw Error('Unexpected write');}});
  let changed=0;const handle=createApplicationActionHandler({notes,deviceId:async()=>'watch',notesChanged:()=>changed++,noteAssets:receiver});
  const all=(await notes.allIncludingDeleted()).map(wire),manifest=(await notes.allIncludingDeleted()).map(noteManifest);
  const legacy={action:'syncNotes',version:1,notes:all},legacyReply=await handle(legacy);
  const inventory={action:'syncNotes',version:1,phase:'manifest',noteManifest:manifest,assetManifest:assets},inventoryReply=await handle(inventory);
  const delta={action:'syncNotes',version:1,phase:'delta',noteManifest:manifest,notes:[]},deltaReply=await handle(delta);
  expect(inventoryReply.assetManifest).toEqual(assets);expect(deltaReply).toMatchObject({applied:0,notes:[]});expect(changed).toBe(0);
  const oldChunks=assets.map(a=>({action:'syncNoteAsset',version:1,...a,chunkIndex:0,chunkCount:1,data:data.toString('base64')}));
  const before=encodeFrame(legacy).length+encodeFrame(legacyReply).length+oldChunks.reduce((n,c)=>n+encodeFrame(c).length,0);
  const after=[inventory,inventoryReply,delta,deltaReply].reduce((n,c)=>n+encodeFrame(c).length,0);
  expect(after).toBeLessThan(before*.25);console.log('BLE_V2_TRAFFIC',JSON.stringify({beforeBytes:before,afterBytes:after,beforeNotes:all.length*2,afterNotes:0,beforeAssetChunks:oldChunks.length,afterAssetChunks:0}));
 }finally{f.sql.close();}
});
test('note state hash independently matches SHA256 of LP including title/folder and tombstone clocks',()=>{
 const n=note(),fields=['watchrss/note-state/v2',n.noteId,'0','',n.title,n.contentHash,n.baseContentHash,'0','100','100','phone','0','0'];const parts=fields.map(s=>{const b=Buffer.from(s);const h=Buffer.alloc(4);h.writeUInt32BE(b.length);return Buffer.concat([h,b]);});expect(noteManifest(n).stateHash).toBe(sha(Buffer.concat(parts)));expect(noteManifest({...n,title:'renamed'}).stateHash).not.toBe(noteManifest(n).stateHash);
});
test('note delta rejects a malformed manifest before mutations, sends dirty conflict and notifies once for real apply',async()=>{
 const f=await fixture();try{const repo=new MemoRepository(f.db,'watch');await repo.initialize();const current=note();await repo.merge([current]);let changed=0;const handle=createApplicationActionHandler({notes:repo,deviceId:async()=>'watch',notesChanged:()=>changed++});
  const bad=await handle({action:'syncNotes',phase:'delta',noteManifest:null,notes:[wire({...current,title:'bad'})]});expect(bad.success).toBe(false);expect((await repo.get(current.noteId))?.title).toBe(current.title);
  const newer={...current,title:'new',updatedAt:101};const applied=await handle({action:'syncNotes',phase:'delta',noteManifest:[noteManifest(newer)],notes:[wire(newer)]});expect(applied).toMatchObject({applied:1,notes:[]});expect(changed).toBe(1);
  await handle({action:'syncNotes',phase:'delta',noteManifest:[noteManifest(newer)],notes:[wire(newer)]});expect(changed).toBe(1);
  const missingHash={...noteManifest(newer)};delete missingHash.stateHash;expect((await handle({action:'syncNotes',phase:'delta',noteManifest:[missingHash],notes:[]})).notes).toHaveLength(1);
 }finally{f.sql.close();}
});
test('asset inventory verifies final disk bytes and ignores partial/missing/mismatched resources',async()=>{
 const digest=sha('x');const files={stat:async(p:string)=>({file:!p.includes('missing'),size:1}),hash:async(p:string)=>({sha256:p.includes('wrong')?sha('y'):digest,size:1}),remove:async()=>{},write:async()=>({size:0}),append:async()=>({size:0}),commit:async()=>{}};
 const r=new NoteAssetReceiver(files);expect(await r.inventory([{storageKey:'good',sha256:digest,size:1},{storageKey:'missing',sha256:digest,size:1},{storageKey:'wrong',sha256:digest,size:1}])).toEqual([{storageKey:'good',sha256:digest,size:1}]);await expect(r.inventory([{storageKey:'../x',sha256:digest,size:1}])).rejects.toThrow();
});
test('full metadata-only requires explicit v2 capability, exact complete body descriptors and emits zero chunks',async()=>{
 const f=await fixture();try{const p=await prepareArticle(article(),f.codec),remote={...p.manifest,updatedAt:101,metadataHash:'changed'};
  const old=selectArticleBodyRequests([p.manifest],[remote],{supportsMetadataOnly:true})[0]!;expect(old.metadataOnly).toBe(false);expect(bodyForRequest(p,old).chunks.length).toBeGreaterThan(0);
  const next=selectArticleBodyRequests([p.manifest],[remote],{supportsMetadataOnly:true,supportsFullMetadataOnly:true})[0]!;expect(next.metadataOnly).toBe(true);expect(bodyForRequest(p,next).chunks).toEqual([]);
  expect(selectArticleBodyRequests([p.manifest],[{...remote,bodyHash:'different'}],{supportsMetadataOnly:true,supportsFullMetadataOnly:true})[0]?.metadataOnly).toBe(false);
 }finally{f.sql.close();}
});
test('received encoding cache avoids HTML derivation/re-encoding and an identical replay writes zero rows',async()=>{
 const f=await fixture();try{const p=await f.packet();expect(await f.repo.receiveArticle(p,'phone',false)).toBeGreaterThan(0);const before=f.changes();expect(await f.repo.receiveArticle(p,'phone',false)).toBe(0);expect(f.changes()).toBe(before);const count=f.counts();await f.repo.prepareWindow('phone',0);expect(f.counts().encodes).toBe(count.encodes);expect(f.counts().htmlCalls).toBe(count.htmlCalls);const out=await f.repo.exportRequested([{articleId:p.article.articleId,bodyHash:'',chunkIndexes:[],metadataOnly:false}]);expect(out[0]?.article.sourceDeviceId).toBe('phone');expect(out[0]?.article.updatedAt).toBe(100);
 }finally{f.sql.close();}
});
test('usage cursor pages ascending, empty batches are read-only and tail reuse rotates durable epoch',async()=>{
 const f=await fixture();try{for(let i=0;i<5;i++)await f.db.execute("INSERT INTO llm_token_usage(provider,model,request_id,usage_json,created_at) VALUES('p','m',?,'{}',?)",[String(i),10-i]);const first=await readTokenUsagePage(f.db,{limit:2,afterId:0});expect(first.records.map(r=>r.id)).toEqual([1,2]);const second=await readTokenUsagePage(f.db,{limit:2,afterId:first.nextAfterId,usageEpoch:first.usageEpoch});expect(second.records.map(r=>r.id)).toEqual([3,4]);const third=await readTokenUsagePage(f.db,{limit:2,afterId:second.nextAfterId,usageEpoch:first.usageEpoch});expect(third).toMatchObject({nextAfterId:5,hasMore:false});const changes=f.changes();expect((await readTokenUsagePage(f.db,{limit:2,afterId:5,usageEpoch:first.usageEpoch})).records).toEqual([]);expect(f.changes()).toBe(changes);await f.db.execute('DELETE FROM llm_token_usage');await f.db.execute("INSERT INTO llm_token_usage(provider,model,request_id,created_at) VALUES('p','m','new',1)");const reset=await readTokenUsagePage(f.db,{limit:2,afterId:5,usageEpoch:first.usageEpoch});expect(reset.reset).toBe(true);expect(reset.usageEpoch).not.toBe(first.usageEpoch);expect(reset.records.map(r=>r.id)).toEqual([1]);
 }finally{f.sql.close();}
});
test('syncAccount skips normalized identical credentials and saves genuine token changes',async()=>{
 const req={action:'syncAccount',account:{userId:'u',watchAccessToken:'t',backendBaseUrl:'https://example.com'}};let state=await parseAccountSyncRequest(req,parseUri,10),saved=0,changed=0;const store={read:async()=>state,save:async(s:typeof state)=>{state=s;saved++;}};
 await syncAccount(req,store,async()=>'watch',parseUri,()=>changed++);expect(saved).toBe(0);expect(changed).toBe(0);await syncAccount({...req,account:{...req.account,watchAccessToken:'new'}},store,async()=>'watch',parseUri,()=>changed++);expect(saved).toBe(1);expect(changed).toBe(1);
});
test('commit notification follows the corresponding business statement count, excluding cache-only updates',()=>{
 let calls=0;const off=subscribeLibraryMutations(()=>calls++);try{notifyLibrarySqlCommit([{sql:'UPDATE articles SET title=?'},{sql:'INSERT INTO article_sync_encoding_cache VALUES(1)'}],[0,1]);expect(calls).toBe(0);notifyLibrarySqlCommit([{sql:'UPDATE articles SET title=?'}],[1]);expect(calls).toBe(1);}finally{off();}
});
test('R41 session keeps same-URL distinct GUID articles, projects every body identity, and forces one feature transition',async()=>{
 const f=await fixture();try{await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://feed.test/rss','Feed',1,-1)");for(let i=1;i<=2;i++){await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(?,1,'title','body','https://example.com/same',?,?,100)",[i,'tag:'+i,'guid:tag:'+i]);await f.db.execute("INSERT INTO article_saved_states VALUES(?,'favorite',1,100,-100)",[i]);}
  f.repo.configurePeer('phone',{supportsRssCanonicalIds:true});const first=await f.repo.prepareWindow('phone',0),ids=await Promise.all([1,2].map(i=>rssArticleId({guid:'tag:'+i},async b=>sha(b))));expect(new Set(first.articleManifest.map(a=>a.articleId))).toEqual(new Set(ids));expect(first.fallbackReason).toBe('articleIdentityChanged');const bodies=await f.repo.exportRequested(ids.map(articleId=>({articleId,bodyHash:'',metadataOnly:false,chunkIndexes:[]})),'phone');expect(new Set(bodies.map(p=>p.article.articleId))).toEqual(new Set(ids));await f.repo.markSuccess({remoteDeviceId:'phone',projectionGeneration:first.projectionGeneration,localSeqToInclusive:first.toSeqInclusive,remoteSeqToInclusive:0,remoteProtocolVersion:14,fullSnapshot:true});expect((await f.repo.prepareWindow('phone',first.toSeqInclusive)).fullSnapshot).toBe(false);f.repo.configurePeer('phone',{});expect((await f.repo.prepareWindow('phone',first.toSeqInclusive)).fullSnapshot).toBe(true);expect((await f.db.query('SELECT id FROM articles')).length).toBe(2);
 }finally{f.sql.close();}
});

test('shared phone note-state/R41 wire vectors are byte-identical and reject ambiguous aliases',async()=>{
 const {readFileSync}=await import('node:fs'),{parseArticleManifest}=await import('../../src/sync/manifest');
 const n=await import('../fixtures/ble-note-state-v2.json'),r=await import('../fixtures/ble-rss-identity-v2.json');
 for(const name of ['ble-note-state-v2.json','ble-rss-identity-v2.json'])expect(readFileSync(import.meta.dir+'/../fixtures/'+name)).toEqual(readFileSync('/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/vectors/'+name));
 for(const row of n.cases)expect(noteManifest({...row.note,plainText:''}).stateHash).toBe(row.stateHash);
 const {stableArticleId}=await import('../../src/sync/local-manifest');for(const row of r.cases)expect(await stableArticleId(row.url,parseUri,{sha256:async b=>sha(b)})).toBe(row.legacyArticleId);
 expect(()=>parseArticleManifest({articleManifest:[{articleId:'a',legacyArticleIds:['old']},{articleId:'b',legacyArticleIds:['old']}]})).toThrow('Ambiguous');
});
test('ACK-gated echo proof suppresses only an unchanged peer-origin state and survives restart',async()=>{
 const f=await fixture();try{const p=await f.packet();await f.repo.receiveArticle(p,'phone',false);const window=await f.repo.prepareWindow('phone',0);const remote=await prepareArticle(p.article,f.codec);await f.repo.markSuccess({remoteDeviceId:'phone',projectionGeneration:window.projectionGeneration,localSeqToInclusive:window.toSeqInclusive,remoteSeqToInclusive:1,remoteProtocolVersion:14,fullSnapshot:true,receivedArticleManifest:[remote.manifest]});
  // Force a redundant change-log entry to prove filtering, rather than an empty window.
  await f.db.execute("INSERT INTO sync_change_log(kind,entity_id,changed_at,origin_device_id,reason,created_at) VALUES('article',?,100,'phone','retry',100)",[p.article.articleId]);expect((await f.repo.prepareWindow('phone',window.toSeqInclusive)).articleManifest).toEqual([]);
  const {SqlLibrarySessionRepository}=await import('../../src/sync/library-repository');const reopened=new SqlLibrarySessionRepository(f.db,f.ports);expect((await reopened.prepareWindow('phone',window.toSeqInclusive)).articleManifest).toEqual([]);
  await f.db.execute('UPDATE articles SET is_read=1');const changed=await reopened.prepareWindow('phone',window.toSeqInclusive);expect(changed.articleManifest).toHaveLength(1);expect(changed.articleManifest[0]?.sourceDeviceId).toBe('watch');
  const third=await f.packet(article({sourceDeviceId:'third',updatedAt:200,title:'third edit',isRead:true}));await reopened.receiveArticle(third,'third',false);expect((await reopened.prepareWindow('phone',window.toSeqInclusive)).articleManifest).toHaveLength(1);
 }finally{f.sql.close();}
});
test('a failed proof/cursor publication leaves prior cursor and active proof unchanged',async()=>{
 const f=await fixture();try{const p=await f.packet();await f.repo.receiveArticle(p,'phone',false);const w=await f.repo.prepareWindow('phone',0);const before=await f.repo.cursor('phone'),transaction=f.db.transaction;f.db.transaction=async ss=>{if(ss.some(s=>s.sql.startsWith('INSERT INTO sync_peer_echo_generation')))throw Error('disk fault');await transaction(ss);};await expect(f.repo.markSuccess({remoteDeviceId:'phone',localSeqToInclusive:w.toSeqInclusive,remoteSeqToInclusive:4,remoteProtocolVersion:14,fullSnapshot:true,receivedArticleManifest:w.fullArticleManifest})).rejects.toThrow('disk fault');expect(await f.repo.cursor('phone')).toEqual(before);expect(await f.db.query('SELECT * FROM sync_peer_echo_generation')).toEqual([]);
 }finally{f.sql.close();}
});
test('source polling never advances business clocks or rewrites equal source state',async()=>{
 const f=await fixture();try{const {SqlSourceSyncStore}=await import('../../src/sync/source-store');const store=new SqlSourceSyncStore(f.db,{parseUri,parseAndroid:parseUri},()=>1000);const remote={url:'https://feed.test/rss',sourceDeviceId:'phone',title:'Feed',description:'desc',siteUrl:null,imageUrl:null,createdAt:10,updatedAt:100,sortOrder:10,isPinned:false,deleted:false,deletedAt:0};expect(await store.merge([remote],'phone','watch')).toBe(1);const first=await store.export('watch');await f.db.execute('UPDATE channels SET last_fetched_at=999999');const changes=f.changes();expect(await store.export('watch')).toEqual(first);expect(f.changes()).toBe(changes);expect(await store.merge([remote],'phone','watch')).toBe(0);expect(f.changes()).toBe(changes);
 }finally{f.sql.close();}
});
test('v4 once-only dedup retains newest saves/body and never merges distinct real GUIDs',async()=>{
 const f=await fixture();try{await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.test/rss','Feed',1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(1,1,'rss','body','https://example.com/item','tag:one','guid:tag:one',1)");const legacy=sha('https://example.com/item');await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(2,1,'old','long original body','https://example.com/item',?,?,2)",[legacy,legacy]);await f.db.execute("INSERT INTO sync_article_ids VALUES(?,2,?)",[legacy,'https://example.com/item']);await f.db.execute("INSERT INTO article_saved_states VALUES(1,'favorite',1,10,-10)");await f.db.execute("INSERT INTO article_saved_states VALUES(2,'favorite',0,20,-20)");await f.db.execute('PRAGMA user_version=3');await initializeSchema(f.db);expect(await f.db.query('SELECT id FROM articles')).toEqual([{id:1}]);expect((await f.db.query("SELECT saved,changed_at FROM article_saved_states WHERE article_id=1 AND save_type='favorite'"))[0]).toEqual({saved:0,changed_at:20});expect((await f.db.query('SELECT content FROM articles'))[0]?.content).toBe('long original body');await initializeSchema(f.db);expect(await f.db.query('SELECT id FROM articles')).toEqual([{id:1}]);
 }finally{f.sql.close();}
});
test('R41 canonical inbound then legacy inbound reuses one row; full replacement retains actual GUID row',async()=>{
 const f=await fixture();try{const url='https://example.com/item',canonical=sha('tag:one'),legacy=sha(url),base=article({articleId:canonical,url,rssSourceUrl:'https://feed.test/rss',rssSourceTitle:'Feed',siteName:'Feed',independentSaved:false,independentChangedAt:0,independentSortOrder:0,favoriteSaved:true,favoriteChangedAt:100,favoriteSortOrder:100});f.repo.configurePeer('phone',{supportsRssCanonicalIds:true});await f.repo.receiveArticle(await f.packet({...base,legacyArticleIds:[legacy]}),'phone',false);expect((await f.repo.prepareWindow('phone',0)).fullArticleManifest[0]?.articleId).toBe(canonical);f.repo.configurePeer('phone',{});await f.repo.receiveArticle(await f.packet({...base,articleId:legacy,updatedAt:101,title:'legacy update'}),'phone',false);expect((await f.db.query('SELECT id FROM articles')).length).toBe(1);f.repo.configurePeer('phone',{supportsRssCanonicalIds:true});await f.repo.finalizeSnapshot([canonical],[base.rssSourceUrl!],'phone');expect((await f.db.query('SELECT title FROM articles'))[0]?.title).toBe('legacy update');
 }finally{f.sql.close();}
});

test('same-body older metadata/tombstones cannot overwrite newer watch title/pin, equal clocks converge with phone tie order',async()=>{
 const f=await fixture();try{const repo=new MemoRepository(f.db,'watch');await repo.initialize();const newer={...note(),title:'watch title',pinned:true,updatedAt:200,modifiedBy:'watch'};await repo.merge([newer]);
  expect(await repo.merge([{...note(),title:'old phone',updatedAt:100}])).toBe(0);expect((await repo.get(newer.noteId))?.title).toBe('watch title');
  expect(await repo.merge([{...newer,deleted:true,deletedAt:150,updatedAt:150}])).toBe(0);
  const winner={...newer,title:'z',modifiedBy:'z'};expect(await repo.merge([winner])).toBe(1);expect(await repo.merge([newer])).toBe(0);
  const handle=createApplicationActionHandler({notes:repo,deviceId:async()=>'watch',notesChanged:()=>{}});const result=await handle({action:'syncNotes',phase:'delta',noteManifest:[noteManifest(note())],notes:[wire(note())]});expect(result.applied).toBe(0);expect(result.notes).toHaveLength(1);expect((result.notes as any[])[0].title).toBe('z');
 }finally{f.sql.close();}
});

test('identical large legacy body replay reuses file references without storeText or database writes',async()=>{
 const f=await fixture();let writes=0;const files=new Map<string,string>();f.ports.files.storeText=async(k,v)=>{writes++;files.set(k,v);return 'file:'+k;};f.ports.files.hydrate=async v=>v.startsWith('file:')?files.get(v.slice(5))!:v;
 try{const p=await f.packet(article({contentText:'large 中文'.repeat(10000),contentHtml:null}));await f.repo.receiveArticle(p,'phone',false);const first=writes,changes=f.changes();expect(first).toBeGreaterThan(0);expect(await f.repo.receiveArticle(p,'phone',false)).toBe(0);expect(writes).toBe(first);expect(f.changes()).toBe(changes);}finally{f.sql.close();}
});

test('source fallback description preserves accepted peer metadata and a stale first receive cannot publish false state',async()=>{
 const f=await fixture();try{const {SqlSourceSyncStore}=await import('../../src/sync/source-store');const store=new SqlSourceSyncStore(f.db,{parseUri,parseAndroid:parseUri},()=>1000);
 const source={url:'https://feed.example/rss',sourceDeviceId:'phone',title:'Feed',description:'',siteUrl:'https://site.example',imageUrl:null,createdAt:1,updatedAt:20,sortOrder:10,isPinned:false,deleted:false,deletedAt:0};
 expect(await store.merge([source],'phone','watch')).toBe(1);expect((await store.export('watch')).find(s=>s.url===source.url)).toEqual(source);const changes=f.changes();expect(await store.merge([source],'phone','watch')).toBe(0);expect(f.changes()).toBe(changes);
 await f.db.execute("INSERT INTO channels(url,title,created_at,sort_order) VALUES('https://new.example/rss','Local',50,-50)");const before=f.changes();expect(await store.merge([{...source,url:'https://new.example/rss',updatedAt:30}],'phone','watch')).toBe(0);expect(f.changes()).toBe(before);expect(await f.db.query("SELECT * FROM sync_source_states WHERE url='https://new.example/rss'")).toEqual([]);
 }finally{f.sql.close();}
});

test('one-time dedup refuses ambiguous URL aliases and unproven hash-shaped genuine GUIDs',async()=>{
 const f=await fixture();try{await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://feed.test/rss','Feed',1)");const legacy=sha('https://example.com/shared');
 for(const [id,guid,key]of [[1,'tag:one','guid:tag:one'],[2,'tag:two','guid:tag:two'],[3,legacy,legacy]] as const)await f.db.execute("INSERT INTO articles(id,channel_id,title,link,guid,dedup_key,fetched_at) VALUES(?,1,'item','https://example.com/shared',?,?,1)",[id,guid,key]);
 await f.db.execute("INSERT INTO sync_article_ids VALUES(?,3,'https://example.com/shared')",[legacy]);await f.db.execute('PRAGMA user_version=3');await initializeSchema(f.db);expect(await f.db.query('SELECT id FROM articles ORDER BY id')).toEqual([{id:1},{id:2},{id:3}]);
 await f.db.execute('DELETE FROM sync_article_ids');await f.db.execute('DELETE FROM articles WHERE id=2');await f.db.execute('PRAGMA user_version=3');await initializeSchema(f.db);expect(await f.db.query('SELECT id FROM articles ORDER BY id')).toEqual([{id:1},{id:3}]);
 }finally{f.sql.close();}
});
