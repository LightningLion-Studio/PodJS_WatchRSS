export const IMPORTED_TEXT_CHUNK_BYTES=16*1024;
const PREFIX="watchrss-watch-content:";
/** Native legacy and content-addressed v2 markers; never accept a path. */
export function importedTextFileName(marker:string|null|undefined):string|null {
  if(!marker?.startsWith(PREFIX))return null;
  const name=marker.slice(PREFIX.length);
  if(name.includes("/")||name.includes("\\")||name.includes(".."))return null;
  const match=/^(?:v2-[0-9a-f]{64}-[0-9a-f]{64}|[A-Za-z0-9._-]{1,96})\.txt$/.exec(name);
  return match?.[0]===name?name:null;
}
export interface ImportedTextFilePort {
  stat(path:string):Promise<{file:boolean;size:number}>;
  read(path:string,offset:number,maxBytes:number):Promise<Uint8Array>;
  decode?(bytes:Uint8Array):string;
  readText?(path:string,offset:number,maxBytes:number):Promise<{text:string;bytesRead:number}>;
}
export interface ImportedTextHandle { marker:string;byteLength:number;chunkBytes:number;chunkCount:number }
export class ImportedTextStore {
  constructor(private readonly files:ImportedTextFilePort) {}
  async handle(marker:string,chunkBytes=IMPORTED_TEXT_CHUNK_BYTES):Promise<ImportedTextHandle|null>{
    const name=importedTextFileName(marker);
    if(!name||!Number.isSafeInteger(chunkBytes)||chunkBytes<=0)return null;
    const stat=await this.files.stat(`article_content/${name}`).catch(()=>null);
    if(!stat)return null;
    if(!stat.file||!Number.isSafeInteger(stat.size)||stat.size<0)return null;
    return {marker,byteLength:stat.size,chunkBytes,chunkCount:Math.max(1,Math.ceil(stat.size/chunkBytes))};
  }
  private async boundary(path:string,requested:number,length:number):Promise<number>{
    let position=Math.max(0,Math.min(length,requested));
    if(position===0||position===length)return position;
    // Usually one four-byte probe. Continue backwards for malformed continuation runs
    // as the native RandomAccessFile implementation does, without reading the full file.
    while(position>0){
      const start=Math.max(0,position-3), bytes=await this.files.read(path,start,position-start+1);
      if(bytes.length!==position-start+1)throw new Error("导入正文在读取期间发生变化");
      for(let i=bytes.length-1;i>=0;i--){
        if((bytes[i]!&0xc0)!==0x80)return start+i;
        if(start+i===0)return 0;
      }
      position=start-1;
    }
    return 0;
  }
  async chunk(handle:ImportedTextHandle,index:number):Promise<string|null>{
    try { return await this.readChunk(handle,index); } catch { return null; }
  }
  private async readChunk(handle:ImportedTextHandle,index:number):Promise<string|null>{
    const name=importedTextFileName(handle.marker);
    if(!name||!Number.isSafeInteger(index)||index<0||!Number.isSafeInteger(handle.chunkBytes)||handle.chunkBytes<=0)return null;
    const nominalStart=index*handle.chunkBytes;
    if(!Number.isSafeInteger(nominalStart)||nominalStart>=handle.byteLength)return null;
    const path=`article_content/${name}`,start=await this.boundary(path,nominalStart,handle.byteLength),
      end=await this.boundary(path,Math.min(nominalStart+handle.chunkBytes,handle.byteLength),handle.byteLength);
    if(end<=start)return "";
    if(this.files.readText){
      const result=await this.files.readText(path,start,end-start);
      return result.bytesRead===end-start?result.text:null;
    }
    const bytes=await this.files.read(path,start,end-start);
    if(bytes.length!==end-start)throw new Error("导入正文在读取期间发生变化");
    if(!this.files.decode)throw new Error("导入正文解码服务不可用");
    return this.files.decode(bytes);
  }
}
