/** In-memory ciphertext transport; production snapshot restore, SQLite, files,
 * AEAD, gzip and reader body. Excludes real HTTP RTT and rendered UI. */
import {defineBackgroundHandler} from '@podjs/framework/background-handler';
import {fixture} from './cloudperf2-service-fixture';
import {createBackgroundLibrary} from '../../src/cloud/background-library';
import {createCloudHostPorts} from '../../src/cloud/host-ports';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {SnapshotRestoreCheckpoint} from '../../src/cloud/snapshot-checkpoint';
import {restoreSnapshots} from '../../src/cloud/snapshot-restore';
import {ImportedTextStore} from '../../src/reader/imported-text';
import {readReaderBody} from '../../src/reader/body-state';
import {legacyWebArticleId} from '../../src/cloud/rss-identity';
import {decodeBase64} from '@podjs/framework/bytes';
import {utf8Decode} from '../../src/cloud/types';
async function run(ctx:any){
 const guard={require(){}},host=async<T>(method:string,args:Record<string,unknown>):Promise<T>=>ctx.request('debug.cloudHost',{method,args});
 const ports=createCloudHostPorts(host,guard),repo=await createBackgroundLibrary(host,async()=>undefined,guard),f=await fixture(ports.crypto),s=f.session;
 const foundation=ports.foundation('user','watch',f.transport,{baseUrl:'https://backend.invalid',accessToken:'fixture-token'});
 s.state=foundation.state;s.cache=foundation.cache;s.codec=foundation.codec;s.restoreCheckpoint={state:s.state,cache:s.cache,codec:s.codec};
 s.library=new WatchCloudLibraryAdapter(repo,'watch',{...ports.crypto,stableId:(url:string)=>legacyWebArticleId(url,ports.crypto.sha256)},guard);
 const fixtures=ctx.payload.fixtures,objects=[];
 for(const v of fixtures)objects.push({name:v.descriptor.packagePath,bytes:(await ports.files.read(v.path))!,privateBook:v.descriptor});
 const remote=await f.phone({objects});objects.length=0;
 const bootstrap=await s.client.bootstrap();s.client.setEpoch(bootstrap.libraryEpoch);s.client.setContentGeneration(bootstrap.contentGeneration);
 const finalChunks=new Map(remote.snap.manifest.objects.map((o,i)=>[o.chunks.at(-1)!.ciphertextSha256,fixtures[i]]));
 const downloaded=new Set<string>(),opened=new Set<string>();let active:any;
 const request=f.transport.request.bind(f.transport);
 f.transport.request=async r=>{const response=await request(r),hash=r.url.split('/').at(-1)!,v=finalChunks.get(hash);if(v&&!downloaded.has(v.descriptor.bookId)){downloaded.add(v.descriptor.bookId);active=v;await ctx.request('perf',{event:'start',stage:'encrypted-last-byte-to-reader',sizeMiB:v.sizeMiB,bytes:v.size,ciphertextLastChunk:response.body.length});}return response;};
 const cp=await new SnapshotRestoreCheckpoint(s,ports.crypto.sha256,async()=>{},Date.now).open('9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff',f.content().contentGeneration);await cp.begin();
 const db:any={query:(sql:string,params:any[]=[])=>host('sql.query',{sql,params})},text=new ImportedTextStore({stat:path=>host('file.stat',{path}),read:async(path,offset,maxBytes)=>decodeBase64((await host<any>('file.read',{path,offset,maxBytes})).dataBase64),decode:utf8Decode});
 const changed=async()=>{if(!active||opened.has(active.descriptor.bookId))return;const rows:any[]=await db.query('SELECT a.id,a.link FROM sync_book_chapters m JOIN articles a ON a.id=m.item_id WHERE m.book_id=? ORDER BY m.chapter_index LIMIT 1',[active.descriptor.bookId]);if(!rows.length)return;
  const a=rows[0],body=await readReaderBody(db,text,String(a.id),a.link,async()=>String((await db.query('SELECT content FROM articles WHERE id=?',[a.id]))[0].content),'');
  const first=body.importedText?await text.chunk(body.importedText,0):body.rawContent;if(body.readerBodyState||!first?.startsWith('Synthetic novel'))throw Error('reader body unavailable');opened.add(active.descriptor.bookId);
  const pendingBooks=fixtures.filter((v:any)=>!downloaded.has(v.descriptor.bookId)).length;
  await ctx.request('perf',{event:'end',stage:'encrypted-last-byte-to-reader',sizeMiB:active.sizeMiB,bytes:active.size,readerBytes:first.length,booksNotYetDownloaded:pendingBooks,headAcknowledged:f.calls.some(c=>c.url.endsWith('/ack'))});
 };
 const result=await restoreSnapshots({session:s,heads:[remote.head],full:true,journal:cp,current:async()=>{},manifest:(h,b)=>s.codec.decryptManifest(new Uint8Array(32).fill(41),h.id,b),hash:ports.crypto.sha256,supported:()=>true,now:Date.now,status:()=>{},changed});
 if(opened.size!==fixtures.length)throw Error('unreadable books '+JSON.stringify(result));cp.close();return 'success';
}
(globalThis as any).backgroundHandler=defineBackgroundHandler(async(ctx:any)=>{try{return await run(ctx);}catch(error){await ctx.request('perf',{event:'end',stage:'failure',error:String(error),stack:(error as Error).stack});throw error;}},{yieldTurn:async ctx=>{await ctx.request!('debug.cloudHost',{method:'runtime.delay',args:{milliseconds:1}});}});
