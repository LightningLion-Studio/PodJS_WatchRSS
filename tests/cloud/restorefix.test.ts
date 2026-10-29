import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import missing from './fixtures/restorefix-missing-nine.json';
import {crypto,key} from './k2-crypto';
import {CloudRecordCodec,WatchCloudRecords,type RecordPorts,type RecordDocument,type RecordRow} from '../../src/cloud/records';
import {CloudSyncBudget} from '../../src/cloud/execution';
import {dbFixture,article,cloudCrypto} from './library-fixture';
import {rssSourceKey,rssArticleId} from '../../src/cloud/rss-identity';
import {utf8Encode} from '../../src/cloud/types';
const c={...crypto,hmac:async(k:Uint8Array,b:Uint8Array)=>createHmac('sha256',k).update(b).digest('hex')};
const codec=new CloudRecordCodec(c),epoch='restorefix-epoch';
const document=(n:number):RecordDocument=>({kind:'rss-state',value:{sourceId:'source',articleIdHash:n.toString(16).padStart(64,'0'),isRead:true,readingProgress:.5,readingPositionChangedAt:100+n}});
function env(){
 let state=JSON.stringify({epoch,cursor:'0',records:{},rows:{}}),preparation:string|undefined,head=0;
 const server=new Map<string,RecordRow>(),docs:RecordDocument[]=[],metrics:any[]=[];let pushed=0;
 const ports:RecordPorts={userId:'user',epoch,version:1,anchorVersion:1,crypto:c,key:async()=>key.slice(),current:async()=>{},assertUpload:async()=>{},readState:async()=>state,writeState:async v=>{state=v;},checkpoint:async v=>{state=v;},readPreparation:async()=>preparation,writePreparation:async v=>{preparation=v;},export:async()=>docs,apply:async()=>0,hydrate:async()=>{},work:m=>metrics.push(m),
  get:async after=>{const rows=[...server.values()].filter(r=>Number(r.revision)>Number(after)).slice(0,50);return {libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:rows,cursor:rows.at(-1)?.revision??String(head),headRevision:String(head),hasMore:rows.length===50&&Number(rows.at(-1)!.revision)<head};},
  push:async items=>{expect(items.length).toBeLessThanOrEqual(50);expect(new TextEncoder().encode(JSON.stringify({formatVersion:1,items})).length).toBeLessThanOrEqual(1048576);pushed+=items.length;return {formatVersion:1,items:items.map(item=>{expect(item.expectedRevision).toBe(server.get(item.recordId)?.revision??'0');const revision=String(++head);server.set(item.recordId,{recordId:item.recordId,revision,envelope:item.envelope,tombstone:item.tombstone});return {recordId:item.recordId,revision};})};},
 };
 return {ports,docs,metrics,server,headTo:(n:number)=>{head=n;},pushed:()=>pushed,state:()=>JSON.parse(state),preparation:()=>JSON.parse(preparation!),setPreparation:(v:any)=>{preparation=JSON.stringify(v);},seed:(v:any)=>{state=JSON.stringify(v);},records:()=>new WatchCloudRecords(ports)};
}
test('3928 unchanged ACKs resume prepared identity/hash work across a process deadline without repeating completed HMACs',async()=>{
 const f=env(),count=3928,records:any={};for(let n=1;n<=count;n++){const d=document(n);f.docs.push(d);records[await codec.id(key,'user',d)]={revision:'1',hash:await codec.hash(d)};}f.seed({epoch,cursor:'0',records,rows:{}});
 let elapsed=0,hmacs=0,hashes=0,budget=new CloudSyncBudget(()=>elapsed);
 f.ports.crypto={...c,hmac:async(...args)=>{elapsed+=110;hmacs++;return c.hmac(...args);},sha256:async b=>{hashes++;return c.sha256(b);}};f.ports.check=()=>budget.check();f.ports.current=async()=>budget.check();
 let r=f.records();await r.pull();await expect(r.flush()).rejects.toThrow('cloud_sync_deadline_exceeded');
 const prefix=f.preparation().entries.length,firstHmacs=hmacs,firstHashes=hashes;expect(prefix).toBeGreaterThan(2500);expect(prefix).toBeLessThan(count);expect(f.pushed()).toBe(0);
 elapsed=0;budget=new CloudSyncBudget(()=>elapsed);r=f.records();await r.pull();expect(await r.flush()).toBe(0);
 expect(hmacs-firstHmacs).toBe(count-prefix);expect(hashes-firstHashes).toBe(count-prefix);expect(f.preparation().entries).toHaveLength(count);expect(f.pushed()).toBe(0);
 expect(JSON.stringify(f.preparation())).not.toContain('readingProgress');expect(f.metrics.length).toBeLessThan(150);expect(f.metrics.some(m=>m.stage==='identity'&&m.cached&&m.units>=500)).toBe(true);
 console.info('restorefix-resume',JSON.stringify({count,prefix,firstHmacs,secondHmacs:hmacs-firstHmacs,modeledFirstMillis:firstHmacs*110,modeledSecondMillis:(hmacs-firstHmacs)*110}));
},30000);
test('an accepted push checkpoints ACK before the deadline fence, and restart uploads only the remaining tail',async()=>{
 const f=env();for(let n=1;n<=61;n++)f.docs.push(document(n));let expired=false;const push=f.ports.push;
 f.ports.push=async items=>{const response=await push(items);expired=true;return response;};f.ports.current=async()=>{if(expired)throw Error('cloud_sync_deadline_exceeded');};
 const r=f.records();await r.pull();await expect(r.flushInteractions()).rejects.toThrow('cloud_sync_deadline_exceeded');expect(Object.keys(f.state().records)).toHaveLength(50);expect(f.pushed()).toBe(50);
 expired=false;f.ports.push=push;const resumed=f.records();await resumed.pull();expect(await resumed.flushInteractions()).toBe(11);expect(f.pushed()).toBe(61);expect(Object.keys(f.state().records)).toHaveLength(61);
});
test('tampered and differently scoped preparation receipts cannot replace identity or semantic hash',async()=>{
 const f=env();f.docs.push(document(1));let r=f.records();await r.pull();await r.flushInteractions();
 const old=f.preparation(),receipt=old.entries[0][1];receipt.id='f'.repeat(64);f.setPreparation(old);r=f.records();await r.pull();expect(await r.flushInteractions()).toBe(0);expect(f.server.has('f'.repeat(64))).toBe(false);expect(f.preparation().entries[0][1].id).not.toBe('f'.repeat(64));
 f.ports.anchorVersion=2;let calls=0;f.ports.crypto={...c,hmac:async(...args)=>{calls++;return c.hmac(...args);}};r=f.records();await r.pull();await r.flushInteractions();expect(calls).toBeGreaterThan(0);
});
test('nine anonymized nondefault reading tuples materialize from authenticated unsaved legacy metadata through normal replay',async()=>{
 const f=await dbFixture();try{
  const source='https://restorefix.example/rss';const docs:RecordDocument[]=missing.map((m,i)=>({kind:'article',value:{...article({articleId:m.pseudonym.padEnd(64,'0'),url:'https://restorefix.example/'+m.pseudonym,rssSourceUrl:source,independentSaved:false,isRead:true,readingProgress:(i+1)/10,readingPositionChangedAt:1000+i,readingPositionBytes:10+i,readingPositionContentHash:'h-'+i}),contentText:undefined,contentHtml:undefined}}));
  // The input carries no body and no native opaque payload. Replay uses the real
  // codec -> retained cache -> adapter -> SQLite receiver, with no direct repair.
  for(const doc of docs){delete doc.value.contentText;delete doc.value.contentHtml;}
  const e=env();
  for(let i=0;i<docs.length;i++){const doc=docs[i]!,recordId=await codec.id(key,'user',doc);e.server.set(recordId,{recordId,revision:String(i+1),envelope:await codec.encode(key,'user',recordId,1,doc),tombstone:false});}
  // Serve the real head for this externally seeded encrypted retained page.
  e.ports.get=async after=>({libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:after==='0'?[...e.server.values()]:[],cursor:'9',headRevision:'9',hasMore:false});
  await e.records().pull();expect(f.sql.query('SELECT count(*) AS n FROM articles').get()).toEqual({n:0});
  e.ports.apply=d=>f.adapter.applyRecords(d);e.ports.hydrate=d=>f.adapter.hydrateRecords(d);e.ports.reapply=()=>f.adapter.applyReadingStates();
  const restarted=e.records();await restarted.pull();expect(f.sql.query('SELECT count(*) AS n FROM articles').get()).toEqual({n:0});await restarted.reapply();
  expect((await f.repo.cloudReadingCandidates()).filter(a=>a.isRead&&a.readingPositionChangedAt>=1000)).toHaveLength(9);
  for(let i=0;i<docs.length;i++){const a=(await f.repo.cloudReadingCandidates()).find(a=>a.url===docs[i]!.value.url)!;expect(a).toMatchObject({isRead:true,readingProgress:Math.fround((i+1)/10),readingPositionBytes:10+i,readingPositionContentHash:'h-'+i,readingPositionChangedAt:1000+i});}
  expect(f.sql.query('SELECT count(*) AS n FROM article_reading_state WHERE state_json IS NOT NULL').get()).toEqual({n:0});
 }finally{f.sql.close();}
});
test('unmatched hashed state expands its source inventory; a later entry receives its exact tuple, including after hydration',async()=>{
 const f=await dbFixture();try{
  const source='https://restorefix.example/rss',url='https://restorefix.example/older-than-128',sourceId=await rssSourceKey(source,cloudCrypto.sha256),id=await rssArticleId({link:url,guid:'older'},cloudCrypto.sha256),articleIdHash=await cloudCrypto.sha256(utf8Encode(id));
  await f.adapter.hydrateRecords([{kind:'rss-state',value:{sourceId,articleIdHash,isRead:true,readingProgress:.75,readingPositionChangedAt:900,readingPositionBytes:64,readingPositionContentHash:'old-body'}}]);
  expect(await f.adapter.readingInventoryMode(source,'recent128')).toBe('all');expect(await f.adapter.readingInventoryMode('https://other.example/rss','recent128')).toBe('recent128');
  expect(await f.repo.cloudReadingCandidates()).toHaveLength(0);
  await f.adapter.mergeInventory({url:source,title:'Feed',description:'',siteUrl:null,imageUrl:null,items:[{url,guid:'older',title:'Older',excerpt:'',contentHtml:null,contentText:'body',imageUrl:null,contentHash:null}]});
  expect((await f.repo.cloudReadingCandidates())[0]).toMatchObject({isRead:true,readingProgress:.75,readingPositionChangedAt:900,readingPositionBytes:64,readingPositionContentHash:'old-body'});expect(await f.adapter.readingInventoryMode(source,'recent128')).toBe('recent128');
 }finally{f.sql.close();}
});
test('retained-reference audit authenticates original ciphertext without advancing cursor, ACK or SQL',async()=>{
 const {auditRetainedReading}=await import('../../src/cloud/records-audit');
 const f=env(),source='https://restorefix.example/rss',url='https://restorefix.example/target',sourceKey=await rssSourceKey(source,c.sha256),articleId=await rssArticleId(url,c.sha256),articleIdHash=await c.sha256(utf8Encode(articleId));
 const docs:RecordDocument[]=[{kind:'rss-state',value:{sourceId:sourceKey,articleIdHash,isRead:true,readingProgress:.5,readingPositionChangedAt:100}}, {kind:'article',value:{...article({articleId,url,rssSourceUrl:source,isRead:true}),contentHtml:undefined,contentText:undefined}}];
 const rows:any={};for(let i=0;i<docs.length;i++){const d=docs[i]!;delete d.value.contentHtml;delete d.value.contentText;const id=await codec.id(key,'user',d);rows[id]={recordId:id,revision:String(i+1),envelope:await codec.encode(key,'user',id,1,d),tombstone:false};}
 f.seed({epoch,cursor:'2',records:{},rows});const before=JSON.stringify(f.state());
 const targets=[{pseudonym:'fixture',sourceKeys:[sourceKey],articleIds:[articleId],articleHashes:[articleIdHash],urlSha256:await c.sha256(utf8Encode(url))}];
 const result=await auditRetainedReading(f.ports,targets);expect(result).toMatchObject({readOnly:true,cursor:'2',decoded:2,failed:0,completeCoverage:true,cases:[{pseudonym:'fixture',readingRecords:1,metadataRecords:1,nondefaultReadingRecords:2}]});expect(JSON.stringify(f.state())).toBe(before);expect(f.pushed()).toBe(0);expect(JSON.stringify(result)).not.toContain(url);
 f.ports.key=async()=>undefined;await expect(auditRetainedReading(f.ports,targets)).rejects.toThrow('missing_key_version');
});
test('retirement resumes completed no-op evaluations and never certifies a queued unacknowledged tombstone',async()=>{
 const f=env();for(let n=1;n<=61;n++){const d:RecordDocument={kind:'article',value:{articleId:String(n),url:'https://private.example/'+n,updatedAt:1,deleted:false}},id=await codec.id(key,'user',d);f.server.set(id,{recordId:id,revision:String(n),envelope:await codec.encode(key,'user',id,1,d),tombstone:false});}
 f.ports.get=async after=>{const rows=[...f.server.values()].filter(r=>Number(r.revision)>Number(after)).slice(0,50);return {libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:rows,cursor:rows.at(-1)?.revision??'61',headRevision:'61',hasMore:rows.at(-1)?.revision==='50'};};
 let elapsed=0,calls=0,budget=new CloudSyncBudget(()=>elapsed);f.ports.current=async()=>budget.check();f.ports.check=()=>budget.check();f.ports.bookReplacement=async()=>{calls++;elapsed+=6000;return undefined;};
 let r=f.records();await r.pull();await expect(r.flush()).rejects.toThrow('cloud_sync_deadline_exceeded');expect(calls).toBe(50);
 elapsed=0;budget=new CloudSyncBudget(()=>elapsed);r=f.records();await r.pull();expect(await r.flush()).toBe(0);expect(calls).toBe(61);
 const g=env();g.headTo(2);for(let n=1;n<=2;n++){const d:RecordDocument={kind:'article',value:{articleId:'old-'+n,url:'https://feed.example/'+n,rssSourceUrl:'https://feed.example/rss',updatedAt:1,deleted:false}},id=await codec.id(key,'user',d);g.server.set(id,{recordId:id,revision:String(n),envelope:await codec.encode(key,'user',id,1,d),tombstone:false});}
 g.ports.get=async after=>({libraryEpoch:epoch,keyVersionFloor:0,keyCommitments:[],formatVersion:1,items:after==='0'?[...g.server.values()]:[],cursor:'2',headRevision:'2',hasMore:false});
 let expired=false;const encrypt=c.encrypt;g.ports.current=async()=>{if(expired)throw Error('cloud_sync_deadline_exceeded');};r=g.records();await r.pull();g.ports.crypto={...c,encrypt:async(...args)=>{const out=await encrypt(...args);expired=true;return out;}};
 // Replace the already-constructed codec too by restarting after pull.
 r=g.records();await r.pull();await expect(r.flush()).rejects.toThrow('cloud_sync_deadline_exceeded');expect(g.pushed()).toBe(0);
 expired=false;g.ports.crypto=c;r=g.records();await r.pull();expect(await r.flush()).toBe(2);expect([...g.server.values()].every(r=>r.tombstone)).toBe(true);
});
test('production service requests all inventory only when the adapter reports unmatched reading on an unmetered full run',async()=>{
 const {fixture}=await import('./service-fixture');const f=await fixture();let checked=0;
 f.session.library.publicSources=async()=>[{url:'https://feed.example/rss'} as any];f.network.wifi=true;f.network.metered=false;
 f.session.library.readingInventoryMode=async(_source,requested)=>{checked++;expect(requested).toBe('recent128');return 'all';};
 expect(await f.service.syncNow()).toBe(true);expect(checked).toBe(1);expect(f.calls.some(r=>r.url.includes('/entries?limit=all'))).toBe(true);
});
