import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {db,getLibrarySyncRepository} from '../../src/services.ts';
import {hostArticleBodyCodec,hostSyncText} from '../../src/sync/article-body-host.ts';

const resultKey='manifest-cached-result',expected=5378;
async function run(){
 const count=Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n);
 if(count!==expected)throw new Error(`Expected ${expected} copied articles, found ${count}`);
 const cache=Number((await db.query('SELECT count(*) n FROM article_sync_encoding_cache'))[0]?.n);
 if(cache!==expected)throw new Error(`Expected ${expected} locally encoded bodies, found ${cache}`);
 let queries=0,hashes=0,encodes=0,metadataHashes=0,urlHashes=0,uris=0,transactions=0,transactionStatements=0;
 let queryMs=0,hashMs=0,uriMs=0,transactionMs=0;
 const query=db.query.bind(db),transaction=db.transaction.bind(db),sha=hostArticleBodyCodec.sha256.bind(hostArticleBodyCodec),encode=hostArticleBodyCodec.encode.bind(hostArticleBodyCodec),parseUri=hostSyncText.parseUri.bind(hostSyncText);
 db.query=async(sql,params)=>{queries++;const start=Date.now();try{return await query(sql,params);}finally{queryMs+=Date.now()-start;}};
 db.transaction=async statements=>{transactions++;transactionStatements+=statements.length;const start=Date.now();try{return await transaction(statements);}finally{transactionMs+=Date.now()-start;}};
 hostSyncText.parseUri=async value=>{uris++;const start=Date.now();try{return await parseUri(value);}finally{uriMs+=Date.now()-start;}};
 hostArticleBodyCodec.sha256=async bytes=>{hashes++;const prefix=String.fromCharCode(...bytes.subarray(0,32));if(prefix.startsWith('{"bodyEncodingVersion"'))metadataHashes++;else if(prefix.startsWith('https://')||prefix.startsWith('http://'))urlHashes++;const start=Date.now();try{return await sha(bytes);}finally{hashMs+=Date.now()-start;}};
 hostArticleBodyCodec.encode=async article=>{encodes++;return encode(article);};
 const repository=await getLibrarySyncRepository();
 const metrics=()=>({queries,queryMs,hashes,hashMs,metadataHashes,urlHashes,uris,uriMs,transactions,transactionStatements,transactionMs,encodes});
 const started=Date.now();kv.set(resultKey,{state:'running',stage:'first',started,count,cache});
 const first=(await repository.prepareWindow('cached-fixture-peer',0)).fullArticleManifest;
 const firstMs=Date.now()-started,firstMetrics=metrics();
 if(first.length!==expected||first.some(row=>!row.bodyAvailable))throw new Error('First cached manifest incomplete');
 kv.set(resultKey,{state:'running',stage:'second',firstMs,firstMetrics,articles:first.length});
 await repository.deviceId();
 const secondStart=Date.now(),second=(await repository.prepareWindow('cached-fixture-peer',0)).fullArticleManifest;
 const secondMs=Date.now()-secondStart,totals=metrics();
 if(second.length!==expected||second.some(row=>!row.bodyAvailable))throw new Error('Second cached manifest incomplete');
 const secondMetrics=Object.fromEntries(Object.entries(totals).map(([key,value])=>[key,value-firstMetrics[key as keyof typeof firstMetrics]]));
 kv.set(resultKey,{state:'passed',firstMs,secondMs,firstMetrics,secondMetrics,articles:second.length,sameManifest:JSON.stringify(first)===JSON.stringify(second),firstBodyHash:second[0]?.bodyHash,lastBodyHash:second.at(-1)?.bodyHash});
}
mount(()=><Text>Cached manifest fixture</Text>);
void run().catch(error=>kv.set(resultKey,{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
