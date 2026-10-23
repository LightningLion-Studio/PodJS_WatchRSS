import {base64ToBytes,bytesToBase64,writeByteStream,writeUtf8Stream} from '@podjs/framework/bytes';
import {splitBookLines} from './package';
import {BOOK_MAX_PACKAGE_BYTES} from './protocol';
import type {BookFileInfo,BookFiles} from './files';
export type BookFileRequest=<T>(method:string,args:Record<string,unknown>)=>Promise<T>;
const temporary=/^books\/\.pod-write-[A-Za-z0-9_-]+\.part$/;
const owned=/^books\/(?:\.pod-write-[A-Za-z0-9_-]+\.part|part-[A-Za-z0-9_-]+\.bin|[a-f0-9]{64}-[a-f0-9]{64}\.jsonl)$/;
const path=(value:string)=>{if(!owned.test(value))throw Error('book_file_path_invalid');return value;};
/** Foreground/background use identical private file operations. Native hash,
 * atomic commit and bounded UTF-8 readers keep entire books out of JS strings. */
export function createBookFiles(host:BookFileRequest):BookFiles {
 const append=async(file:string,bytes:Uint8Array,offset:number)=>(await host<{size:number}>('file.write',{path:path(file),append:true,expectedOffset:offset,dataBase64:bytesToBase64(bytes)})).size;
 const temp=async()=>{const result=await host<{path:string}>('file.createTemp',{directory:'books'});if(!temporary.test(result.path))throw Error('book_file_path_invalid');return result.path;};
 const hash=async(file:string)=>host<{size:number;sha256:string}>('file.hash',{path:path(file)});
 const remove=async(file:string)=>{await host('file.delete',{path:path(file)});};
 async function write(bytes:AsyncIterable<Uint8Array>|Iterable<Uint8Array>,max:number,existing?:string){const file=existing??await temp();try{const size=await writeByteStream(bytes,(b,o)=>append(file,b,o),{maxBytes:Math.min(max,BOOK_MAX_PACKAGE_BYTES)}),digest=await hash(file);if(digest.size!==size)throw Error('book_file_changed');return {path:file,...digest};}catch(error){await remove(file);throw error;}}
 const files:BookFiles={
  write:async(parts,max)=>{const file=await temp();try{const size=await writeUtf8Stream(parts,(b,o)=>append(file,b,o),{maxBytes:Math.min(max,BOOK_MAX_PACKAGE_BYTES),surrogatePolicy:'question'}),digest=await hash(file);if(digest.size!==size)throw Error('book_file_changed');return {path:file,...digest};}catch(error){await remove(file);throw error;}},
  writeBytes:async bytes=>{const info=await write([bytes],BOOK_MAX_PACKAGE_BYTES);const stem=info.path.slice('books/.pod-write-'.length,-'.part'.length),target='books/part-'+stem+'.bin';try{const result=await host<{path:string;size:number;sha256:string}>('file.commit',{path:info.path,target,expectedSize:info.size,expectedSha256:info.sha256});if(result.path!==target||result.size!==info.size||result.sha256!==info.sha256)throw Error('book_file_commit_invalid');return result;}finally{await remove(info.path);}},
  publish:async(info,id)=>{if(!/^[a-f0-9]{64}$/.test(id)||!/^[a-f0-9]{64}$/.test(info.sha256)||!Number.isSafeInteger(info.size)||info.size<1||info.size>BOOK_MAX_PACKAGE_BYTES)throw Error('book_file_identity_invalid');const target='books/'+id+'-'+info.sha256+'.jsonl';if(info.path===target){const current=await hash(target);if(current.size!==info.size||current.sha256!==info.sha256)throw Error('book_file_changed');return info;}const result=await host<{path:string;size:number;sha256:string}>('file.commit',{path:path(info.path),target,expectedSize:info.size,expectedSha256:info.sha256});if(result.path!==target||result.size!==info.size||result.sha256!==info.sha256)throw Error('book_file_commit_invalid');return result;},
  stat:file=>host('file.stat',{path:path(file)}),hash,
  read:async(file,offset,maxBytes)=>{if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>65536)throw Error('book_file_read_bounds');const r=await host<{size:number;dataBase64:string}>('file.read',{path:path(file),offset,maxBytes});return {size:r.size,bytes:base64ToBytes(r.dataBase64)};},
  lines:file=>splitBookLines((async function*(){const reader=await host<{id:string}>('file.openText',{path:path(file),strictUtf8:true});try{for(;;){const r=await host<{text:string;eof:boolean}>('file.readTextChunk',{id:reader.id,maxChars:16384});if(r.text)yield r.text;if(r.eof)break;if(!r.text)throw Error('book_file_read_stalled');}}finally{await host('file.closeText',{id:reader.id});}})()),
  combine:async(paths,max)=>write((async function*(){for(const file of paths){const stat=await files.stat(file);if(!stat.exists||stat.size>65536)throw Error('book_package_part_changed');let offset=0;while(offset<stat.size){const r=await files.read(file,offset,Math.min(65536,stat.size-offset));if(r.size!==stat.size||!r.bytes.length)throw Error('book_package_part_changed');offset+=r.bytes.length;yield r.bytes;}}})(),max),remove,
 };return files;
}
