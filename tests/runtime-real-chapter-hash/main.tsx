import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {db,getLibrarySyncRepository} from '../../src/services.ts';
import {hostArticleBodyCodec,hostSyncText} from '../../src/sync/article-body-host.ts';
import {stableArticleId} from '../../src/sync/local-manifest.ts';
import {querySyncPages} from '../../src/sync/sql-pages.ts';

const resultKey='real-chapter-hash-result';
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function run(){
 const repository=await getLibrarySyncRepository();
 const rows=await querySyncPages(db,`SELECT a.id,a.link,n.body_hash AS native_hash FROM articles a
  JOIN article_native_sync_hash n ON n.item_id=a.id ORDER BY a.id`);
 check(rows.length===5378,'Real chapter fixture does not contain the full imported library');
 check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===rows.length,'Unexpected fixture article count');
 let encodes=0;const encode=hostArticleBodyCodec.encode.bind(hostArticleBodyCodec);
 hostArticleBodyCodec.encode=async article=>{
  const result=await encode(article);encodes++;
  if(encodes%200===0)kv.set(resultKey,{state:'running',stage:'first',encodes,articles:rows.length});
  return result;
 };
 kv.set(resultKey,{state:'running',stage:'first',encodes:0,articles:rows.length});
 const firstStart=Date.now(),first=(await repository.prepareWindow('real-chapter-peer',0)).fullArticleManifest,firstMs=Date.now()-firstStart;
 check(first.length===rows.length&&first.every(item=>item.bodyAvailable),'Real chapters were not exported');
 const firstEncodes=encodes,byId=new Map(first.map(item=>[item.articleId,item]));
 let nativeMismatches=0,contentMismatches=0,unavailable=0;
 const mismatches:{itemId:number;nativeMatchesEncoded:boolean;nativeMatchesContent:boolean;bodyAvailable:boolean}[]=[];
 for(const row of rows){
  const id=await stableArticleId(String(row.link),hostSyncText.parseUri,hostArticleBodyCodec),manifest=byId.get(id);
  check(manifest,'Real chapter manifest identity is missing');
  const nativeMatchesEncoded=String(row.native_hash)===manifest.bodyHash,
   nativeMatchesContent=String(row.native_hash)===manifest.contentHash;
  if(!nativeMatchesEncoded)nativeMismatches++;
  if(!nativeMatchesContent)contentMismatches++;
  if(!manifest.bodyAvailable)unavailable++;
  if(!nativeMatchesEncoded||!nativeMatchesContent||!manifest.bodyAvailable){
   if(mismatches.length<10)mismatches.push({itemId:Number(row.id),nativeMatchesEncoded,nativeMatchesContent,bodyAvailable:manifest.bodyAvailable});
  }
 }
 kv.set(resultKey,{state:'running',stage:'second',encodes,articles:rows.length,nativeMismatches,contentMismatches,unavailable});
 const cacheCount=Number((await db.query('SELECT count(*) n FROM article_sync_content'))[0]?.n);
 await repository.deviceId();
 const secondStart=Date.now(),second=(await repository.prepareWindow('real-chapter-peer',0)).fullArticleManifest,secondMs=Date.now()-secondStart;
 kv.set(resultKey,{state:'measured',articles:rows.length,firstMs,secondMs,firstEncodes,secondEncodes:encodes-firstEncodes,
  nativeMismatches,contentMismatches,unavailable,mismatches,cacheCount,manifestStable:JSON.stringify(first)===JSON.stringify(second)});
}
mount(()=><Text>Real chapter hash fixture</Text>);
void run().catch(error=>kv.set(resultKey,{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
