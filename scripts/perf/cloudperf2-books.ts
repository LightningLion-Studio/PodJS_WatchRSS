import {observeCpuWork} from '@podjs/framework/cpu-work';
import {createBackgroundLibrary} from '../../src/cloud/background-library';
import {createCloudHostPorts} from '../../src/cloud/host-ports';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {SnapshotRestoreCheckpoint} from '../../src/cloud/snapshot-checkpoint';
import {ImportedTextStore} from '../../src/reader/imported-text';
import {readReaderBody} from '../../src/reader/body-state';
import {legacyWebArticleId} from '../../src/cloud/rss-identity';
import {decodeBase64} from '@podjs/framework/bytes';
import {utf8Decode as decodeUtf8} from '../../src/cloud/types';
async function run(ctx:any){
 const guard={require(){}},host=async<T>(method:string,args:Record<string,unknown>):Promise<T>=>ctx.request('debug.cloudHost',{method,args});
 const ports=createCloudHostPorts(host,guard),repo=await createBackgroundLibrary(host,async()=>undefined,guard),crypto={...ports.crypto,stableId:(url:string)=>legacyWebArticleId(url,ports.crypto.sha256)},library=new WatchCloudLibraryAdapter(repo,await repo.deviceId(),crypto,guard);
 const session:any=ports.foundation('fixture','watch',{request:async()=>{throw Error('no external network');}},{baseUrl:'https://fixture.invalid',accessToken:'synthetic'});session.userId='fixture';session.deviceId='watch';session.keys={currentKeyVersion:async()=>1,accountKey:async()=>new Uint8Array(32).fill(41)};
 session.restoreCheckpoint={state:session.state,cache:session.cache,codec:session.codec};
 const cp=await new SnapshotRestoreCheckpoint(session,crypto.sha256,async()=>{},Date.now).open('9b2e7c41-0d3f-4a8b-b6c5-aabbccddeeff','fixture-generation');if(!cp.active)await cp.begin();
 const db:any={query:(sql:string,params:any[]=[])=>host('sql.query',{sql,params})};
 const text=new ImportedTextStore({stat:path=>host('file.stat',{path}),read:async(path,offset,maxBytes)=>decodeBase64((await host<any>('file.read',{path,offset,maxBytes})).dataBase64),decode:decodeUtf8});
 let work:Record<string,number>={};const stop=observeCpuWork(m=>{if(m.outcome==='complete')work[m.stage]=(work[m.stage]??0)+m.elapsedMillis;});
 for(const fixture of ctx.payload.fixtures){
  const bytes=(await ports.files.read(fixture.path))!;if(bytes.length!==fixture.size)throw Error('fixture byte count');
  work={};await ctx.request('perf',{event:'start',stage:'last-byte-to-reader',sizeMiB:fixture.sizeMiB,bytes:bytes.length});
  let opened=false;
  const result=await library.restorePayloads(new Map([['private/book-'+fixture.sizeMiB,bytes]]),'phone',[{name:'private/book-'+fixture.sizeMiB,privateBook:fixture.descriptor} as any],{checkpoint:cp.apply('book-'+fixture.sizeMiB),skipReading:true,onBookApplied:async id=>{
   const rows:any[]=await db.query('SELECT a.id,a.link FROM sync_book_chapters m JOIN articles a ON a.id=m.item_id WHERE m.book_id=? ORDER BY m.chapter_index LIMIT 1',[id]);if(!rows.length)throw Error('book not published');const a=rows[0];
   const body=await readReaderBody(db,text,String(a.id),a.link,async()=>String((await db.query('SELECT content FROM articles WHERE id=?',[a.id]))[0].content),'');
   const first=body.importedText?await text.chunk(body.importedText,0):body.rawContent;if(body.readerBodyState||!first?.startsWith('Synthetic novel'))throw Error('reader body unavailable');opened=true;
   await ctx.request('perf',{event:'end',stage:'last-byte-to-reader',sizeMiB:fixture.sizeMiB,bytes:bytes.length,readerBytes:first.length,insideBookCallback:true,work});
  }});
  if(!opened||result.pending||result.abandoned)throw Error('book not opened '+JSON.stringify(result));
 }
 stop();cp.close();return 'success';
}
(globalThis as any).backgroundHandler=async(ctx:any)=>{try{return await run(ctx);}catch(error){await ctx.request('perf',{event:'end',stage:'failure',error:String(error),stack:(error as Error).stack});throw error;}};
