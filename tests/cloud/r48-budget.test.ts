import {test,expect} from 'bun:test';
import {WatchCloudClient} from '../../src/cloud/client';
import type {EncryptedCloudSnapshot} from '../../src/cloud/types';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {WatchCloudCodec} from '../../src/cloud/codec';
import {utf8Encode,utf8Decode} from '../../src/cloud/types';
import {PRIVATE_OVERLAY_NAME,decodePrivateOverlay} from '../../src/cloud/private-overlay';
import {article,cloudCrypto} from './library-fixture';
import {crypto,enabled,key} from './k2-crypto';
import recipe from './fixtures/r48-write-v1/budget-recipe.json';
import {bookPackageLines} from '../../src/books/package';
import {chapterHash,bookFingerprint,bookId} from '../../src/books/protocol';

test('WriteV1 2000 articles + 120-chapter book: production byte/request budget and cold retry',async()=>{
 const body=recipe.recipe.bodyUtf8.repeat(recipe.recipe.bodyRepeats),rows=[];
 for(let i=0;i<recipe.recipe.articles;i++)rows.push(article({articleId:'writev1-fixture-'+i,url:'https://fixture.invalid/'+i,title:'Article '+i,contentText:body,contentHtml:'<p>'+body+'</p>',contentHash:await crypto.sha256(utf8Encode(body))}));
 const chapters=Array.from({length:recipe.recipe.chapters},(_,i)=>({chapterIndex:i+1,title:'Chapter '+(i+1),contentText:recipe.recipe.chapterTextUtf8,contentHtml:null,url:'https://watchrss.local/import-txt-novel/r48/chapter/'+(i+1)}));
 const fingerprint=await bookFingerprint(await Promise.all(chapters.map(c=>chapterHash(c.chapterIndex,c.title,c.contentText,crypto.sha256))),crypto.sha256),id=await bookId(fingerprint,crypto.sha256),book={bookId:id,fingerprint,title:'Book',chapterCount:chapters.length,deletedChapters:[],deletionClock:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'watch',sourceUrl:'https://watchrss.local/import-txt-novel/r48',kind:'txt' as const};
 let stream='';for await(const line of bookPackageLines({format:'watchrss-book',version:1,title:book.title,chapterCount:chapters.length,sourceUrl:book.sourceUrl,kind:'txt'},chapters))stream+=line;
 let current=rows,state=rows;const adapter=new WatchCloudLibraryAdapter({cloudSnapshot:async()=>({articles:current,sources:[],stateArticles:state}),mergeCloud:async()=>0,cloudBooks:async()=>({books:[book],reading:[],mappings:[]}),cloudBookBody:async()=>utf8Encode(stream)},'watch',cloudCrypto,enabled),legacy=new WatchCloudCodec(crypto,enabled),writer=new WatchCloudCodec(crypto,enabled,{writeV1:()=>true});
 const base={accountKey:key,keyVersion:1,sourceDeviceId:'watch',sequence:1,snapshotId:'baseline',createdAtMillis:1,parentHeads:{},observedHeads:{}},before=await adapter.exportPayloads(true),first=await legacy.create({...base,objects:before.objects});
 const metrics=[];
 for(const kind of recipe.requiredCases){current=rows.map(a=>({...a}));state=current;
  if(kind==='add-one')current.push(article({articleId:'new',url:'https://fixture.invalid/new',contentText:body,contentHtml:'<b>新增</b>'}));
  if(kind==='edit-one')current[0]={...current[0],contentText:body+'编辑',contentHtml:'<b>改</b>',contentHash:'edited'};
  if(kind==='delete-one'){current=current.slice(1);state=[...current,{...rows[0],deleted:true,deletedAt:2,independentSaved:false}];}
  if(kind==='favorite-membership-change')current[0]={...current[0],favoriteSaved:true,favoriteChangedAt:2};
  if(kind==='favorite-clock-only')current[0]={...current[0],favoriteChangedAt:2};
  const exported=await adapter.exportPayloads(true),args={...base,sequence:2,snapshotId:'next-'+kind,createdAtMillis:2,objects:exported.objects,previous:first.manifest,removedPrivateArticleIds:exported.removedArticleIds,removedPrivateArticleUrls:exported.removedArticleUrls};
  let readBytes=0,readRequests=0;const read=async(h:string)=>{const b=first.newChunks.get(h)!;readBytes+=b.length;readRequests++;return b;};
  const started=performance.now(),next=await writer.create({...args,readPreviousChunk:read}),computeMillis=performance.now()-started;
  const old=await legacy.create({...args,readPreviousChunk:async h=>first.newChunks.get(h)!});
  const bytes=(s:typeof next)=>s.encryptedManifest.length+[...s.newChunks.values()].reduce((n,b)=>n+b.length,0),bodyBytes=[...next.newChunks].filter(([h])=>next.manifest.objects.some(o=>o.name.startsWith('private/articles/')&&o.chunks?.some(c=>c.ciphertextSha256===h))).reduce((n,[,b])=>n+b.length,0);
  expect(next.manifest.objects.find(o=>o.name==='private-library.wrss')?.chunks).toEqual(first.manifest.objects.find(o=>o.name==='private-library.wrss')!.chunks);expect(next.manifest.objects.find(o=>o.name==='books/'+book.bookId+'.jsonl')?.chunks).toEqual(first.manifest.objects.find(o=>o.name==='books/'+book.bookId+'.jsonl')?.chunks);
  expect(next.manifest.objects.filter(o=>o.name.startsWith('private/articles/')).length).toBeLessThanOrEqual(1);expect(next.manifest.objects.length).toBeLessThanOrEqual(4);
  if(kind==='add-one'||kind==='edit-one'||kind==='delete-one')expect(bytes(next)).toBeLessThan(bytes(old));
  if(kind==='delete-one'||kind.startsWith('favorite'))expect(bodyBytes).toBe(0);
  if(kind.startsWith('favorite'))expect(exported.fingerprint).toBe(before.fingerprint);
  const cold=await new WatchCloudCodec(crypto,enabled,{writeV1:()=>true}).decryptManifest(key,next.manifest.snapshotId,next.encryptedManifest),storage=new Map([...first.newChunks,...next.newChunks]);
  const retry=await writer.create({...args,snapshotId:'retry-'+kind,sequence:3,previous:cold,readPreviousChunk:async h=>storage.get(h)!});expect(retry.newChunks.size).toBe(0);
  const network=await publishBudget(next,first.newChunks,true),oldNetwork=await publishBudget(old,first.newChunks,false);
  metrics.push({case:kind,httpRequests:network.requests,requestBodyBytes:network.bytes,legacyHttpRequests:oldNetwork.requests,legacyRequestBodyBytes:oldNetwork.bytes,legacyUploadBytes:bytes(old),writeV1UploadBytes:bytes(next),uploadObjectRequests:next.newChunks.size+1,legacyUploadObjectRequests:old.newChunks.size+1,bodyBytes,backingReadBytes:readBytes,backingReadRequests:readRequests,constructMillis:Math.round(computeMillis),actualSyncWouldPublish:exported.fingerprint!==before.fingerprint});
 }
 console.info('R48_BUDGET '+JSON.stringify({articles:rows.length,chapters:chapters.length,baselineUploadBytes:first.encryptedManifest.length+[...first.newChunks.values()].reduce((n,b)=>n+b.length,0),metrics}));
},120000);

async function publishBudget(snapshot:EncryptedCloudSnapshot&{newChunks:Map<string,Uint8Array>},baseline:Map<string,Uint8Array>,r48:boolean){
 let requests=0,bytes=0;const stored=new Set(baseline.keys()),root='https://fixture.invalid',cryptoHash=await crypto.sha256(snapshot.encryptedManifest);
 const client=new WatchCloudClient({request:async r=>{requests++;bytes+=r.body?.length??0;let result:any={};
  if(r.url.endsWith('/format-capabilities'))result={protocol:'watchrss-content-evolution',version:1,phaseA:{cloudFormatR48ReadV1:true,cloudFormatR48WriteV1:true}};
  if(r.url.endsWith('/reserve')){const j=JSON.parse(utf8Decode(r.body!));result={snapshotId:j.snapshotId,reservedBytes:0,missingObjects:[{kind:'manifest',...j.manifest},...j.chunks.map((c:any)=>({kind:'chunk',...c}))].filter(o=>!stored.has(o.sha256)).map(o=>({...o,transport:'epoch-proxy',uploadMethod:'PUT',uploadUrl:root+'/functions/v1/cloud/uploads/'+o.sha256,reservationId:o.sha256}))};}
  if(r.method==='PUT')stored.add(r.url.split('/').at(-1)!);return {status:200,headers:{},body:utf8Encode(JSON.stringify(result))};
 }},{baseUrl:root,accessToken:'public-synthetic',r48WriteV1:r48},crypto,enabled);client.setEpoch('synthetic-epoch');client.setContentGeneration('55555555-5555-4555-8555-555555555555');await client.refreshR48WriteGate();
 const reservation=await client.reserveSnapshot(snapshot);for(const target of reservation.missingObjects)await client.uploadObject(target,target.sha256===cryptoHash?snapshot.encryptedManifest:snapshot.newChunks.get(target.sha256)!);await client.completeSnapshot(snapshot.manifest.snapshotId,[...new Set(snapshot.manifest.allChunks.map(c=>c.ciphertextSha256))]);return {requests,bytes};
}
