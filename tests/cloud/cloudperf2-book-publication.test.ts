import {test,expect} from 'bun:test';
import {bookFixture} from '../books/fixture';
import {bookFingerprint,bookId,chapterHash} from '../../src/books/protocol';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {cloudCrypto} from './library-fixture';
import {enabled} from './k2-crypto';
import {bookPackageLines} from '../../src/books/package';
test('first book is readable before second apply; lost journal reply and idempotent adoption still notify',async()=>{
 const f=await bookFixture();try{
  const payload=new Map<string,Uint8Array>(),descriptors:any[]=[];
  for(let i=1;i<=2;i++){
   const sourceUrl='https://watchrss.local/import-txt-novel/early-'+i,chapter={chapterIndex:1,title:'Chapter',contentText:'Readable '+i,contentHtml:null,url:sourceUrl+'/chapter/1'};
   const fingerprint=await bookFingerprint([await chapterHash(1,chapter.title,chapter.contentText,f.bookPorts.sha256)],f.bookPorts.sha256),id=await bookId(fingerprint,f.bookPorts.sha256);
   const header={format:'watchrss-book' as const,version:1 as const,title:'Book '+i,chapterCount:1,sourceUrl,kind:'txt' as const},info=await f.files.write(bookPackageLines(header,[chapter]),1e6),name='books/'+id+'.jsonl';
   payload.set(name,f.data.get(info.path)!);descriptors.push({name,privateBook:{bookId:id,fingerprint,title:header.title,chapterCount:1,sourceUrl,kind:'txt',packagePath:name}});
  }
  let current=0,fail=true;const notices:string[]=[],receipts=new Set<string>();
  const repo=Object.create(f.repo);repo.receiveCloudBook=async(id:string,bytes:Uint8Array,cp:any)=>{current++;return f.store.installPackage(await f.files.writeBytes(bytes),id,cp);};
  const library=new WatchCloudLibraryAdapter(repo,'watch',cloudCrypto,enabled),checkpoint={scope:async()=>'early',has:(u:string)=>receipts.has(u),check:async()=>{},result:()=>0,commit:async(u:string)=>{if(u==='book:'+descriptors[0].privateBook.bookId&&fail){fail=false;throw Error('cloud_snapshot_work_timeout');}receipts.add(u);}};
  const options={checkpoint,skipReading:true,onBookApplied:async(id:string)=>{notices.push(id);const rows=await f.db.query('SELECT a.content FROM articles a JOIN sync_book_chapters m ON m.item_id=a.id WHERE m.book_id=?',[id]);expect(rows[0].content).toBe(id===descriptors[0].privateBook.bookId?'Readable 1':'Readable 2');if(id===descriptors[0].privateBook.bookId)expect(await f.store.package(descriptors[1].privateBook.bookId)).toBeUndefined();}};
  await expect(library.restorePayloads(payload,'phone',descriptors,options)).rejects.toThrow('cloud_snapshot_work_timeout');expect(current).toBe(1);expect(notices).toEqual([descriptors[0].privateBook.bookId]);
  const result=await library.restorePayloads(payload,'phone',descriptors,options);expect(result.pending).toBe(0);expect(notices).toEqual([descriptors[0].privateBook.bookId,descriptors[0].privateBook.bookId,descriptors[1].privateBook.bookId]);
 }finally{f.sql.close();}
});
