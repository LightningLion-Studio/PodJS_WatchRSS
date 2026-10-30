/** Offline SQLite integration replay. Synthetic data only. Latencies are a
 * declared host-call model, not predicted watch completion times. */
import {createHmac} from 'node:crypto';
import {mkdirSync,symlinkSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {metadataFixture} from '../../tests/cloud/metadata-fixture';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {cloudCrypto} from '../../tests/cloud/library-fixture';
import {enabled,crypto,key} from '../../tests/cloud/k2-crypto';
import {CloudRecordCodec,type RecordDocument} from '../../src/cloud/records';
import {rssArticleId,rssSourceKey} from '../../src/cloud/rss-identity';
import {SnapshotRestoreCheckpoint} from '../../src/cloud/snapshot-checkpoint';
import {utf8Encode} from '../../src/cloud/types';
const root=resolve('.codex-tmp/restorefix-metadata'),base='180703f8ffffa1d2947f61e1fdb9ee9f3d44630b';mkdirSync(root,{recursive:true});
async function baseline(){const dir=join(root,'before');for(const path of await Array.fromAsync(new Bun.Glob('**/*.ts').scan('src'))){const dest=join(dir,'src',path);mkdirSync(dirname(dest),{recursive:true});const tracked=Bun.spawnSync(['git','show',base+':src/'+path]);if(tracked.exitCode===0)writeFileSync(dest,tracked.stdout);else if(!existsSync(dest))symlinkSync(resolve('src',path),dest);}const nm=join(dir,'node_modules');if(!existsSync(nm))symlinkSync(resolve('node_modules'),nm,'dir');return {Repository:(await import(join(dir,'src/sync/library-repository.ts'))).SqlLibrarySessionRepository,Adapter:(await import(join(dir,'src/cloud/library.ts'))).WatchCloudLibraryAdapter};}
const old=await baseline(),cost={query:55,execute:20,transaction:100,gzip:300,uri:1,checkpoint:20,startup:73432,hash:0},output:any={base,fixture:{articles:6530,privateOriginals:3351,retained:3351,projections:2654,encoded:3063,fingerprints:5342,peerEcho:508,existingUnits:392,existingWork:813},model:{source:'1176 measured state-read35455+validate496+pull37481ms; remaining costs are fixed sensitivity assumptions. Real SQLite, gzip, SHA, AES-GCM, fresh repository and adapter every window. No wall-clock waiting.',cost,soft:290000,hard:300000},before:[],after:[]};
// Real authenticated retained rows. The set includes canonical, URL and legacy
// aliases, as older retained records do; source metadata is one of the rows.
const recordCodec=new CloudRecordCodec({...crypto,hmac:async(k,b)=>createHmac('sha256',k).update(b).digest('hex')}),sourceId=await rssSourceKey('https://feed.invalid/rss',crypto.sha256),documents:RecordDocument[]=[{kind:'source',value:{url:'https://feed.invalid/rss',sourceId,sourceDeviceId:'phone',title:'Feed',updatedAt:1,deleted:false,deletedAt:0}}];
for(let n=3352;n<=6530;n++){const id=await rssArticleId({guid:'guid-'+n},crypto.sha256);documents.push({kind:'rss-state',value:{sourceId,articleIdHash:await crypto.sha256(utf8Encode(id)),isRead:true,readingProgress:.75,readingPositionChangedAt:20000+n,sourceDeviceId:'phone'}});}
for(let n=3352;documents.length<3351;n++)documents.push({kind:'rss-state',value:{sourceId,articleIdHash:await crypto.sha256(utf8Encode(await rssArticleId('https://scale.invalid/'+n,crypto.sha256))),isRead:true,readingProgress:.5,readingPositionChangedAt:10000+n,sourceDeviceId:'phone'}});
const retained=[];for(const d of documents){const id=await recordCodec.id(key,'offline',d);retained.push({id,envelope:await recordCodec.encode(key,'offline',id,1,d)});}
for(const mode of ['before','after'] as const){const f=await metadataFixture(),units=new Map<string,number>(),merged=new Map<string,number>();let phase='originals',recordAt=0,done=false,secureBytes=0,secureWall=0;
 f.sql.exec('CREATE TABLE offline_secure(k TEXT PRIMARY KEY,v TEXT NOT NULL)');const state={restoreJournal:async(shard?:number)=>(f.sql.query('SELECT v FROM offline_secure WHERE k=?').get(String(shard)) as any)?.v,storeRestoreJournal:async(v:string,shard?:number)=>{const at=performance.now();f.sql.query('INSERT OR REPLACE INTO offline_secure VALUES(?,?)').run(String(shard),v);secureWall=Math.max(secureWall,performance.now()-at);secureBytes=Math.max(secureBytes,Buffer.byteLength(v));}},session:any={state,userId:'offline',deviceId:'watch',cache:{scope:async()=> 'offline-scope'},keys:{currentKeyVersion:async()=>1,accountKey:async()=>key.slice()},codec:{clearRestoreProjectionKey:()=>{}}};
 const initial=await new SnapshotRestoreCheckpoint(session,crypto.sha256,async()=>{},()=>0).open('epoch','generation');for(let n=0;n<392;n++)await initial.commit('old:'+n);initial.close();const header=JSON.parse((await state.restoreJournal())!);header.work=813;header.active=true;header.cycle=7;await state.storeRestoreJournal(JSON.stringify(header));
 // A definition mismatch is legitimate once. Do not manufacture a mismatch on
 // every restart: repeated work must be demonstrated with the persisted DB.
 f.sql.exec("UPDATE sync_fast_definitions SET definition='old-host-definition' WHERE domain='library'");
 try{for(let round=1;round<=(mode==='before'?3:100)&&!done;round++){
  let elapsed=cost.startup,cleanup=0,active=true,failed='',exports=0;const start=performance.now(),startRows=merged.size,counts:Record<string,number>={},stages:any[]=[],cleared:string[]=[],stageStarts=new Map<string,{clock:number;wall:number}>(),stageSummary:Record<string,any>={};
  const stage=(e:any)=>{const k=e.stage+':'+(e.domain??'');if(e.outcome==='started')stageStarts.set(k,{clock:elapsed,wall:performance.now()});else{const at=stageStarts.get(k);if(at){const v=stageSummary[k]??={calls:0,totalModelMillis:0,maxModelMillis:0,totalWallMillis:0};v.calls++;v.totalModelMillis+=elapsed-at.clock;v.maxModelMillis=Math.max(v.maxModelMillis,elapsed-at.clock);v.totalWallMillis+=performance.now()-at.wall;}}stages.push({...e,at:elapsed});};
  const tick=(name:string,ms:number)=>{if(!active)return;counts[name]=(counts[name]??0)+1;elapsed+=ms;if(elapsed>300000)throw Error('native_hard_deadline');};
  const check=()=>{if(elapsed>=290000)throw Error('cloud_sync_deadline_exceeded');};
  const inspect=(q:string)=>{const m=/^DELETE FROM (sync_projection_rows|sync_projection_header|sync_fast_encoded_cache|sync_snapshot_fingerprints|sync_peer_echo)(?:\s|$)/.exec(q);if(m)cleared.push(m[1]);};
  const db={query:async(q:string,p:any=[])=>{tick('query',cost.query);return f.db.query(q,p);},execute:async(q:string,p:any=[])=>{tick('execute',cost.execute);inspect(q);return f.db.execute(q,p);},transaction:async(ss:any[])=>{tick('transaction',cost.transaction);ss.forEach(s=>inspect(s.sql));return f.db.transaction(ss);},transactionChanges:async(ss:any[])=>{tick('transaction',cost.transaction);ss.forEach(s=>inspect(s.sql));return f.db.transactionChanges!(ss);}};
  const ports={...f.ports,diagnostic:(e:any)=>{if(e.event==='library-work')stage(e);},text:{...f.ports.text,parseUri:async(v:string)=>{tick('uri',cost.uri);return f.ports.text.parseUri(v);}},codec:{...f.ports.codec,encode:async(v:any)=>{tick('gzip',cost.gzip);return f.ports.codec.encode(v);}}};
  const journal=await new SnapshotRestoreCheckpoint(session,crypto.sha256,async()=>check(),()=>elapsed).open('epoch','generation');units.clear();for(const [u,n]of Object.entries((journal as any).value.units))units.set(u,n as number);recordAt=0;while(units.has('retained:'+recordAt))recordAt+=units.get('retained:'+recordAt)!;phase=units.has('offline:originals-complete')?(recordAt===retained.length?'export':'retained'):'originals';const startUnits=units.size,startRecord=recordAt;
  const repo:any=new (mode==='before'?old.Repository:SqlLibrarySessionRepository)(db,ports),merge=repo.mergeCloud.bind(repo);repo.mergeCloud=async(s:any[],a:any[],...rest:any[])=>{const result=await merge(s,a,...rest);for(const v of a)if(v.contentText||v.contentHtml)merged.set(v.articleId,(merged.get(v.articleId)??0)+1);return result;};
  const adapter:any=new (mode==='before'?old.Adapter:WatchCloudLibraryAdapter)(repo,'watch',cloudCrypto,{require:check});
  const commit=async(u:string,n=0)=>{const at=elapsed;tick('checkpoint',cost.checkpoint);await journal.commit(u,n);units.set(u,n);cleanup=Math.max(cleanup,elapsed-at);};
  if(mode==='after')adapter.trackProgress((u:string)=>commit('library:'+u));
  // Baseline stages are measured around the original implementation, without
  // changing its behavior. Production after stages use the new closed sink.
  const stageEvent=stage;
  if(mode==='before'){for(const [obj,name,stage]of [[repo,'cloudSnapshot','cloudSnapshot'],[repo,'legacySnapshot','legacySnapshot'],[repo,'prepareFastProjection','prepareFastProjection'],[repo.local,'snapshot','localSnapshot'],[repo.definitions,'ensure','definitions']] as any[]){if(!obj?.[name])continue;const original=obj[name].bind(obj);obj[name]=async(...args:any[])=>{const at=elapsed;stageEvent({stage,outcome:'started',at});try{return await original(...args);}finally{stageEvent({stage,outcome:'end',durationMillis:elapsed-at,at:elapsed});}};}}
  try{
   if(phase==='originals'){await adapter.publicSources();await adapter.restorePayloads(new Map([['private-library.wrss',f.archive]]),'phone',[],{skipReading:true,checkpoint:{has:(u:string)=>units.has(u),result:(u:string)=>units.get(u)??0,check:async()=>check(),commit}});await commit('offline:originals-complete');phase='retained';}
   if(phase==='retained'){while(recordAt<retained.length){check();const d=[];for(const r of retained.slice(recordAt,recordAt+20))d.push((await recordCodec.decode(key,key,'offline',{recordId:r.id,revision:'1',envelope:r.envelope,tombstone:false})).doc);await adapter.applyRecords(d);await commit('retained:'+recordAt,d.length);recordAt+=d.length;}phase='export';}
   if(phase==='export'){const docs=await adapter.exportRecords();exports=docs.length;await commit('final-export');await journal.finish();phase='complete';done=true;}
  }catch(e){failed=String(e);if(!failed.includes('cloud_sync_deadline_exceeded')&&!(mode==='before'&&failed.includes('native_hard_deadline')))throw e;}
  active=false;journal.close();const result={round,phase,millis:elapsed,wallMillis:Math.round(performance.now()-start),newUnits:units.size-startUnits,newOriginals:merged.size-startRows,newRetained:recordAt-startRecord,totalOriginals:merged.size,totalRetained:recordAt,totalUnits:units.size,exports,counts,cleared,stageSummary,checkpointMaxMillis:cleanup,status:done?'complete':failed,stages:stages.filter(e=>e.stage!=='cloudMetadata').slice(-40),cacheCounts:f.cacheCounts()};output[mode].push(result);
  if(mode==='after'&&result.newUnits<=0)throw Error('window_without_progress:'+JSON.stringify(result));if(mode==='after'&&(elapsed>=300000||cleanup>=10000))throw Error('deadline_or_cleanup_budget');
  writeFileSync(join(root,'scale-result.json'),JSON.stringify(output,null,2));console.log(JSON.stringify({mode,...result,stages:undefined,stageSummary:undefined,cacheCounts:undefined}));
 }
 if(mode==='after'){if(!done||merged.size!==3351||recordAt!==3351)throw Error('did_not_converge');if([...merged.values()].some(n=>n!==1))throw Error('committed_original_replayed');const ready=(f.sql.query('SELECT COUNT(*) n FROM cloud_article_state WHERE body_ready=1').get() as any).n;if(ready!==3351)throw Error('normal_body_restore_incomplete:'+ready);output.afterFinal={bodyReady:ready,cacheCounts:f.cacheCounts(),checkpointRows:units.size,maxSecureWriteBytes:secureBytes,maxSecureWriteWallMillis:secureWall};}
 }finally{f.sql.close();}
}
writeFileSync(join(root,'scale-result.json'),JSON.stringify(output,null,2));console.log('SCALE_PASS');
