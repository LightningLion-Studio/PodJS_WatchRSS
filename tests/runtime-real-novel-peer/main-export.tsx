import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {getLibrarySyncRepository,db} from '../../src/services.ts';
import {hostArticleBodyCodec} from '../../src/sync/article-body-host.ts';
import {buildChunkedResponseFrames} from '../../src/sync/library-wire.ts';

const key='real-novel-export-result', expected=5378;
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function run(){
 const repository=await getLibrarySyncRepository();
 check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===expected,'Unexpected article count');
 const deviceId=await repository.deviceId();
 let encodes=0;const originalEncode=hostArticleBodyCodec.encode.bind(hostArticleBodyCodec);
 hostArticleBodyCodec.encode=async article=>{const result=await originalEncode(article);encodes++;if(encodes%100===0)kv.set(key,{state:'running',stage:'export',encodes});return result;};
 const started=Date.now();kv.set(key,{state:'running',stage:'cursor',started,encodes});
 const cursor=await repository.cursor('real-novel-export-phone'),cursorMs=Date.now()-started;
 kv.set(key,{state:'running',stage:'window',cursorMs,encodes});
 const windowStarted=Date.now(),window=await repository.prepareWindow('real-novel-export-phone',cursor.lastRemoteSeqApplied),windowMs=Date.now()-windowStarted;
 check(window.fullArticleManifest.length===expected,'Unexpected manifest size');
 const requests=window.fullArticleManifest.map(article=>({articleId:article.articleId,bodyHash:'',chunkIndexes:[],metadataOnly:false}));
 kv.set(key,{state:'running',stage:'export',cursorMs,windowMs,encodes});
 const exportStarted=Date.now(),prepared=await repository.exportRequested(requests),exportMs=Date.now()-exportStarted;
 check(prepared.length===expected,'Not all bodies were materialized');
 kv.set(key,{state:'running',stage:'frames',cursorMs,windowMs,exportMs,encodes});
 const frameStarted=Date.now(),frames=buildChunkedResponseFrames(deviceId,prepared,requests,0,0,true,Date.now,(frameStage,frameCount)=>kv.set(key,{state:'running',stage:'frames',frameStage,frameCount,frameElapsedMs:Date.now()-frameStarted,encodes})),frameMs=Date.now()-frameStarted;
 kv.set(key,{state:'passed',articles:prepared.length,frames:frames.length,encodes,cursorMs,windowMs,exportMs,frameMs,totalMs:Date.now()-started});
}
mount(()=><Text>Real novel export timing</Text>);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
