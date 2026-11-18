import {lengthPrefix} from '@podjs/framework/crypto';
import {ContentSha256} from '@podjs/framework/content-sha256';
import {bookId,normalizeBookText,type BookState} from '../../books/protocol';
import {isBookUrl,parseBookHeader,type BookPackageHeader} from '../../books/package';
import type {BookFileInfo} from '../../books/files';
import type {BinaryArticleFiles} from './article-file';
import {BodyJsonReader,TextFile} from './article-file';
import type {BookFileDigest} from './book-plan';
import {fail,hash,strictJson} from './wire';

export interface BookRange {path:string;offset:number;size:number}
export interface BinaryBookFiles extends BinaryArticleFiles {
 copyRanges(options:{ranges:readonly BookRange[];target?:string;size:number;sha256?:string;index?:true;segmentBytes?:number;prefix?:readonly number[]}):Promise<{size:number;sha256:string;segments:BookFileDigest[]}>;
 durableRemove(path:string):Promise<void>;
 durableCommit(path:string,target:string,size:number,sha256:string):Promise<{path:string}>;
}
type BookHostOperation=<T>(method:string,args:Record<string,unknown>,progress?:(value:unknown)=>void)=>{result:Promise<T>;cancel():void};
export function bookFileWork(files:BinaryArticleFiles,host:BookHostOperation,advance:()=>void){
 const pending=new Set<()=>void>();
 let stopped=false;
 const run=<T>(method:string,args:Record<string,unknown>)=>{
  if(stopped)fail('AUTH_REVOKED');
  let bytes=0;
  const op=host<T>(method,{...args,trackProgress:true},value=>{
   const next=(value as {bytes?:number}|null)?.bytes;
   if(!stopped&&typeof next==='number'&&Number.isSafeInteger(next)&&next>bytes){bytes=next;advance();}
  });
  const cancel=()=>op.cancel();
  pending.add(cancel);
  return op.result.finally(()=>pending.delete(cancel));
 };
 const bookFiles:BinaryBookFiles={...files,
  copyRanges:options=>run('file.copyRanges',{...options}),
  hash:path=>run('file.hash',{path}),
  durableCommit:(path,target,size,sha256)=>run('file.commit',{path,target,expectedSize:size,expectedSha256:sha256,syncDirectory:true}),
  durableRemove:async path=>{await host('file.delete',{path,syncDirectory:true}).result;},
 };
 return {files:bookFiles,stop(){
  if(stopped)return;
  stopped=true;
  for(const cancel of pending)try{cancel();}catch{/* Cancel each outstanding operation. */}
  pending.clear();
 }};
}
export interface StreamedBookChapter {
 chapterIndex:number;
 title:string;
 url:string;
 chapterHash:string;
 content:string;
 html:string|null;
 text:string;
}

function normalized(file:TextFile){
 let pendingCR=false;
 return async(value:string,done=false)=>{
  const text=(pendingCR?'\r':'')+value;
  pendingCR=!done&&text.endsWith('\r');
  await file.append(normalizeBookText(pendingCR?text.slice(0,-1):text));
 };
}

/** Stream chapter body fields into files. Only the header and chapter index,
 * title and URL survive a record. The legacy length-prefixed hashes are exact. */
export async function importBookPackage(files:BinaryBookFiles,info:BookFileInfo,state:Pick<BookState,'bookId'|'chapterCount'|'fingerprint'|'instanceId'>,
 visit:((header:BookPackageHeader,chapter:StreamedBookChapter)=>Promise<void>)|undefined,check:()=>void):Promise<void>{
 const reader=(await files.openText(info.path,{strictUtf8:true})).id;
 const json=new BodyJsonReader(async()=>{check();return files.readTextChunk(reader,16384);},true);
 try{
  const line=await json.line();
  strictJson(line,false);
  const header=parseBookHeader(line);
  if(header.chapterCount!==state.chapterCount||header.instanceId!==state.instanceId)fail('BUSINESS_REJECTED');
  const fingerprint=new ContentSha256();
  fingerprint.update(lengthPrefix('watchrss/book/fingerprint/v1',header.chapterCount));
  for(let index=1;index<=header.chapterCount;index++){
   const temporary:string[]=[];
   const create=async()=>{
    const {path}=await files.createTemp('article_content');temporary.push(path);
    return new TextFile(path,files,check);
   };
   try{
    const text=await create(),html=await create(),normalizeText=normalized(text),normalizeHtml=normalized(html);
    const chapter=await json.bookChapter(field=>field==='contentText'?normalizeText:normalizeHtml);
    if(!chapter||chapter.chapterIndex!==index||!isBookUrl(chapter.url))fail('BUSINESS_REJECTED');
    await normalizeText('',true);await normalizeHtml('',true);
    const size=await text.finish();
    const fields=lengthPrefix('watchrss/book/chapter/v1',index,normalizeBookText(chapter.title));
    const prefix=new Uint8Array(fields.length+4);
    prefix.set(fields);new DataView(prefix.buffer).setUint32(fields.length,size);
    const chapterHash=size?
     (await files.copyRanges({ranges:[{path:text.path,offset:0,size}],size,prefix:Array.from(prefix)})).sha256:
     hash(prefix);
    fingerprint.update(lengthPrefix(chapterHash));
    if(visit){
     const key=state.bookId+'-'+index;
     const publish=(path:string,target:string,size:number,sha256:string)=>files.durableCommit(path,target,size,sha256);
     const t=await text.publish(key+'-text',publish),h=chapter.hasHtml?await html.publish(key+'-html',publish):null;
     check();
     await visit(header,{chapterIndex:index,title:chapter.title,url:chapter.url,chapterHash,content:h?.meaningful?h.value:t.value,html:h?.value??null,text:t.value});
    }
   }finally{for(const path of temporary)await files.remove(path).catch(()=>{});}
  }
  if(await json.bookChapter(()=>async()=>{})!==undefined)fail('BUSINESS_REJECTED');
  const digest=fingerprint.finish();
  if(digest!==state.fingerprint||await bookId(digest,async bytes=>hash(bytes),header.instanceId)!==state.bookId)fail('HASH_MISMATCH');
 }finally{await files.closeText(reader).catch(()=>{});}
}
