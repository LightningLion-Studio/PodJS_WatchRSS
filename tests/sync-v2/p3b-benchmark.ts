/** Synthetic metadata-only scan; kernel RSS includes Bun and imported modules. */
import {readFileSync,writeFileSync} from 'node:fs';
import {fixture,body,item} from './p3b-fixture';
const f=await fixture(),count=2048;
try{
 for(let n=0;n<count;n++){const id=n.toString(16).padStart(64,'0');await f.cache.add({...body(id),item:{...item(id),dirty:true}},[]);}
 await f.cache.setAutoEvict(true);const windows=[];
 for(let i=0;i<3;i++){const start=performance.now(),reads=f.host.readBytes,calls=f.db.calls,queries=f.db.sql.length,result=await f.space.runWindow(1,1000),scanQueries=f.db.sql.slice(queries).filter(sql=>sql.startsWith('SELECT id,revision,sort_key,value FROM podjs_resource_rows')).length;windows.push({result,elapsedMillis:performance.now()-start,sqlBridgeCalls:f.db.calls-calls,scanBatchQueries:scanQueries,bodyReadBytes:f.host.readBytes-reads,maxRows:f.db.maxRows,peakProcessRssKiB:Number(/^VmHWM:\s+(\d+)/m.exec(readFileSync('/proc/self/status','utf8'))![1])});}
 const result={syntheticOnly:true,items:count,metadataBatchLimit:32,perItemQueryBaseline:count,windows,scope:'Bun/Linux metadata scanning; not physical watch acceptance'};if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');else process.stdout.write(JSON.stringify(result,null,2)+'\n');
}finally{f.close();}
