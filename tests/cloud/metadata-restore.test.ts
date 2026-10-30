import {test,expect} from 'bun:test';
import {metadataFixture,cacheTables} from './metadata-fixture';
import {dbFixture,article,cloudCrypto} from './library-fixture';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {backgroundDiagnostics} from '../../src/cloud/background-diagnostic';
import {enabled} from './k2-crypto';
import {LocalArticleManifestStore} from '../../src/sync/local-manifest';

test('1176 scale metadata reads and first original checkpoint preserve stale projection/fingerprint caches without body preparation',async()=>{
 const f=await metadataFixture();try{
  f.sql.exec("UPDATE sync_fast_definitions SET definition='stale-native-definition' WHERE domain='library'");const before=f.cacheCounts(),state=f.sql.query('SELECT * FROM cloud_article_state WHERE article_id=?').get(f.ids[0]);
  let encodes=0;const events:any[]=[];const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,diagnostic:e=>events.push(e),codec:{...f.ports.codec,encode:async body=>{encodes++;return f.ports.codec.encode(body);}}});
  repo.cloudSnapshot=async()=>{throw Error('full snapshot forbidden for restore metadata');};const adapter=new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,enabled);
  expect((await adapter.publicSources()).map(s=>s.url)).toEqual(['https://feed.invalid/rss']);
  await adapter.mergeInventory({url:'https://feed.invalid/rss',sourceId:'pool-source',title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[]});
  const page=await repo.cloudRestoreMetadata({ids:[f.ids[0]],limit:1});expect(page.articles[0]).toMatchObject({contentHash:'logical-1',contentText:'',contentHtml:null});expect(encodes).toBe(0);expect(f.sql.query('SELECT * FROM cloud_article_state WHERE article_id=?').get(f.ids[0])).toEqual(state);
  const units=new Map<string,number>();let stopped=false;const checkpoint={has:(u:string)=>units.has(u),result:(u:string)=>units.get(u)??0,check:async()=>{if(stopped)throw Error('cloud_sync_deadline_exceeded');},commit:async(u:string,n=0)=>{units.set(u,n);if(u.includes(':row:'))stopped=true;}};
  await expect(adapter.restorePayloads(new Map([['private-library.wrss',f.archive]]),'phone',[],{checkpoint})).rejects.toThrow('cloud_sync_deadline_exceeded');
  expect([...units].some(([u])=>u.endsWith(':row:0'))).toBe(true);expect(encodes).toBeLessThanOrEqual(2);expect(f.cacheCounts()).toEqual(before);expect((f.sql.query('SELECT body_ready FROM cloud_article_state WHERE article_id=?').get(f.ids[1]) as any).body_ready).toBe(0);
  expect(events.some(e=>e.stage==='cloudMetadata')).toBe(true);expect(events.some(e=>['legacySnapshot','prepareFastProjection','definitions-invalidate','localSnapshot'].includes(String(e.stage)))).toBe(false);
 }finally{f.sql.close();}
},30000);

test('verified legacy encoding and URI preparation survives fresh repositories and never forges body-ready or an old witness',async()=>{
 const f=await metadataFixture(60,60);try{
  // A real definition change may invalidate derived data once. Subsequent
  // bounded windows must reuse accepted cache work instead of encoding it again.
  f.sql.exec("DELETE FROM sync_fast_encoded_cache;DELETE FROM sync_projection_header;DELETE FROM sync_projection_rows;DELETE FROM article_sync_content WHERE item_id>20");let encodes=0,uri=0,stop=false;const completed=new Set<string>();
  const ports={...f.ports,text:{...f.ports.text,parseUri:async(value:string)=>{uri++;return f.ports.text.parseUri(value);}},codec:{...f.ports.codec,encode:async(body:any)=>{encodes++;if(stop)throw Error('cloud_sync_deadline_exceeded');return f.ports.codec.encode(body);}}};
  let done=false;for(let round=0;round<10&&!done;round++){stop=false;let accepted=0;const repo=new SqlLibrarySessionRepository(f.db,ports);repo.setCloudProgress(async unit=>{completed.add(unit);if(unit.startsWith('body:')&&++accepted===10)stop=true;});
   try{await repo.cloudSnapshot(false,()=>{if(stop)throw Error('cloud_sync_deadline_exceeded');});done=true;}catch(e){expect(String(e)).toContain('cloud_sync_deadline_exceeded');}expect(accepted>0||done).toBe(true);
  }
  expect(done).toBe(true);expect(encodes).toBeLessThanOrEqual(65);expect(uri).toBeLessThanOrEqual(60);expect(completed.size).toBeGreaterThanOrEqual(60);expect(f.sql.query('SELECT COUNT(*) n FROM cloud_article_state WHERE body_ready<>0').get()).toEqual({n:0});
 }finally{f.sql.close();}
});

test('body-derived opaque RSS identities refresh after edits without compressing the library',async()=>{
 const f=await dbFixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://feed.invalid/rss','Feed',1,1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,dedup_key,fetched_at) VALUES(1,1,'Opaque','body-one','urn:offline','opaque-key',1)");
  let encodes=0;const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,codec:{...f.ports.codec,encode:async b=>{encodes++;return f.ports.codec.encode(b);}}}),first=await repo.cloudReadingCandidates();expect(first).toHaveLength(1);
  await f.db.execute("UPDATE articles SET content='body-two' WHERE id=1");const second=await repo.cloudReadingCandidates();expect(second).toHaveLength(1);expect(second[0].articleId).not.toBe(first[0].articleId);expect(encodes).toBe(0);
 }finally{f.sql.close();}
});

test('library work events use closed stages and strip arbitrary schema, SQL, URL and definition text',async()=>{
 const lines:string[]=[];const sink=backgroundDiagnostics(async(_m,a)=>{lines.push(String(a.text));return {} as any;});
 sink.report(JSON.stringify({event:'library-work',stage:'definitions-invalidate',domain:'library',outcome:'complete',durationMillis:2,definitionChanged:1,sql:'SELECT private',url:'https://private.invalid',definition:'secret'}));await sink.flush();const output=lines.join('');expect(output).toContain('definitions-invalidate');expect(output).toContain('"definitionChanged":1');expect(output).not.toMatch(/private|secret|SELECT/);
});

test('bounded diagnostic bursts retain library timing and definition reasons through the final headless append',async()=>{
 let release!:()=>void,calls=0;const gate=new Promise<void>(r=>release=r),lines:string[]=[],sink=backgroundDiagnostics(async(_m,a)=>{calls++;lines.push(String(a.text));expect(String(a.text).length).toBeLessThan(7000);if(calls===1)await gate;return {} as any;});
 sink.report(JSON.stringify({event:'records-stage',stage:'open',outcome:'complete'}));
 sink.report(JSON.stringify({event:'library-work',stage:'cloudMetadata',outcome:'complete',durationMillis:123}));
 sink.report(JSON.stringify({event:'library-work',stage:'definitions-invalidate',domain:'library',outcome:'started',definitionChanged:1,ownedTriggersChanged:0}));
 sink.report(JSON.stringify({event:'library-work',stage:'definitions-invalidate',domain:'library',outcome:'complete',durationMillis:45}));
 for(let n=0;n<10000;n++)sink.report(JSON.stringify({event:'records-work',stage:'hash',units:n,outcome:'complete'}));
 release();await sink.flush();const log=lines.join('');expect(calls).toBe(2);expect(log).toContain('"stage":"cloudMetadata"');expect(log).toContain('"durationMillis":123');expect(log).toContain('"definitionChanged":1');expect(log).toContain('"ownedTriggersChanged":0');expect(log).toContain('"units":9999');
});

test('incremental body publication rejects a concurrent source edit and preserves the old cloud witness',async()=>{
 const f=await metadataFixture(1,1);try{
  f.sql.exec('DELETE FROM article_sync_content;DELETE FROM sync_fast_encoded_cache');const witness=f.sql.query('SELECT * FROM cloud_article_state').get(),units:string[]=[];
  const codec={...f.ports.codec,encode:async(body:any)=>{const bytes=await f.ports.codec.encode(body);await f.db.execute("UPDATE articles SET content='changed' WHERE id=1");return bytes;}};
  const local=new LocalArticleManifestStore(f.db,codec,f.ports.text,f.ports.files,f.ports.migrateReading,undefined,undefined,undefined,async u=>{units.push(u);});local.setEncodingGeneration(f.generation);
  await expect(local.snapshot(true,false)).rejects.toThrow('NOT NULL constraint failed');
  expect(f.sql.query('SELECT COUNT(*) n FROM article_sync_content').get()).toEqual({n:0});expect(units.some(u=>u.startsWith('body:'))).toBe(false);expect(f.sql.query('SELECT * FROM cloud_article_state').get()).toEqual(witness);
  const repo=new SqlLibrarySessionRepository(f.db,f.ports);repo.setCloudProgress(async()=>{});await repo.cloudSnapshot(false);expect(f.sql.query('SELECT content_text FROM article_sync_content WHERE item_id=1').get()).toEqual({content_text:'changed'});expect(f.sql.query('SELECT * FROM cloud_article_state').get()).toEqual(witness);
 }finally{f.sql.close();}
});
