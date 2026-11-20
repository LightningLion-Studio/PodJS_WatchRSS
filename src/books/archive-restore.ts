import type {Statement} from '@podjs/framework/sql-projection';
import {importBookPackage,type BinaryBookFiles} from '../sync/library-binary/book-import';
import type {LegacyBodyArchive} from '../sync-v2/legacy-body';
import type {BookState} from './protocol';
import type {SqlBookStore} from './store';

/** Produce the same final transaction as B2, with the package and chapters
 * staged first. The caller commits it at the Sync v2 business CAS. */
export async function prepareArchivedBook(store:SqlBookStore,files:BinaryBookFiles,book:BookState,archive:LegacyBodyArchive,check:()=>void):Promise<Statement[]>{
 const {size,sha256,owner}=archive.ref,final='books/'+book.bookId+'-'+sha256+'.jsonl';
 if(((await files.stat('books')).usableBytes??0)<size*2+1048576)throw Error('storage_pressure');
 const path=(await files.createTemp('books')).path;
 try{
  await archive.read(async(part,offset)=>{
   check();
   const written=await files.appendBytes(path,part,offset);
   if(written.size!==offset+part.length)throw Error('storage_error');
  });
  const measured=await files.hash(path);
  if(measured.size!==size||measured.sha256!==sha256)throw Error('hash_mismatch');
  let statements:Statement[]|undefined;
  const info={path,size,sha256};
  await store.installBinaryPackage(info,book,'legacy-'+owner,visit=>importBookPackage(files,info,book,visit,check),async()=>{
   check();await files.durableCommit(path,final,size,sha256);
   return {...info,path:final};
  },{
   check,before:[],after:outcome=>{if(outcome==='retainedLocal')throw Error('body_revision_changed');return [];},
   transaction:async plan=>{statements=plan;},
  });
  if(!statements)throw Error('closure_incomplete');
  return statements;
 }finally{await files.remove(path).catch(()=>{});}
}
