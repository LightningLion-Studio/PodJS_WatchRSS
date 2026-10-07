import {encodeUtf8} from '@podjs/framework/bytes';
/** Native FileArticleContentStore v2 naming and Java UTF-8 encoding. */
export interface ImportedTextWritePort {
  createTemp(directory:string):Promise<{path:string}>;
  write(path:string,bytes:Uint8Array):Promise<{size:number}>;
  append(path:string,bytes:Uint8Array,expectedOffset:number):Promise<{size:number}>;
  hash(path:string):Promise<{size:number;sha256:string}>;
  commit(path:string,target:string,expectedSize:number,expectedSha256:string):Promise<{path:string;size:number;sha256:string;reused:boolean}>;
  remove(path:string):Promise<void>;
}
const DIRECTORY="article_content";
const MAX_CHARS=32768;
/** Unlike TextEncoder, Java encodes an unpaired UTF-16 surrogate as ASCII '?'. */
export function* javaUtf8Chunks(text:string):Generator<Uint8Array> {
  for(let start=0;start<text.length;){
    let end=Math.min(start+MAX_CHARS,text.length);
    if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff)end--;
    yield encodeUtf8(text.slice(start,end),'question');start=end;
  }
}
function checkedDigest(value:{size:number;sha256:string},size:number):string {
  if(value.size!==size||!Number.isSafeInteger(value.size)||!/^[0-9a-f]{64}$/.test(value.sha256))throw new Error("导入正文文件校验失败");
  return value.sha256;
}
export class ImportedTextWriter {
  constructor(private readonly files:ImportedTextWritePort) {}
  /** Returns a marker only after verified atomic publication. Does not update any DB row. */
  async storeText(articleId:string,text:string,cancelled:()=>boolean=()=>false):Promise<string>{
    const check=()=>{if(cancelled())throw new Error("导入正文写入已取消");};
    check();
    const {path}=await this.files.createTemp(DIRECTORY);
    try {
      if(!/^article_content\/\.pod-write-[A-Za-z0-9_-]+\.part$/.test(path))throw new Error("导入正文临时路径非法");
      // Reuse only the private temporary file for hashing the key, then the content.
      // This keeps both arbitrary-length inputs out of one oversized host request.
      const keySize=await this.write(path,articleId,check);check();
      const keyHash=checkedDigest(await this.files.hash(path),keySize);check();
      const size=await this.write(path,text,check);check();
      const hash=checkedDigest(await this.files.hash(path),size);check();
      const name=`v2-${keyHash}-${hash}.txt`;
      const target=`${DIRECTORY}/${name}`;
      const result=await this.files.commit(path,target,size,hash);
      if(result.path!==target||checkedDigest(result,size)!==hash)throw new Error("导入正文提交校验失败");
      // Cancellation after publication leaves an unreferenced immutable file;
      // a caller must not publish the marker into its transaction in that case.
      check();
      return `watchrss-watch-content:${name}`;
    } finally {
      await this.files.remove(path);
    }
  }
  private async write(path:string,text:string,check:()=>void):Promise<number>{
    check();const initial=await this.files.write(path,new Uint8Array());
    if(initial.size!==0)throw new Error("导入正文临时文件重置失败");
    let offset=0;
    for(const bytes of javaUtf8Chunks(text)){
      check();const result=await this.files.append(path,bytes,offset);
      offset+=bytes.length;
      if(result.size!==offset)throw new Error("导入正文分块写入失败");
    }
    return offset;
  }
}
