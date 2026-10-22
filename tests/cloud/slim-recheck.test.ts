import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import {dbFixture,article,cloudCrypto} from './library-fixture';
import {fixture as serviceFixture} from './service-fixture';
import {crypto,key,enabled} from './k2-crypto';
import {rssSourceKey,rssArticleId,isLocalOnlyRssSource,canonicalRssUrl} from '../../src/cloud/rss-identity';
import {WatchCloudRecords,CloudRecordCodec} from '../../src/cloud/records';
import {WatchCloudSyncService} from '../../src/cloud/service';
import {WatchCloudStateStore} from '../../src/cloud/state';
import {WatchRssRepository} from '../../src/core/repository';
import {ImportedArticleDeletion} from '../../src/core/imported-article-deletion';
import {utf8Encode} from '../../src/cloud/types';
import sourceVector from './fixtures/rss-source-key.json';
import shape from './fixtures/private-archive-v3.json';
const rc={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')},epoch='9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff';
async function integration(){const f=await serviceFixture(),db=await dbFixture();f.session.library=db.adapter;f.session.records=async(_,current)=>new WatchCloudRecords({userId:'user',epoch,anchorVersion:1,version:1,crypto:rc,key:async()=>key.slice(),readState:()=>f.cache.records('user'),writeState:v=>f.cache.storeRecords('user',v),get:after=>(f.session.client as any).records(after,'watch'),push:items=>(f.session.client as any).pushRecords(items),current,assertUpload:async()=>current(),apply:docs=>db.adapter.applyRecords(docs),export:()=>db.adapter.exportRecords()});return {...f,db};}
const privateArticle=async(url:string)=>article({articleId:await cloudCrypto.stableId(url),url,contentHtml:null,contentText:'local original'});
test('R36 local-only subscriptions stay byte-preserved; export/apply/refresh skip interactions without poisoning healthy lanes',async()=>{
 const f=await integration();try{const locals=['http://192.168.1.10/rss','http://127.0.0.1/rss','http://[::ffff:127.0.0.1]/rss','https://user:secret@example.com/rss'],publicUrl='https://public.example/rss';
  for(const [i,url]of [...locals,publicUrl].entries()){await f.db.db.execute('INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(?,?,?,1,1)',[i+1,url,'Feed '+i]);await f.db.db.execute('INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at,is_read,reading_progress) VALUES(?,?,?,?,?,1,1,.5)',[i+1,'Read','local body',`https://entry.example/${i}`,String(i)]);}
  for(const url of locals)expect(isLocalOnlyRssSource(url)).toBe(true);expect(isLocalOnlyRssSource(publicUrl)).toBe(false);const resolved:string[]=[];f.session.client.resolveRssSource=async url=>{resolved.push(url);return {sourceId:'public-id',url,title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[]};};
  expect(await f.service.syncNow(true)).toBe(true);expect(resolved).toEqual([publicUrl]);expect(f.service.status.message).toBe('云同步完成');const docs=await f.db.adapter.exportRecords();expect(docs.filter(d=>d.kind==='source').map(d=>d.value.url).sort()).toEqual([...locals,publicUrl].sort());expect(docs.filter(d=>d.kind==='rss-state')).toHaveLength(1);
  const old=article({articleId:'legacy-local',url:'https://entry.example/0',rssSourceUrl:locals[0],independentSaved:false,isRead:true});await expect(f.db.adapter.applyRecords([{kind:'article',value:Object.fromEntries(Object.entries(old).filter(([k])=>!['contentText','contentHtml'].includes(k)))}])).resolves.toBe(0);await expect(f.db.adapter.applyReadingStates()).resolves.toBe(0);
 }finally{f.db.sql.close();}
});
test('R37 locally parsed feed links export the same cloud article IDs and state hashes as public inventory',async()=>{
 const f=await dbFixture();try{await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://public.example/rss','Feed',1,1)");
  for(const [i,v]of sourceVector.articleCases.filter(v=>v.name==='absolute-link').entries())await f.db.execute('INSERT INTO articles(channel_id,title,content,link,dedup_key,fetched_at,is_read,reading_progress) VALUES(1,?,?,?, ?,1,1,.5)',['Local feed article','body',v.input,String(i)]);
  const rows=await f.repo.cloudReadingCandidates(),docs=(await f.adapter.exportRecords()).filter(d=>d.kind==='rss-state');for(const v of sourceVector.articleCases.filter(v=>v.name==='absolute-link')){expect(rows.find(a=>a.url===v.input)?.articleId).toBe(v.articleId);expect(docs.some(d=>d.value.articleIdHash===v.articleIdHash)).toBe(true);}expect(docs.length).toBe(new Set(sourceVector.articleCases.filter(v=>v.name==='absolute-link').map(v=>v.articleIdHash)).size);
 }finally{f.sql.close();}
});
test('R39 imported/standalone reading changes write one article state, no body snapshot, and the real local delete API writes an encrypted tombstone',async()=>{
 const f=await integration();try{const a=await privateArticle('https://private.example/import');await f.db.repo.mergeCloud([], [a], 'phone');expect(await f.service.syncNow(true)).toBe(true);const snapshots=f.reservations.size,c=new CloudRecordCodec(rc),read=(row:any)=>c.decode(key,key,'user',row),initial=await Promise.all([...f.recordRows.values()].map(read));expect(initial.some(d=>d.doc.kind==='article'&&d.doc.value.articleId===a.articleId)).toBe(true);
  await new WatchRssRepository(f.db.db,async()=>'').setRead(1,true,.75);expect(await f.service.syncNow(true)).toBe(true);expect(f.reservations.size).toBe(snapshots);const active=await Promise.all([...f.recordRows.values()].map(read));expect(active.find(d=>d.doc.kind==='article')?.doc.value).toMatchObject({isRead:true,readingProgress:.75});
  const parseUri=async(value:string)=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};};await new ImportedArticleDeletion(f.db.db,{parseUri},crypto,{list:async()=>({entries:[]}),remove:async()=>{},stat:async()=>({exists:false})},async()=>{},()=>Date.now()+1).delete(1);expect(await f.service.syncNow(true)).toBe(true);const rows=await Promise.all([...f.recordRows.values()].map(async row=>({row,...await read(row)}))),deleted=rows.find(d=>d.doc.kind==='article'&&d.doc.value.articleId===a.articleId)!;expect(deleted.row.tombstone).toBe(true);expect(deleted.doc.value.deleted).toBe(true);expect(deleted.doc.value.deletedAt).toBeGreaterThan(0);expect('contentText'in deleted.doc.value).toBe(false);expect('contentHtml'in deleted.doc.value).toBe(false);
 }finally{f.db.sql.close();}
});
const bodyObject=()=>({...shape.reader,bytes:utf8Encode(shape.text)});
const service=(f:Awaited<ReturnType<typeof serviceFixture>>)=>new WatchCloudSyncService({open:async()=>f.session,network:async()=>f.network,hash:crypto.sha256,uuid:async()=> 'restarted-new-head',exclusive:async fn=>fn(),now:()=>10},enabled);
test('R38 terminal metadata failure warns once, applies/ACKs the immutable head, and a restart does not loop',async()=>{
 const f=await integration();try{const {head}=await f.phone({objects:[{...bodyObject(),privateArticle:{...shape.article,title:''}}]});expect(await f.service.syncNow(true)).toBe(true);expect(f.service.status.abandonedItems).toBe(1);expect(f.service.status.message).toContain('已放弃');expect(await f.state.applied('phone',true)).toBe(head.deviceSequence);expect(f.calls.some(c=>c.url.includes('/'+head.id+'/ack'))).toBe(true);const restarted=service(f);expect(await restarted.syncNow(true)).toBe(true);expect(restarted.status.abandonedItems).toBe(0);expect(restarted.status.message).not.toContain('已放弃');
 }finally{f.db.sql.close();}
});
test('R38 permanent old reader without privateArticle has a terminal outcome rather than permanent pending',async()=>{
 const f=await integration();try{await f.phone({objects:[{name:shape.reader.name,bytes:utf8Encode(shape.text)}]});expect(await f.service.syncNow(true)).toBe(true);expect(f.service.status.pendingItems).toBe(0);expect(f.service.status.abandonedItems).toBe(1);expect(await f.service.syncNow(true)).toBe(true);expect(f.service.status.message).not.toContain('已放弃');}finally{f.db.sql.close();}
});
test('R38 mixed permanent + transient failures persist one-time warning across guests; repaired chunk finishes the same head',async()=>{
 const f=await integration();try{const other=await privateArticle('https://private.example/second'),name=`reader/${(await crypto.sha256(utf8Encode(other.articleId))).slice(0,32)}/${(await crypto.sha256(utf8Encode(other.contentHash))).slice(0,32)}.txt`,{head,snap}=await f.phone({objects:[{...bodyObject(),privateArticle:{...shape.article,title:''}},{name,bytes:utf8Encode('other original'),privateArticle:{...other}}]}),hash=snap.manifest.objects[1].chunks[0].ciphertextSha256,bytes=f.objects.get(hash)!;f.objects.delete(hash);
  expect(await f.service.syncNow(true)).toBe(false);expect(f.service.status.pendingItems).toBe(1);expect(f.service.status.abandonedItems).toBe(1);expect(await f.state.applied('phone',true)).toBe(0);const restarted=service(f);expect(await restarted.syncNow(true)).toBe(false);expect(restarted.status.message).not.toContain('已放弃');expect(restarted.status.pendingItems).toBe(1);f.objects.set(hash,bytes);expect(await restarted.syncNow(true)).toBe(true);expect(await f.state.applied('phone',true)).toBe(head.deviceSequence);expect((await f.db.repo.cloudSnapshot(true)).articles[0].contentText).toBe('other original');
 }finally{f.db.sql.close();}
});
test('R38 missing incoming private body does not block publishing a different healthy local original or records',async()=>{
 const f=await integration();try{await f.db.repo.mergeCloud([], [await privateArticle('https://private.example/local')], 'phone');const incoming={...article(),...shape.article,rssSourceUrl:null,independentSaved:true,contentText:'',contentHtml:null};await f.db.adapter.applyRecords([{kind:'article',value:Object.fromEntries(Object.entries(incoming).filter(([k])=>!['contentText','contentHtml'].includes(k)))}]);expect(await f.service.syncNow(true)).toBe(false);expect(f.service.status.pendingItems).toBeGreaterThan(0);expect(f.reservations.size).toBe(1);const out=await f.db.adapter.exportPayloads(true);expect(out.articleIds).toHaveLength(1);expect(out.articleIds).not.toContain(incoming.articleId);expect(f.recordRows.size).toBeGreaterThan(0);
 }finally{f.db.sql.close();}
});
test('R40 records unavailable still reads a healthy private snapshot, but never publishes a records-dependent local snapshot',async()=>{
 const f=await integration();try{await f.db.repo.mergeCloud([], [await privateArticle('https://private.example/local')], 'phone');await f.phone({objects:[{...bodyObject(),privateArticle:shape.article}]});f.session.records=async()=>{throw Error('offline records');};expect(await f.service.syncNow(true)).toBe(false);expect((await f.db.repo.cloudSnapshot(true)).articles.some(a=>a.articleId===shape.article.articleId&&a.contentText===shape.text)).toBe(true);expect(await f.state.applied('phone',true)).toBe(1);expect(f.reservations.size).toBe(0);
 }finally{f.db.sql.close();}
});
test('R38 terminal-warning state follows backend/user/epoch clearing',async()=>{
 const map=new Map<string,string>(),store={get:async(k:string)=>map.get(k),set:async(k:string,v:string)=>{map.set(k,v);}};const first=new WatchCloudStateStore(store,'u','d',enabled,'https://one');await first.acceptEpoch('epoch1');await first.markWarned('phone','bad-head');expect(await first.warned('phone','bad-head')).toBe(true);for(const state of [new WatchCloudStateStore(store,'other','d',enabled,'https://one'),new WatchCloudStateStore(store,'u','d',enabled,'https://two')])expect(await state.warned('phone','bad-head')).toBe(false);await first.acceptEpoch('epoch2');expect(await first.warned('phone','bad-head')).toBe(false);
});
test('R36 retained pre-v36 private source-key/UUID states are not forwarded from pending replay',async()=>{
 const f=await dbFixture();try{const url='http://192.168.1.10/rss';await f.adapter.applyRecords([{kind:'source',value:{url,title:'Local only',sourceId:'old-local-pool-id',updatedAt:1}},{kind:'rss-state',value:{sourceId:await crypto.sha256(utf8Encode(canonicalRssUrl(url,false))),articleIdHash:'a'.repeat(64),isRead:true}},{kind:'rss-state',value:{sourceId:'old-local-pool-id',articleIdHash:'b'.repeat(64),isRead:true}}]);expect((await f.adapter.exportRecords()).filter(d=>d.kind==='rss-state')).toHaveLength(0);expect((await f.adapter.exportRecords()).find(d=>d.kind==='source')?.value.url).toBe(url);
 }finally{f.sql.close();}
});
