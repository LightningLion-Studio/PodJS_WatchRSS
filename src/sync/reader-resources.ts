import {decodeChunkData,encodeChunkData,type JsonObject} from './protocol.ts';
import {wireFields} from './article-batches.ts';
import {parseWireJson} from './wire-json.ts';
import {readerRequiredString as string,readerRequiredInt as int,readerRequiredLong as long,type ReaderManifest} from './reader-manifest.ts';
export const READER_CHUNK_BYTES=1024*1024;
export interface ReaderResourceFiles {
 stat(path:string):Promise<{file:boolean;size:number}>;
 read(path:string,offset:number,maxBytes:number):Promise<Uint8Array>;
 write(path:string,data:Uint8Array):Promise<void>;
 append(path:string,data:Uint8Array,offset:number):Promise<void>;
 truncate(path:string,size:number):Promise<void>;
 remove(path:string):Promise<void>;
 hash(path:string):Promise<{size:number;sha256:string}>;
 commit(path:string,target:string,size:number,sha256:string):Promise<unknown>;
 digest(data:Uint8Array):Promise<string>;
}
const directories={font:'fonts',background:'backgrounds',variant:'variants'} as const;
export function readerResourcePath(kind:string,fileName:string):string {
 if(!(kind in directories)||!Object.hasOwn(directories,kind))throw Error('未知资源类型');
 if(!wireFields.trim(fileName)||fileName.includes('/')||fileName.includes('\\')||fileName.includes('..'))throw Error(kind==='font'?'字体文件名无效':kind==='background'?'背景文件名无效':'背景派生文件名无效');
 return 'reader_assets/'+directories[kind as keyof typeof directories]+'/'+fileName;
}
export class ReaderResources {
 constructor(private readonly files:ReaderResourceFiles){}
 private async valid(path:string,size:number,hash:string){const info=await this.files.stat(path);if(!info.file||info.size!==size)return false;return (await this.files.hash(path)).sha256.toLowerCase()===hash.toLowerCase();}
 async missing(snapshot:ReaderManifest):Promise<JsonObject[]> {
  const result:JsonObject[]=[];
  const check=async(kind:string,fileName:string,sha256:string,byteCount:number)=>{let valid=false;try{valid=await this.valid(readerResourcePath(kind,fileName),byteCount,sha256);}catch(error){if(wireFields.trim(fileName)&&!fileName.includes('/')&&!fileName.includes('\\')&&!fileName.includes('..'))throw error;}
   if(!valid)result.push({kind,fileName,sha256,byteCount});};
  for(const row of snapshot.fonts)if(!row.deleted)await check('font',String(row.fileName),String(row.sha256),Number(row.byteCount));
  for(const row of snapshot.backgrounds)if(!row.deleted){await check('background',String(row.masterFileName),String(row.sha256),Number(row.byteCount));let variants:JsonObject={};try{variants=parseWireJson(String(row.variantsJson));}catch{}
   for(const key of ['watch','watchPoster']){const v=wireFields.object(variants[key]);if(!v)continue;const name=v.fileName===undefined?'':wireFields.string(v.fileName),hash=v.sha256===undefined?'':wireFields.string(v.sha256),bytes=wireFields.optLong(v.byteCount,0);if(wireFields.trim(name)&&hash.length===64&&bytes>=0)await check('variant',name,hash,bytes);}
  }
  return result;
 }
 async push(request:JsonObject):Promise<JsonObject>{
  const kind=string(request,'kind'),name=string(request,'fileName'),hash=string(request,'sha256'),size=long(request,'totalBytes');if(size<0||size>512*1024*1024)throw Error('阅读器资源大小异常');
  const index=int(request,'chunkIndex'),count=int(request,'chunkCount');if(index<0||index>=count||count<=0)throw Error('资源分块序号异常');
  const data=decodeChunkData(string(request,'data'));if(data.length>READER_CHUNK_BYTES)throw Error('资源分块过大');const chunkHash=await this.files.digest(data);if(chunkHash!==string(request,'chunkSha256'))throw Error('资源分块校验失败');
  const target=readerResourcePath(kind,name),part=target+'.part',metadata=part+'.meta';
  const ack=(applied:boolean)=>({success:true,action:'syncReader',phase:'pushResource',received:true,applied,chunkIndex:index,chunkSha256:chunkHash});
  if(await this.valid(target,size,hash))return ack(true);
  const signature=hash+':'+size+':'+count;let saved='';
  if((await this.files.stat(metadata)).file){const bytes=await this.files.read(metadata,0,4096);saved=String.fromCharCode(...bytes);}
  if(saved!==signature){if(index!==0)throw Error('资源传输已变化，请从第一块重试');await this.files.remove(part);await this.files.write(metadata,Uint8Array.from(signature,c=>c.charCodeAt(0)));}
  const offset=index*READER_CHUNK_BYTES,end=offset+data.length;if(offset>size||end>size)throw Error('资源分块范围异常');
  const info=await this.files.stat(part);if(!info.file)await this.files.write(part,new Uint8Array());
  if(info.size<offset)throw Error('资源分块顺序不连续');
  if(info.size>=end){const old=await this.files.read(part,offset,data.length);if(old.length!==data.length||old.some((b,i)=>b!==data[i])){if(index!==0)throw Error('资源分块内容冲突，请从第一块重试');await this.files.write(part,data);}}
  else{if(info.size!==offset)await this.files.truncate(part,offset);await this.files.append(part,data,offset);}
  const complete=index===count-1;
  if(complete){if(!await this.valid(part,size,hash))throw Error('资源完整校验失败');await this.files.commit(part,target,size,hash);await this.files.remove(metadata);}
  return ack(complete);
 }
 async pull(request:JsonObject):Promise<JsonObject>{
  const kind=string(request,'kind'),name=string(request,'fileName');let path:string;try{path=readerResourcePath(kind,name);}catch{throw Error('资源不存在');}
  const info=await this.files.stat(path);if(!info.file)throw Error('资源不存在');const index=int(request,'chunkIndex'),offset=index*READER_CHUNK_BYTES;
  if(offset<0||!(offset<info.size||offset===0&&info.size===0))throw Error('资源分块越界');
  const count=Math.min(READER_CHUNK_BYTES,info.size-offset),data=await this.files.read(path,offset,count);if(data.length!==count)throw Error('资源读取不完整');
  return {success:true,action:'syncReader',phase:'pullResource',kind,fileName:name,totalBytes:info.size,chunkIndex:index,chunkCount:Math.max(1,Math.ceil(info.size/READER_CHUNK_BYTES)),chunkSha256:await this.files.digest(data),data:encodeChunkData(data)};
 }
}
