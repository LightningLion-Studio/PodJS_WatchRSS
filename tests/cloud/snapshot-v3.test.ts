import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import {fixture} from './service-fixture';
import {dbFixture,article,cloudCrypto} from './library-fixture';
import {crypto,key} from './k2-crypto';
import {WatchCloudRecords,CloudRecordCodec,type RecordPorts,type RecordDocument} from '../../src/cloud/records';
import {WatchRssRepository} from '../../src/core/repository';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
import {writeWrss,readWrss} from '../../src/cloud/wrss';
import {rssSourceKey} from '../../src/cloud/rss-identity';
import {WatchCloudScheduler} from '../../src/cloud/scheduler';
import {enabled} from './k2-crypto';
import {deflateRawSync} from 'node:zlib';
const recordCrypto={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')};
const body=(count:number,seed:number)=>{const bytes=new Uint8Array(count);for(let i=0;i<count;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;bytes[i]=seed&255;}return Buffer.from(bytes).toString('base64');};
const epoch='9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff';
async function integration(){
 const f=await fixture(),local=await dbFixture();f.session.library=local.adapter;
 f.session.records=async(_bootstrap,current)=>new WatchCloudRecords({userId:'user',epoch,anchorVersion:1,version:1,crypto:recordCrypto,key:async()=>key.slice(),readState:()=>f.cache.records('user'),writeState:value=>f.cache.storeRecords('user',value),get:after=>(f.session.client as any).records(after,f.session.deviceId),push:items=>(f.session.client as any).pushRecords(items),current,assertUpload:async()=>{await current();await f.session.assertUpload?.();},apply:docs=>local.adapter.applyRecords(docs),export:()=>local.adapter.exportRecords()});
 const pool={sourceId:'pool-id',url:'https://feed.example/rss',title:'Feed',description:'',siteUrl:null,imageUrl:null,items:Array.from({length:500},(_,i)=>({url:`https://example.com/${i}`,title:`Article ${i}`,excerpt:'public summary',contentHtml:null,contentText:'public body',imageUrl:null,guid:String(i),contentHash:null}))};f.pool(pool);
 return {...f,local,pool};
}
const posts=(f:Pick<Awaited<ReturnType<typeof fixture>>,'calls'>)=>f.calls.filter(r=>r.method==='POST'&&r.url.endsWith('/records')).flatMap(r=>JSON.parse(utf8Decode(r.body!)).items);
test('S7/S8: 500 public entries stay local; one read writes exactly one state and zero snapshot blocks',async()=>{
 const f=await integration();try{
  await f.local.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,'Feed',1,1)",[f.pool.url]);
  expect(await f.service.syncNow()).toBe(true);expect(await f.local.db.query('SELECT COUNT(*) AS n FROM articles')).toEqual([{n:500}]);expect(posts(f)).toHaveLength(1);expect(f.reservations.size).toBe(0);
  await f.local.db.execute('UPDATE channels SET last_fetched_at=999999 WHERE id=1');const before=posts(f).length;await new WatchRssRepository(f.local.db,async()=>'').setRead(1,true,.25);
  expect(await f.service.syncNow()).toBe(true);const changes=posts(f).slice(before);expect(changes).toHaveLength(1);const codec=new CloudRecordCodec(recordCrypto),doc=await codec.decode(key,key,'user',{...changes[0],revision:'2'});expect(doc.doc.kind).toBe('rss-state');expect(doc.doc.value).toMatchObject({sourceId:await rssSourceKey(f.pool.url,crypto.sha256),isRead:true,readingProgress:.25});expect(Object.keys(doc.doc.value)).not.toContain('title');expect(f.reservations.size).toBe(0);
  const readClock=doc.doc.value.readingPositionChangedAt;await new WatchRssRepository(f.local.db,async()=>'').setRead(1,false);expect(await f.service.syncNow()).toBe(true);const unread=posts(f).at(-1),decoded=await codec.decode(key,key,'user',{...unread,revision:'3'});expect(decoded.doc.value.isRead).toBe(false);expect(decoded.doc.value.readingPositionChangedAt).toBeGreaterThan(readClock);expect(f.reservations.size).toBe(0);
  const fresh=await integration();try{fresh.seedRecords(f.recordRows);expect(await fresh.service.syncNow(true)).toBe(true);expect(await fresh.local.db.query('SELECT COUNT(*) n FROM articles')).toEqual([{n:500}]);const applied=(await fresh.local.db.query("SELECT a.is_read,r.changed_at,r.progress FROM articles a JOIN article_reading_state r ON r.article_id=a.id WHERE a.link='https://example.com/0'"))[0];expect(applied).toMatchObject({is_read:0,changed_at:decoded.doc.value.readingPositionChangedAt,progress:.25});expect(fresh.reservations.size).toBe(0);}finally{fresh.local.sql.close();}
 }finally{f.local.sql.close();}
},30000); // 500 entries across SQLite subprocess fixtures; behavior assertions remain unchanged.
test('S7: one new private body is incremental; metadata does not change archive; cache loss reuses authenticated head; empty device restores records + WRSS',async()=>{
 const f=await integration();let restored:Awaited<ReturnType<typeof integration>>|undefined;
 try{
  const first=article({articleId:await cloudCrypto.stableId('https://private.example/first'),url:'https://private.example/first',contentHtml:null,contentText:body(3*1024*1024,123),contentHash:'private-first-hash'});
  await f.local.repo.mergeCloud([], [first], 'phone');expect(await f.service.syncNow(true)).toBe(true);expect(f.reservations.size).toBe(1);
  const initial=await f.local.adapter.exportPayloads(true),head=f.heads.get('watch')!,before=new Set(f.objects.keys());
  const second=article({articleId:await cloudCrypto.stableId('https://private.example/second'),url:'https://private.example/second',contentHtml:null,contentText:body(512*1024,456),contentHash:'private-second-hash',importedAt:3});
  await f.local.repo.mergeCloud([], [second], 'phone');expect(await f.service.syncNow(true)).toBe(true);expect(f.reservations.size).toBe(2);
  const newBytes=[...f.objects].filter(([h])=>!before.has(h)).reduce((n,[,b])=>n+b.length,0);expect(newBytes).toBeLessThan(utf8Encode(second.contentText).length+2*1048576);expect(newBytes).toBeGreaterThan(utf8Encode(second.contentText).length);
  const last=f.heads.get('watch')!,m=await f.session.codec.decryptManifest(key,last.id,f.objects.get(last.manifestSha256)!);expect(m.objects.map(o=>o.name)).toEqual(['private-library.wrss']);expect(m.settings.libraryEpoch).toBe(epoch);expect(last.id).not.toBe(head.id);
  const puts=f.calls.filter(c=>c.method==='PUT').length;f.blobs.clear();expect(await f.service.syncNow(true)).toBe(true);expect(f.calls.filter(c=>c.method==='PUT')).toHaveLength(puts);expect(f.reservations.size).toBe(2);expect(f.calls.some(c=>c.url==='https://objects.invalid/'+last.manifestSha256)).toBe(true);
  const stable=await f.local.adapter.exportPayloads(true);await new WatchRssRepository(f.local.db,async()=>'').setRead(1,true,.6);expect(await f.service.syncNow(true)).toBe(true);expect(await f.local.adapter.exportPayloads(true)).toEqual(stable);expect(f.reservations.size).toBe(2);expect(initial.objects[0].bytes.length).toBeGreaterThan(4*1024*1024);
  restored=await integration();restored.session.deviceId='new-watch';for(const e of f.objects)restored.objects.set(...e);for(const e of f.heads)restored.heads.set(...e);restored.seedRecords(f.recordRows);
  expect(await restored.service.syncNow(true)).toBe(true);const data=await restored.local.repo.cloudSnapshot(true);expect(data.articles.map(a=>a.articleId).sort()).toEqual([first.articleId,second.articleId].sort());expect(data.articles.find(a=>a.articleId===first.articleId)?.contentText).toBe(first.contentText);expect(data.articles.find(a=>a.articleId===first.articleId)?.readingProgress).toBeCloseTo(.6);expect(data.articles.find(a=>a.articleId===second.articleId)?.contentText).toBe(second.contentText);console.info('S7 private metrics',JSON.stringify({baseBodyBytes:utf8Encode(first.contentText).length,addedBodyBytes:utf8Encode(second.contentText).length,newEncryptedBytes:newBytes,cacheLossBodyUploads:0,restoredPrivateArticles:data.articles.length}));
 }finally{f.local.sql.close();restored?.local.sql.close();}
},30000);
test('WRSS parser accepts DEFLATE, rejects CRC/path/duplicates and expanded bounds',async()=>{
 const zip=writeWrss(new Map([['a.txt',utf8Encode('hello')]]));expect(utf8Decode((await readWrss(zip,crypto.gunzip)).get('a.txt')!)).toBe('hello');const corrupt=zip.slice();corrupt[35]^=1;await expect(readWrss(corrupt,crypto.gunzip)).rejects.toThrow('cloud_archive_invalid');
 await expect(readWrss(writeWrss(new Map([['../a',utf8Encode('x')]])),crypto.gunzip)).rejects.toThrow('cloud_archive_invalid');
 // Build an independent compressed ZIP fixture from the store central directory.
 const raw=utf8Encode('deflate body '.repeat(100)),stored=writeWrss(new Map([['x',raw]])),packed=new Uint8Array(deflateRawSync(raw)),cd=stored.slice(31+raw.length,-22),end=stored.slice(-22),local=stored.slice(0,31);const l=new DataView(local.buffer),c=new DataView(cd.buffer),e=new DataView(end.buffer);l.setUint16(8,8,true);l.setUint32(18,packed.length,true);c.setUint16(10,8,true);c.setUint32(20,packed.length,true);e.setUint32(16,local.length+packed.length,true);const joined=new Uint8Array(local.length+packed.length+cd.length+end.length);let at=0;for(const p of [local,packed,cd,end]){joined.set(p,at);at+=p.length;}expect((await readWrss(joined,crypto.gunzip)).get('x')).toEqual(raw);
});
test('cloud SQL reading merge accepts explicit unread and deterministic device/false ties without losing body',async()=>{
 const f=await dbFixture();try{const a=article({sourceDeviceId:'z',readingPositionChangedAt:10,isRead:true});await f.adapter.applyRecords([{kind:'article',value:Object.fromEntries(Object.entries(a).filter(([k])=>!['contentText','contentHtml'].includes(k)))}]);await f.repo.mergeCloud([], [a], 'phone');
  for(const [source,clock,read,expected]of [['a',10,false,true],['z',10,false,false],['z',9,true,false],['a',11,true,true],['a',12,false,false]] as const){await f.repo.mergeCloud([], [{...a,sourceDeviceId:source,readingPositionChangedAt:clock,isRead:read,contentText:'',contentHtml:null}], 'cloud-records');expect((await f.db.query('SELECT is_read FROM articles'))[0].is_read).toBe(expected?1:0);}
  expect((await f.repo.cloudSnapshot(true)).articles[0].contentText).toBe('private');
 }finally{f.sql.close();}
});
test('S8 saved RSS original is private once; reorder does not publish; cancellation removes body without writing article records',async()=>{
 const f=await integration();try{
  f.pool.items=f.pool.items.slice(0,1);f.session.library.publicSources=async()=>[{url:f.pool.url} as any];
  await f.local.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,'My title',1,1)",[f.pool.url]);expect(await f.service.syncNow(true)).toBe(true);
  const local=new WatchRssRepository(f.local.db,async()=>'');await local.setSaved(1,true);expect(await f.service.syncNow(true)).toBe(true);expect(f.reservations.size).toBe(1);
  const archive=await f.local.adapter.exportPayloads(true);f.pool.items[0].contentText='changed public body';expect(await f.service.syncNow(true)).toBe(true);expect(await f.local.adapter.exportPayloads(true)).toEqual(archive);expect(archive.objects).toHaveLength(1);expect((await f.local.db.query('SELECT title FROM channels WHERE id=1'))[0].title).toBe('My title');
  await f.local.db.execute("UPDATE article_saved_states SET changed_at=changed_at+1,sort_order=sort_order+1 WHERE article_id=1");expect(await f.service.syncNow(true)).toBe(true);expect(f.reservations.size).toBe(1);expect(await f.local.adapter.exportPayloads(true)).toEqual(archive);
  await local.setSaved(1,false);expect(await f.service.syncNow(true)).toBe(true);expect(f.reservations.size).toBe(2);const last=f.heads.get('watch')!,manifest=await f.session.codec.decryptManifest(key,last.id,f.objects.get(last.manifestSha256)!);expect(manifest.objects).toEqual([]);
  const codec=new CloudRecordCodec(recordCrypto),docs=await Promise.all([...f.recordRows.values()].map(async r=>({row:r,...await codec.decode(key,key,'user',r)})));expect(docs.some(d=>d.doc.kind==='article')).toBe(false);expect(await f.local.db.query('SELECT COUNT(*) n FROM articles')).toEqual([{n:1}]);expect(await f.service.syncNow(true)).toBe(true);expect(await f.local.db.query('SELECT COUNT(*) n FROM articles')).toEqual([{n:1}]);expect(f.reservations.size).toBe(2);
 }finally{f.local.sql.close();}
});
test('automatic private snapshot publication waits ten minutes; manual bypass still requires actual content change',async()=>{
 const f=await integration();try{
  const a=article({url:'https://private.example/throttle',articleId:await cloudCrypto.stableId('https://private.example/throttle')});await f.local.repo.mergeCloud([], [a], 'phone');expect(await f.service.syncNow()).toBe(true);expect(f.reservations.size).toBe(1);
  const b=article({url:'https://private.example/second',articleId:await cloudCrypto.stableId('https://private.example/second')});await f.local.repo.mergeCloud([], [b], 'phone');expect(await f.service.syncNow()).toBe(false);expect(f.service.status.message).toBe('稍后合并备份');expect(f.service.status.retryAtMillis).toBe(600010);expect(f.reservations.size).toBe(1);expect(await f.service.syncNow(true)).toBe(true);expect(f.reservations.size).toBe(2);expect(await f.service.syncNow(true)).toBe(true);expect(f.reservations.size).toBe(2);
 }finally{f.local.sql.close();}
});
test('new private metadata cannot publish an old body under a new hash; legacy baselines cannot override verified records',async()=>{
 const f=await dbFixture();try{
  const a=article({articleId:await cloudCrypto.stableId('https://example.com/private'),isRead:false,readingPositionChangedAt:100,sourceDeviceId:'z'});await f.repo.mergeCloud([], [a], 'phone');
  const value=Object.fromEntries(Object.entries({...a,contentHash:'next-version',updatedAt:200}).filter(([k])=>!['contentText','contentHtml'].includes(k)));await f.adapter.applyRecords([{kind:'article',value}]);
  const pending=await f.adapter.exportPayloads(true);expect(pending.pendingPrivateArticles).toBe(1);expect(pending.objects).toHaveLength(0);
  const legacy=utf8Encode(JSON.stringify({version:14,action:'syncLibrary',rssSources:[],articles:[{...a,isRead:true,readingPositionChangedAt:1,contentTextGzip:Buffer.from(await crypto.gzip(utf8Encode('obsolete body'))).toString('base64')}]}));
  await f.adapter.restorePayloads(new Map([['library-sync.json',legacy]]),'legacy-phone');await f.adapter.applyRecords([{kind:'article',value}]);expect((await f.db.query('SELECT is_read FROM articles'))[0].is_read).toBe(0);
  const next={...a,contentHash:'next-version',updatedAt:200,contentText:'new real body',contentHtml:null};await f.repo.mergeCloud([], [next], 'phone');expect((await f.adapter.exportPayloads(true)).objects).toHaveLength(1);expect((await f.repo.cloudSnapshot(true)).articles[0].contentText).toBe('new real body');
 }finally{f.sql.close();}
});
test('S8 first-run migration resolves an old subscription without sourceId before migrating reading state and deleting its index',async()=>{
 const f=await integration();try{
  f.pool.items=f.pool.items.slice(0,1);const codec=new CloudRecordCodec(recordCrypto),a=article({articleId:await cloudCrypto.stableId('https://example.com/0'),url:'https://example.com/0',rssSourceUrl:f.pool.url,independentSaved:false,isRead:true,readingPositionChangedAt:8,readingProgress:.25});
  const source={kind:'source',value:{url:f.pool.url,title:'My legacy title',updatedAt:1,sortOrder:1,isPinned:false,deleted:false,deletedAt:0}},old={kind:'article',value:Object.fromEntries(Object.entries(a).filter(([k])=>!['contentText','contentHtml'].includes(k)))};
  const rows=new Map<string,any>();for(const [i,d]of [source,old].entries()){const id=await codec.id(key,'user',d);rows.set(id,{recordId:id,revision:String(i+1),envelope:await codec.encode(key,'user',id,1,d),tombstone:false});}f.seedRecords(rows);
  expect(await f.service.syncNow(true)).toBe(true);expect(f.reservations.size).toBe(0);const row=(await f.local.db.query('SELECT a.is_read,r.changed_at FROM articles a JOIN article_reading_state r ON r.article_id=a.id'))[0];expect(row).toEqual({is_read:1,changed_at:8});
  const sourceKey=await rssSourceKey(f.pool.url,crypto.sha256),oldId=await codec.id(key,'user',old),retired=f.recordRows.get(oldId);expect(retired.tombstone).toBe(true);expect((await codec.decode(key,key,'user',retired)).doc.value.deleted).toBe(true);const written=await Promise.all(posts(f).map(async row=>(await codec.decode(key,key,'user',{...row,revision:'1'})).doc));expect(written.some(d=>d.kind==='rss-state'&&d.value.sourceId===sourceKey&&d.value.isRead)).toBe(true);expect(await f.local.db.query('SELECT COUNT(*) n FROM articles')).toEqual([{n:1}]);
 }finally{f.local.sql.close();}
});
test('S8 subscription LWW and hash exclude public fetch clocks; genuine remote rename/order/pin still merge',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order,last_fetched_at) VALUES(1,'https://feed.example/rss','Local',1,1,999999)");await f.adapter.mergeInventory({sourceId:'pool',url:'https://feed.example/rss',title:'Public',description:'',siteUrl:null,imageUrl:null,items:[]});const initial=(await f.adapter.exportRecords()).find(d=>d.kind==='source')!;expect(initial.value.updatedAt).toBe(1);
  await f.adapter.applyRecords([{kind:'source',value:{url:'https://feed.example/rss',sourceId:'pool',title:'Phone rename',sourceDeviceId:'phone',updatedAt:20,sortOrder:3,isPinned:true,deleted:false,deletedAt:0}}]);expect((await f.db.query('SELECT title,sort_order,is_pinned FROM channels'))[0]).toEqual({title:'Phone rename',sort_order:-3,is_pinned:1});
  const before=await f.adapter.exportRecords();await f.db.execute('UPDATE channels SET last_fetched_at=999999999');expect(await f.adapter.exportRecords()).toEqual(before);expect(before.find(d=>d.kind==='source')?.value.updatedAt).toBe(20);
 }finally{f.sql.close();}
});
test('R30 failing resolve never blocks records/private snapshots, and unsubscribed sources are never resolved',async()=>{
 const f=await integration();try{
  await f.local.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,?,'No pool yet',1,1)",[f.pool.url]);await f.local.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(2,'https://unsubscribed.example/rss','Removed',1,2)");await f.local.adapter.applyRecords([{kind:'source',value:{url:'https://unsubscribed.example/rss',title:'Removed',updatedAt:1000,deleted:true,deletedAt:1000}}]);
  const rss=article({articleId:await cloudCrypto.stableId('https://example.com/read-offline'),url:'https://example.com/read-offline',rssSourceUrl:f.pool.url,independentSaved:false,isRead:false,readingPositionChangedAt:100,favoriteSaved:false,favoriteChangedAt:110,watchLaterSaved:false,watchLaterChangedAt:120});await f.local.repo.mergeCloud([], [rss,article({articleId:await cloudCrypto.stableId('https://private.example/p'),url:'https://private.example/p'})], 'phone');const resolved:string[]=[];f.session.client.resolveRssSource=async url=>{resolved.push(url);throw Error('offline resolve');};
  expect(await f.service.syncNow(true)).toBe(true);expect(resolved).toEqual([f.pool.url]);expect(f.reservations.size).toBe(1);expect(f.service.status.message).toContain('公共 RSS 待重试');const c=new CloudRecordCodec(recordCrypto),docs=await Promise.all(posts(f).map(async row=>(await c.decode(key,key,'user',{...row,revision:'1'})).doc));expect(docs.filter(d=>d.kind==='article')).toHaveLength(1);expect(docs.find(d=>d.kind==='rss-state')?.value).toMatchObject({sourceId:await rssSourceKey(f.pool.url,crypto.sha256),favoriteChangedAt:110,watchLaterChangedAt:120});
 }finally{f.local.sql.close();}
});
test('R34 saved legacy index survives failed complete, then retires only after the retried archive completes',async()=>{
 const f=await integration();try{f.pool.items=f.pool.items.slice(0,1);const c=new CloudRecordCodec(recordCrypto),a=article({articleId:await cloudCrypto.stableId('https://example.com/0'),url:'https://example.com/0',rssSourceUrl:f.pool.url,independentSaved:false,favoriteSaved:true,favoriteChangedAt:10}),source={kind:'source',value:{url:f.pool.url,title:'Feed',updatedAt:1}},old={kind:'article',value:Object.fromEntries(Object.entries(a).filter(([k])=>!['contentText','contentHtml'].includes(k)))};const rows=new Map<string,any>();for(const [i,d]of [source,old].entries()){const id=await c.id(key,'user',d);rows.set(id,{recordId:id,revision:String(i+1),envelope:await c.encode(key,'user',id,1,d),tombstone:false});}await f.local.repo.mergeCloud([], [a], 'phone');f.seedRecords(rows);const oldId=await c.id(key,'user',old);
  f.flags({failComplete:true});expect(await f.service.syncNow(true)).toBe(false);expect(f.recordRows.get(oldId).tombstone).toBe(false);f.flags({failComplete:false});expect(f.calls.some(c=>c.url.endsWith('/complete'))).toBe(true);expect(await f.service.syncNow(true)).toBe(true);expect(f.recordRows.get(oldId).tombstone).toBe(true);expect(f.calls.findIndex(r=>r.url.endsWith('/complete'))).toBeLessThan(Math.max(...f.calls.map((r,i)=>r.method==='POST'&&r.url.endsWith('/records')?i:-1)));
 }finally{f.local.sql.close();}
});
test('R35 last private change is published by one trailing ten-minute timer without another mutation or manual sync',async()=>{
 const f=await integration();let now=10;const timers:{at:number;fn:()=>void;cancelled:boolean}[]=[];let scheduler:WatchCloudScheduler;let running:Promise<boolean>|undefined;const settle=async()=>{await running;for(let i=0;i<5;i++)await Promise.resolve();};
 try{await f.local.repo.mergeCloud([], [article({articleId:await cloudCrypto.stableId('https://private.example/first'),url:'https://private.example/first'})], 'phone');scheduler=new WatchCloudScheduler({now:()=>now,sync:(manual,mode)=>running=(async()=>{f.setNow(now);const result=await f.service.syncNow(manual,mode);if(f.service.status.retryAtMillis)scheduler.deferUntil(f.service.status.retryAtMillis);return result;})(),delay:(ms,fn)=>{const t={at:now+ms,fn,cancelled:false};timers.push(t);return()=>{t.cancelled=true;};},scheduleWorker:async()=>{},cancelWorker:async()=>{}},enabled);
  scheduler.foreground(true);await settle();expect(f.reservations.size).toBe(1);await f.local.repo.mergeCloud([], [article({articleId:await cloudCrypto.stableId('https://private.example/last'),url:'https://private.example/last'})], 'phone');scheduler.trigger();now=300010;timers.find(t=>!t.cancelled)!.fn();await settle();expect(f.reservations.size).toBe(1);expect(f.service.status.message).toBe('稍后合并备份');const trailing=timers.at(-1)!;expect(trailing.at).toBe(600010);now=600010;trailing.fn();await settle();expect(f.reservations.size).toBe(2);expect(f.service.status.phase).toBe('complete');scheduler.dispose();
 }finally{f.local.sql.close();}
});
test('R35 records failure does not suppress the trailing backup deadline',async()=>{
 const f=await integration();try{await f.local.repo.mergeCloud([], [article({articleId:await cloudCrypto.stableId('https://private.example/first'),url:'https://private.example/first'})], 'phone');expect(await f.service.syncNow()).toBe(true);await f.local.repo.mergeCloud([], [article({articleId:await cloudCrypto.stableId('https://private.example/second'),url:'https://private.example/second'})], 'phone');f.session.records=async()=>{throw Error('records offline');};expect(await f.service.syncNow()).toBe(false);expect(f.service.status.message).toContain('云记录待重试');expect(f.service.status.message).toContain('稍后合并备份');expect(f.service.status.retryAtMillis).toBe(600010);expect(f.reservations.size).toBe(1);
 }finally{f.local.sql.close();}
});
