/** Host-only bounded product-port benchmark. Does not address device budgets. */
import {mkdtempSync,rmSync,writeFileSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeSchema} from '../../src/core/schema';
import {initializeMemoSchema} from '../../src/notes/repository';
import {SqlBusinessSource} from '../../src/sync-v2/source';
import {SqlFixture,binding,noteValue} from './fixture';
const path=mkdtempSync(join(tmpdir(),'wrss-p1-12k-')),database=join(path,'projection.db');let db=new SqlFixture(database,'WAL');
let peak=process.memoryUsage().rss,maxDataPageRows=0;const sample=()=>{peak=Math.max(peak,process.memoryUsage().rss);};
// Discard SQL trace strings: the production port never accumulates a SQL log.
const query=db.query.bind(db),transaction=db.transaction.bind(db);db.query=async(...args)=>{db.sql=[];const result=await query(...args);db.sql=[];if(/SELECT .* FROM memo_notes/.test(args[0]))maxDataPageRows=Math.max(maxDataPageRows,result.length);sample();return result;};db.transaction=async(...args)=>{db.sql=[];await transaction(...args);db.sql=[];sample();};
const count=12500,windows:any[]=[];const started=performance.now();
try{
 await initializeSchema(db);await initializeMemoSchema(db);
 for(let at=0;at<count;at+=64){const statements=[];for(let i=at;i<Math.min(count,at+64);i++){const v=noteValue('n'+String(i).padStart(6,'0'));statements.push({sql:'INSERT INTO memo_notes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',params:[v.noteId,null,v.title,v.markdown,v.plainText,v.contentHash,v.baseContentHash,v.baseMarkdown,0,1,2,'synthetic',0,0]});}await db.transaction(statements);}
 let store=db.store();await store.initialize();await store.beginScan(binding);const source=await SqlBusinessSource.open(db);const baselineCalls=db.calls,baselineMemory=process.memoryUsage().rss;let previous=0;
 while((await store.checkpoint())!.phase==='scan'){
  const begin=performance.now();let pages=0;while(pages<32&&(await store.checkpoint())!.phase==='scan'){await store.scanPage(source,32);pages++;}
  const cp=(await store.checkpoint())!,row=(db.raw.query('SELECT count(*) n,COALESCE(sum(length(body)),0) bytes FROM syncv2_candidates').get() as any);sample();windows.push({window:windows.length+1,durableEntities:row.n,newEntities:row.n-previous,candidateCiphertextBytes:row.bytes,pages,elapsedMillis:Math.round(performance.now()-begin)});previous=row.n;
  // New guest/store objects reconstruct solely from the durable checkpoint.
  store=db.store();if(!(await store.beginScan(binding)).hit)throw Error('checkpoint_miss');
 }
 while((await store.checkpoint())!.phase==='tail')await store.catchUpPage(source,32);
 const tree=db.raw.query('SELECT count(*) nodes,sum(length(body)) bytes FROM syncv2_tree_nodes').get();
 const totals=db.raw.query('SELECT count(*) entities,sum(meta_bytes) metadataBytes,sum(state_bytes) stateBytes,sum(length(body)) encryptedBytes FROM syncv2_candidates').get(),index=db.raw.query('SELECT sum(length(local_library)+length(repo)+length(kind)+length(logical_id)+length(entity_key)+8) indexBytes FROM syncv2_identity_map').get(),cp=await store.checkpoint();
 if((totals as any).entities!==count||cp!.phase!=='complete'||windows.some(w=>w.newEntities===0))throw Error('benchmark_incomplete');
 const result={status:'host-verified-device-unverified',platform:'Bun '+Bun.version+' / '+process.platform+' '+process.arch,entries:count,pageLimit:32,rowsHeldAtOnce:db.maxRows,peakRssBytes:peak,baselineRssBytes:baselineMemory,rssGrowthBytes:peak-baselineMemory,nativeResourceMaxRss:process.resourceUsage().maxRSS,kernelVmHWMKiB:Number(/^VmHWM:\s+(\d+)/m.exec(readFileSync('/proc/self/status','utf8'))?.[1]??0),maxDataPageRows,hostSqlPortCalls:db.calls-baselineCalls,maxTransactionBytes:db.maxTxBytes,totals,index,tree,checkpoint:cp,windows,databaseBytes:statSync(database).size,elapsedMillis:Math.round(performance.now()-started),wireMerkleTree:'not-built-P1-local-candidate-radix-index-only',devicePeakMemory:'unverified',physicalBridgeCalls:'unverified'};
 if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{db.close();rmSync(path,{recursive:true,force:true});}
