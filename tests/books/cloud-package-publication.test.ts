import {expect,test} from 'bun:test';
import {bookFixture} from './fixture';
import {bookFingerprint,bookId,chapterHash} from '../../src/books/protocol';
import {bookPackageLines} from '../../src/books/package';
import {fixture as cloudFixture} from '../cloud/service-fixture';
import {crypto,enabled,key} from '../cloud/k2-crypto';
import {WatchCloudCodec} from '../../src/cloud/codec';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {SnapshotRestoreCheckpoint} from '../../src/cloud/snapshot-checkpoint';
import {restoreSnapshots} from '../../src/cloud/snapshot-restore';
import {decodeBase64} from '@podjs/framework/bytes';
import {legacyWebArticleId} from '../../src/cloud/rss-identity';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import type {FileCheckpoint} from '@podjs/framework/work-window';

test('cloud package reads each chapter once and resumes an interrupted private page before publishing',async()=>{
 const f=await bookFixture();
 try{
  const sourceUrl='https://watchrss.local/import-txt-novel/one-scan';
  const chapters=Array.from({length:8},(_,i)=>({chapterIndex:i+1,title:'Chapter '+(i+1),
   contentText:('第'+(i+1)+'章正文 ').repeat(7000),contentHtml:null,url:sourceUrl+'/chapter/'+(i+1)}));
  const header={format:'watchrss-book' as const,version:1 as const,title:'Book',chapterCount:chapters.length,sourceUrl,kind:'txt' as const};
  const hashes=await Promise.all(chapters.map(c=>chapterHash(c.chapterIndex,c.title,c.contentText,f.bookPorts.sha256)));
  const fingerprint=await bookFingerprint(hashes,f.bookPorts.sha256),id=await bookId(fingerprint,f.bookPorts.sha256);
  const input=await f.files.write(bookPackageLines(header,chapters),4e6),bytes=f.data.get(input.path)!;
  let readBytes=0;
  const read=f.files.read;
  f.files.read=async(...args)=>{const result=await read(...args);readBytes+=result.bytes.length;return result;};
  await f.store.merge({bookId:id,fingerprint,title:header.title,chapterCount:chapters.length,deletedChapters:[],
   deletionClock:0,deleted:false,deletedAt:0,updatedAt:1,sourceDeviceId:'phone',sourceUrl,kind:'txt'});
  const receipts=new Set<string>();
  let interrupted=false;
  const checkpoint:FileCheckpoint={scope:async()=>'cloud-one-scan',has:unit=>receipts.has(unit),check:async()=>{},
   commit:async unit=>{
    if(!interrupted&&(await f.db.query('SELECT count(*) AS n FROM sync_book_stage'))[0].n){
     interrupted=true;
     throw Error('interrupted after durable private page');
    }
    receipts.add(unit);
   }};
  const repository=()=>new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:f.files});
  await expect(repository().receiveCloudBook(id,bytes,checkpoint)).rejects.toThrow('interrupted after durable private page');
  const chapterCount=async()=>(await f.db.query('SELECT count(*) AS n FROM sync_book_chapters WHERE book_id=?',[id]))[0].n;
  expect(await chapterCount()).toBe(0);
  expect((await f.db.query('SELECT count(*) AS n FROM articles'))[0].n).toBe(0);
  expect(await f.store.package(id)).toBeUndefined();
  await repository().receiveCloudBook(id,bytes,checkpoint);
  expect(await chapterCount()).toBe(chapters.length);
  const bodies=await f.db.query('SELECT content FROM articles ORDER BY id');
  expect(bodies.map(row=>row.content)).toEqual(chapters.map(chapter=>chapter.contentText));
  console.info('cloud package scan bytes',JSON.stringify({packageBytes:bytes.length,readBytes}));
  // The header probe and an interrupted range may each read ahead by 64 KiB.
  expect(readBytes).toBeLessThanOrEqual(bytes.length+2*65536);
 }finally{f.sql.close();}
});

for(const corrupt of [false,true])test('native cloud file restore '+(corrupt?'rejects a mismatched object digest without publishing':'installs without reading the whole object across the bridge'),async()=>{
 const f=await bookFixture();
 try{
  const cloud=await cloudFixture(),sourceUrl='https://watchrss.local/import-txt-novel/direct-file';
  const chapters=Array.from({length:6},(_,i)=>({chapterIndex:i+1,title:'Chapter '+(i+1),
   contentText:'Synthetic content '.repeat(4096),contentHtml:null,url:sourceUrl+'/'+(i+1)}));
  const count=chapters.length;
  const fingerprint=await bookFingerprint(await Promise.all(chapters.map(c=>chapterHash(c.chapterIndex,c.title,c.contentText,crypto.sha256))),crypto.sha256);
  const id=await bookId(fingerprint,crypto.sha256),name='books/'+id+'.jsonl';
  const header={format:'watchrss-book' as const,version:1 as const,title:'Direct',chapterCount:count,sourceUrl,kind:'txt' as const};
  const packaged=await f.files.write(bookPackageLines(header,chapters),1e6),body=f.data.get(packaged.path)!;
  const {head}=await cloud.phone({objects:[{name,bytes:body,compress:false,privateBook:{...header,bookId:id,fingerprint,packagePath:name},
   contentSha256:corrupt?'0'.repeat(64):packaged.sha256}]});
  let opens=0,closes=0,adopts=0,bytesInstalls=0;
  const codec=new WatchCloudCodec({...crypto,localPlaintext:true,
   openSealedParts:async()=>{throw Error('whole-buffer fallback called');},
   openSealedPartsFile:async(_key,parts,length)=>{
    opens++;
    const output=new Uint8Array(length);
    let offset=0;
    for(const part of parts){
     const token=part.path.split('/').at(-1)!.replace(/\.bin$/,'');
     const sealed=(await cloud.cache.restoreProjection('user',token))!;
     const scope=new TextDecoder().decode(decodeBase64(part.aadBase64));
     const bytes=await codec.openRestoreProjection(key,scope,sealed);
     expect(bytes.length).toBe(part.bytes);
     output.set(bytes,offset);offset+=bytes.length;
    }
    expect(offset).toBe(length);
    const path='native-projection';
    f.data.set(path,output);
    return {path,size:length,sha256:await crypto.sha256(output),read:async (at,max)=>{
     expect(max).toBeLessThanOrEqual(65536);
     return output.subarray(at,at+max);
    },close:async()=>{closes++;f.data.delete(path);}};
   },
  },enabled);
  f.files.adopt=async(file,book)=>{adopts++;return f.files.publish(file,book);};
  const repo=new SqlLibrarySessionRepository(f.db,{...f.ports,bookFiles:f.files});
  repo.receiveCloudBook=async()=>{bytesInstalls++;throw Error('whole-buffer installation called');};
  const session=cloud.session;session.codec=codec;
  session.library=new WatchCloudLibraryAdapter(repo,'watch',{...crypto,stableId:url=>legacyWebArticleId(url,crypto.sha256)},enabled);
  const bootstrap=await session.client.bootstrap();
  session.client.setEpoch(bootstrap.libraryEpoch);session.client.setContentGeneration(bootstrap.contentGeneration);
  const checkpoint=await new SnapshotRestoreCheckpoint(session,crypto.sha256,async()=>{},Date.now).open('epoch','generation');
  await checkpoint.begin();
  try{
   const result=await restoreSnapshots({session,heads:[head],full:true,journal:checkpoint,current:async()=>{},
    manifest:(v,b)=>codec.decryptManifest(key,v.id,b),hash:crypto.sha256,supported:()=>true,now:Date.now,status:()=>{},changed:()=>{}});
   expect(result.pendingItems).toBe(corrupt?1:0);
   expect(await session.state.applied('phone',true)).toBe(corrupt?0:1);
   expect((await f.db.query('SELECT count(*) AS n FROM articles'))[0].n).toBe(corrupt?0:count);
   expect(opens).toBe(1);expect(closes).toBe(1);expect(bytesInstalls).toBe(0);expect(adopts).toBe(corrupt?0:1);
   if(!corrupt)expect((await f.store.package(id))?.sha256).toBe(packaged.sha256);
  }finally{checkpoint.close();}
 }finally{f.sql.close();}
});

test('cloud book rejects a changed last chapter and survives a failed final SQL commit',async()=>{
 const f=await bookFixture();
 try{
  const sourceUrl='https://watchrss.local/import-txt-novel/full-commit';
  const chapters=Array.from({length:5},(_,i)=>({chapterIndex:i+1,title:'Chapter '+(i+1),
   contentText:'abcd'.repeat(16384),contentHtml:null,url:sourceUrl+'/'+(i+1)}));
  const fingerprint=await bookFingerprint(await Promise.all(chapters.map(c=>chapterHash(c.chapterIndex,c.title,c.contentText,crypto.sha256))),crypto.sha256);
  const id=await bookId(fingerprint,crypto.sha256);
  const header={format:'watchrss-book' as const,version:1 as const,title:'All or nothing',chapterCount:chapters.length,sourceUrl,kind:'txt' as const};
  const input=await f.files.write(bookPackageLines(header,chapters),1e6),bytes=f.data.get(input.path)!;
  const last=chapters.at(-1)!;
  const changed=[...chapters.slice(0,-1),{...last,contentText:'x'+last.contentText.slice(1)}];
  const damaged=await f.files.write(bookPackageLines(header,changed),1e6);
  const bad=f.data.get(damaged.path)!;
  const receipts=new Set<string>();
  const checkpoint:FileCheckpoint={scope:async()=>'final-boundary',has:unit=>receipts.has(unit),check:async()=>{},commit:async unit=>{receipts.add(unit);}};
  let directoryFails=false;
  const files={...f.ports.files,storeStagedText:async(_key:string,value:string)=>value,
   syncStagedText:async()=>{if(directoryFails){directoryFails=false;throw Error('power cut before directory sync');}}};
  const open=()=>new SqlLibrarySessionRepository(f.db,{...f.ports,files,bookFiles:f.files});
  const visible=async()=>(await f.db.query('SELECT count(*) AS n FROM sync_book_chapters WHERE book_id=?',[id]))[0].n;
  await expect(open().receiveCloudBook(id,bad,checkpoint)).rejects.toThrow('book_package_invalid');
  expect(await visible()).toBe(0);
  expect(await f.store.package(id)).toBeUndefined();
  const staged=async()=>(await f.db.query('SELECT count(*) AS n FROM sync_book_stage'))[0].n;
  const oldRows=await staged();
  const hash=f.files.hash;
  let changeRevision=true;
  f.files.hash=async path=>{
   const result=await hash(path);
   if(changeRevision){
    changeRevision=false;
    await f.db.execute('UPDATE sync_library_revision SET revision=revision+1 WHERE id=1');
   }
   return result;
  };
  await expect(open().receiveCloudBook(id,bytes,checkpoint)).rejects.toThrow('NOT NULL');
  expect(await staged()).toBe(oldRows);
  expect(await visible()).toBe(0);
  directoryFails=true;
  await expect(open().receiveCloudBook(id,bytes,checkpoint)).rejects.toThrow('power cut before directory sync');
  expect(await staged()).toBe(oldRows);
  expect(await visible()).toBe(0);
  const commit=f.db.transactionChanges!;
  let fail=true;
  f.db.transactionChanges=async statements=>{
   if(fail&&statements.some(s=>s.sql.startsWith('UPDATE sync_books SET registration_complete=1'))){
    fail=false;
    expect(await visible()).toBe(0);
    throw Error('power cut before publication');
   }
   return commit(statements);
  };
  await expect(open().receiveCloudBook(id,bytes,checkpoint)).rejects.toThrow('power cut before publication');
  expect(await visible()).toBe(0);
  expect(await f.store.package(id)).toBeUndefined();
  const read=f.files.read;
  f.files.read=async()=>{throw Error('completed private shadow must not reread chapters');};
  await open().receiveCloudBook(id,bytes,checkpoint);
  f.files.read=read;
  expect(await visible()).toBe(chapters.length);
  expect((await f.store.package(id))?.sha256).toBe(input.sha256);
 }finally{f.sql.close();}
});
