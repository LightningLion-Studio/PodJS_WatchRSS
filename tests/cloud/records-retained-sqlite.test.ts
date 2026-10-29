import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHmac} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CloudRecordCodec,WatchCloudRecords,type RecordDocument,type RecordPorts,type RecordRow} from '../../src/cloud/records';
import {CloudSyncBudget} from '../../src/cloud/execution';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {rssArticleId,rssSourceKey} from '../../src/cloud/rss-identity';
import type {SqlDatabase} from '../../src/core/types';
import {utf8Encode} from '../../src/cloud/types';
import {dbFixture,cloudCrypto} from './library-fixture';
import {crypto,key,enabled} from './k2-crypto';
const c={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')};
const codec=new CloudRecordCodec(c),epoch='retained-sqlite-fixture',source='https://retained.example/rss';

test('real SQLite + atomic cache restart: 2151 legacy retained rows reach a newer head in two five-minute budgets, then zero original replays',async()=>{
 const root=await mkdtemp(join(tmpdir(),'records-retained-')),seed=await dbFixture();let sql:Database|undefined;
 try{
  // Move the actual installed schema to disk, then recreate the repository/adapter
  // and reopen SQLite between attempts as a process restart would do.
  await writeFile(join(root,'library.sqlite'),seed.sql.serialize());seed.sql.close();
  sql=new Database(join(root,'library.sqlite'));sql.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');
  const db:SqlDatabase={query:async(q,p=[])=>sql!.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql!.query(q).run(...p as any[]);},transaction:async ss=>{sql!.transaction(()=>ss.forEach(s=>sql!.query(s.sql).run(...s.params??[] as any)))();},transactionChanges:async ss=>sql!.transaction(()=>ss.map(s=>{sql!.query(s.sql).run(...s.params??[] as any);return (sql!.query('SELECT changes() AS n').get() as any).n;}))()};
  sql.exec("INSERT INTO channels(id,url,title,created_at,sort_order) VALUES(1,'https://retained.example/rss','Feed',1,1)");
  sql.transaction(()=>{const put=sql!.query('INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at) VALUES(?,1,?,\'body\',?,?,?,1)');for(let i=0;i<2150;i++)put.run(i+1,'Item '+i,'https://retained.example/'+i,'g'+i,'g'+i);})();
  const sourceId=await rssSourceKey(source,crypto.sha256),rows:RecordRow[]=[];
  for(let i=0;i<2151;i++){
   const d:RecordDocument={kind:'rss-state',value:{sourceId,articleIdHash:await crypto.sha256(utf8Encode(await rssArticleId({guid:'g'+i},crypto.sha256))),isRead:true,readingProgress:.5,readingPositionBytes:i+1,readingPositionContentHash:'anchor',readingPositionChangedAt:100+i,favoriteSaved:false,favoriteChangedAt:0,watchLaterSaved:false,watchLaterChangedAt:0}};
   const recordId=await codec.id(key,'user',d);rows.push({recordId,revision:String(i+1),tombstone:false,envelope:await codec.encode(key,'user',recordId,1,d)});
  }
  const statePath=join(root,'records.json');const persist=async(value:string)=>{await writeFile(statePath+'.tmp',value);await rename(statePath+'.tmp',statePath);};
  // Model the shipped cache: rows are acknowledged but there is no new projection.
  const acks:Record<string,any>={};for(const row of rows){const d=await codec.decode(key,key,'user',row);acks[row.recordId]={revision:row.revision,hash:await codec.hash(d.doc)};}
  await persist(JSON.stringify({epoch,cursor:'2151',rows:Object.fromEntries(rows.map(r=>[r.recordId,r])),records:acks}));
  const fresh:RecordDocument={kind:'source',value:{url:source,title:'Updated feed',updatedAt:9000,deleted:false}},id=await codec.id(key,'user',fresh);
  const next={recordId:id,revision:'2152',tombstone:false,envelope:await codec.encode(key,'user',id,1,fresh)};
  let elapsed=0,originalDecrypts=0,projectionDecrypts=0,keyReads=0,derivations=0,gets=0,applies=0;
  let adapter!:WatchCloudLibraryAdapter,repository:SqlLibrarySessionRepository,budget:CloudSyncBudget;
  const restart=()=>{elapsed=0;budget=new CloudSyncBudget(()=>elapsed);repository=new SqlLibrarySessionRepository(db,seed.ports);adapter=new WatchCloudLibraryAdapter(repository,'watch',cloudCrypto,enabled);};restart();
  const ports:RecordPorts={userId:'user',epoch,anchorVersion:1,version:1,
   crypto:{...c,hkdf:async(...args)=>{derivations++;elapsed+=300;return c.hkdf(...args);},decrypt:async(k,a,n,b)=>{if(new TextDecoder().decode(a).startsWith('watchrss-cloud-record-v1:')){originalDecrypts++;elapsed+=150;}else{projectionDecrypts++;elapsed+=4;}return c.decrypt(k,a,n,b);}},
   key:async()=>{keyReads++;elapsed+=800;return key.slice();},current:async()=>budget.check(),assertUpload:async()=>{},
   readState:async()=>readFile(statePath,'utf8'),writeState:persist,checkpoint:persist,
   get:async after=>{gets++;expect(after).toBe('2151');return {libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:[next],cursor:'2152',headRevision:'2152',hasMore:false};},
   push:async()=>{throw Error('not an upload test');},hydrate:docs=>adapter.hydrateRecords(docs),reapply:()=>adapter.applyReadingStates(),apply:async docs=>{applies++;return adapter.applyRecords(docs);},export:()=>adapter.exportRecords(),
  };
  await expect(new WatchCloudRecords(ports).pull()).rejects.toThrow('cloud_sync_deadline_exceeded');expect(gets).toBe(0);expect(applies).toBe(0);
  const saved=JSON.parse(await readFile(statePath,'utf8'));expect(saved.cursor).toBe('2151');expect(saved.projections.length).toBeGreaterThan(30);expect(saved.projections.length).toBeLessThan(44);
  const completedIds=new Set(saved.projections.flatMap((g:any)=>g.ids)),firstAttemptDecrypts=originalDecrypts;
  sql.close();sql=new Database(join(root,'library.sqlite'));sql.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');restart();
  const records=new WatchCloudRecords(ports);await records.pull();expect(gets).toBe(1);expect(JSON.parse(await readFile(statePath,'utf8')).cursor).toBe('2152');
  // Only the interrupted tail is decoded again. Completed original rows do not
  // consume the second run, so the five-minute deadline remains unchanged.
  expect(originalDecrypts-firstAttemptDecrypts).toBe(2151-completedIds.size+1);expect(keyReads).toBe(2);expect(derivations).toBeLessThanOrEqual(8);
  expect((sql.query('SELECT COUNT(*) AS n FROM article_reading_state WHERE progress=.5 AND changed_at>=100').get() as any).n).toBe(2150);
  expect((sql.query('SELECT COUNT(*) AS n FROM articles WHERE is_read=1').get() as any).n).toBe(2150);
  expect(projectionDecrypts).toBeGreaterThan(30);
  // A public entry that did not exist at ACK time must still recover its state
  // from the hydrated pending map, including after a complete process restart.
  sql.close();sql=new Database(join(root,'library.sqlite'));restart();const before={originalDecrypts,applies};
  ports.get=async after=>({libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:[],cursor:after,headRevision:after,hasMore:false});
  const warm=new WatchCloudRecords(ports);await warm.pull();expect(originalDecrypts).toBe(before.originalDecrypts);expect(applies).toBe(before.applies);
  await adapter.mergeInventory({url:source,title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[{url:'https://retained.example/2150',guid:'g2150',title:'Late entry',excerpt:'',contentHtml:null,contentText:'late body',imageUrl:null,contentHash:null}]});
  await warm.reapply();expect((sql.query("SELECT progress,changed_at,position_bytes FROM article_reading_state JOIN articles ON articles.id=article_reading_state.article_id WHERE link='https://retained.example/2150'").get() as any)).toEqual({progress:.5,changed_at:2250,position_bytes:2151});
  expect(await readFile(statePath,'utf8')).not.toContain('Late entry');
  console.info('retained-sqlite-evidence',JSON.stringify({retained:2151,head:'2152',completedBeforeDeadline:completedIds.size,firstAttemptDecrypts,secondAttemptOriginals:2151-completedIds.size+1,keyReads,derivations,projectionDecrypts,thirdAttemptOriginals:originalDecrypts-before.originalDecrypts,thirdAttemptApplies:applies-before.applies}));
 }finally{sql?.close();try{seed.sql.close();}catch{}await rm(root,{recursive:true,force:true});}
},120000);
