/** Host SQLite + synthetic HTTP, never a device/production latency claim. */
import {p5Fixture} from './p5-fixture';
const count=Number(process.argv[2]??1000),f=await p5Fixture(),samples:number[]=[];
try{await f.publish();for(let i=0;i<count;i++){const start=performance.now();await f.edit('event '+i);await f.publish();samples.push(performance.now()-start);f.db.sql.length=0;if((i+1)%100===0)process.stderr.write('events '+(i+1)+'\n');}
 const sorted=[...samples].sort((a,b)=>a-b),at=(p:number)=>sorted[Math.ceil(p*sorted.length)-1];
 console.log(JSON.stringify({environment:'host SQLite and synthetic HTTP',count:samples.length,p50Millis:at(.5),p95Millis:at(.95),p99Millis:at(.99),maxMillis:sorted.at(-1),maxSqlBatchBytes:f.db.maxTxBytes,maxQueryRows:f.db.maxRows,totalSqlCalls:f.db.calls,maxRssKiB:process.resourceUsage().maxRSS},null,2));
}finally{f.close();}
