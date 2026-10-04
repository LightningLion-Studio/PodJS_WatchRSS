import type {JsonObject} from './protocol.ts';
import {wireFields} from './article-batches.ts';
const CHUNK_BYTES=512*1024;
export interface NoteAssetFiles {
 stat(path:string):Promise<{file:boolean;size:number}>;
 hash(path:string):Promise<{sha256:string;size:number}>;
 remove(path:string):Promise<void>;
 write(path:string,dataBase64:string):Promise<{size:number}>;
 append(path:string,dataBase64:string,offset:number):Promise<{size:number}>;
 commit(path:string,target:string,size:number,sha256:string):Promise<unknown>;
}
const result=(complete:boolean,alreadyPresent=false)=>({success:true,action:'syncNoteAsset',complete,alreadyPresent});
function required(request:JsonObject,key:string):string{if(request[key]===undefined||request[key]===null)throw new Error('缺少 '+key);return wireFields.string(request[key]);}
/** Ordered native note-asset protocol, retaining the old target until validated commit. */
export class NoteAssetReceiver {
 private queue:Promise<unknown>=Promise.resolve();
 constructor(private readonly files:NoteAssetFiles){}
 apply(request:JsonObject):Promise<JsonObject>{const job=this.queue.then(()=>this.receive(request));this.queue=job.catch(()=>{});return job;}
 private async receive(request:JsonObject):Promise<JsonObject>{
  if(wireFields.optInt(request,'version')!==1)throw new Error('不支持的备忘录图片同步版本');
  const key=required(request,'storageKey');if(key.length<1||key.length>160||!/^[A-Za-z0-9]/.test(key)||/[^A-Za-z0-9._-]/.test(key))throw new Error('备忘录图片文件名无效');
  const digest=required(request,'sha256').toLowerCase();if(digest.length!==64||!/^[0-9a-f]{64}$/.test(digest))throw new Error('备忘录图片校验值无效');
  const index=wireFields.optInt(request,'chunkIndex',-1),count=wireFields.optInt(request,'chunkCount',-1);
  if(count<=0||index<0||index>=count)throw new Error('备忘录图片分块序号无效');
  const target='notes/assets/'+key,part='notes/assets/.'+key+'.part';
  if((await this.files.stat(target)).file&&(await this.files.hash(target)).sha256.toLowerCase()===digest)return result(true,true);
  const offset=index*CHUNK_BYTES;
  if(index===0)await this.files.remove(part);
  else {const old=await this.files.stat(part);if(!old.file||old.size!==offset)throw new Error('备忘录图片分块顺序错误');}
  const data=required(request,'data');
  if(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.exec(data)?.[0]!==data)throw new Error('invalid base64 chunk data');
  const size=Math.floor(data.replace(/=+$/,'').length*6/8);if(size>CHUNK_BYTES)throw new Error('备忘录图片分块过大');
  // Each host write is below its 256 KiB limit; base64 boundaries encode 65535 bytes.
  let at=0,written=0;
  do{
   const piece=data.slice(at,at+87380),bytes=Math.floor(piece.replace(/=+$/,'').length*6/8);
   const value=index===0&&at===0?await this.files.write(part,piece):await this.files.append(part,piece,offset+written);
   written+=bytes;if(value.size!==offset+written)throw new Error('备忘录图片写入不完整');at+=piece.length;
  }while(at<data.length);
  const complete=index===count-1;
  if(complete){const actual=await this.files.hash(part);if(actual.sha256.toLowerCase()!==digest)throw new Error('备忘录图片校验失败');await this.files.commit(part,target,actual.size,digest);}
  return result(complete);
 }
}
