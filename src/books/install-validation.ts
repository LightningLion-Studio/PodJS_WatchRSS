import {rangedLines,type FileCheckpoint} from '@podjs/framework/work-window';
import {encodeUtf8} from '@podjs/framework/bytes';
import {cpuWorkAsync} from '@podjs/framework/cpu-work';
import type {SqlDatabase} from '../core/types';
import {querySyncKeysetPages} from '../sync/sql-pages';
import {canonical} from '../cloud/records';
import {parseBookHeader,parseBookChapter} from './package';
import {bookFingerprint,bookId,chapterHash,type BookHash} from './protocol';
import type {BookFiles,BookFileInfo} from './files';
/** SQL commits retain validated chapter hashes and exact newline offsets. Secure
 * receipts follow SQL, so lost replies adopt SQL without rehashing the prefix.
 * Source SHA/size is authenticated by the caller on every invocation. */
export async function validateInstall(db:SqlDatabase,files:BookFiles,info:BookFileInfo,id:string,sha:BookHash,expected:{fingerprint:string;chapterCount:number}|undefined,cp?:FileCheckpoint){
 const binding=await sha(encodeUtf8(canonical(['book-install-v1',await cp?.scope?.()??'local',id,info.sha256,info.size])));
 let row=(await db.query('SELECT * FROM sync_book_install WHERE binding=?',[binding]))[0];
 const lines=(offset:number)=>rangedLines((at,max)=>files.read(info.path,at,max),info.size,offset);
 if(!row){const first=await lines(0)[Symbol.asyncIterator]().next();if(first.done)throw Error('book_package_invalid');const header=parseBookHeader(first.value.text);
  await db.transaction([{sql:'INSERT OR IGNORE INTO sync_book_install(binding,header,header_offset,validated_index,validated_offset) VALUES(?,?,?,0,?)',params:[binding,canonical(header),first.value.end,first.value.end]}]);
  row=(await db.query('SELECT * FROM sync_book_install WHERE binding=?',[binding]))[0]!;
 }
 const header=parseBookHeader(String(row.header));let index=Number(row.validated_index),offset=Number(row.validated_offset);
 const receipt=async()=>{const unit='book-validation:'+binding+':'+index;if(!cp?.has(unit))await cp?.commit(unit);};
 // Adopt a SQL page whose secure receipt was interrupted, before reading more.
 if(index)await receipt();
 if(!Number(row.complete))await cpuWorkAsync('book-validate','items',header.chapterCount-index,async()=>{
  let batch:{sql:string;params:unknown[]}[]=[],batchStart=offset;
  const flush=async()=>{if(!batch.length)return;await cp?.check();await db.transaction([...batch,{sql:'UPDATE sync_book_install SET validated_index=?,validated_offset=? WHERE binding=?',params:[index,offset,binding]}]);batch=[];batchStart=offset;await receipt();await cp?.check();};
  for await(const line of lines(offset)){await cp?.check();const c=parseBookChapter(line.text,++index);if(index>header.chapterCount)throw Error('book_package_invalid');
   batch.push({sql:'INSERT INTO sync_book_validation(binding,chapter_index,chapter_hash,source_url,line_end) VALUES(?,?,?,?,?)',params:[binding,index,await chapterHash(index,c.title,c.contentText,sha),c.url,line.end]});offset=line.end;
   if(batch.length>=32||offset-batchStart>=262144)await flush();
  }
  await flush();if(index!==header.chapterCount)throw Error('book_package_invalid');
 });
 if(index!==header.chapterCount||offset!==info.size)throw Error('book_package_invalid');
 const hashes=await querySyncKeysetPages(db,'SELECT chapter_index,chapter_hash FROM sync_book_validation WHERE binding=? AND chapter_index>? ORDER BY chapter_index',[binding],{key:'chapter_index'});
 if(hashes.length!==index||hashes.some((r,i)=>Number(r.chapter_index)!==i+1))throw Error('book_package_invalid');
 const fingerprint=Number(row.complete)?String(row.fingerprint):await bookFingerprint(hashes.map(r=>String(r.chapter_hash)),sha),actual=await bookId(fingerprint,sha);
 if(actual!==id||expected&&(expected.fingerprint!==fingerprint||expected.chapterCount!==index))throw Error('book_package_invalid');
 if(!Number(row.complete))await db.transaction([{sql:'UPDATE sync_book_install SET complete=1,fingerprint=? WHERE binding=?',params:[fingerprint,binding]}]);
 return {binding,header,fingerprint,bookId:actual,chapterHashes:hashes.map(r=>String(r.chapter_hash)),row,lines};
}
