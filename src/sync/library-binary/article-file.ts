import {MAX_BODY_JSON_BYTES} from '../article-body';
import type {StagedArticleBody} from '../article-receiver';
import type {BinaryAssetFiles} from './assets';
import {fail,hash,utf8,type ObjectDescriptor} from './wire';

export interface BinaryArticleFiles extends BinaryAssetFiles {
 gunzip(path:string,maxOutputBytes:number,allowPlain:boolean):Promise<{path:string;size:number}>;
 openText(path:string,options:{strictUtf8:true}):Promise<{id:string}>;
 readTextChunk(id:string,maxChars:number):Promise<{text:string;eof:boolean;invalidUtf8:boolean}>;
 closeText(id:string):Promise<unknown>;
}

type TextSink=(text:string)=>Promise<void>;
const whitespace=/[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const nonblank=/[^\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const escaped:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};

/** Parse the original body grammar while retaining at most one input chunk
 * and one decoded string chunk. Unknown fields are checked and discarded. */
export class BodyJsonReader {
 private input='';
 private at=0;
 private eof=false;
 constructor(private readonly read:()=>Promise<{text:string;eof:boolean;invalidUtf8:boolean}>,private readonly lineMode=false){}
 private async more(){
  if(this.at<this.input.length)return true;
  if(this.eof)return false;
  const part=await this.read();
  if(part.invalidUtf8||!part.text&&!part.eof)fail('BUSINESS_REJECTED');
  this.input=part.text;this.at=0;this.eof=part.eof;
  return this.input.length>0;
 }
 private async peek(){return await this.more()?this.input[this.at]!:'';}
 private async next(){const char=await this.peek();if(!char)fail('BUSINESS_REJECTED');this.at++;return char;}
 private async ws(){while(await this.more()){while(this.at<this.input.length&&(this.lineMode?/^[ \t]$/:whitespace).test(this.input[this.at]!))this.at++;if(this.at<this.input.length)return;}}
 private async expect(char:string){await this.ws();if(await this.next()!==char)fail('BUSINESS_REJECTED');}
 private async literal(value:string){for(const char of value)if(await this.next()!==char)fail('BUSINESS_REJECTED');}
 private async string(sink?:TextSink){
  await this.expect('"');
  const special=/["\\\u0000-\u001f]/g;
  let decoded='';
  while(await this.more()){
   special.lastIndex=this.at;
   const match=special.exec(this.input);
   if(sink)decoded+=this.input.slice(this.at,match?.index??this.input.length);
   this.at=match?match.index+1:this.input.length;
   if(match){
    if(match[0]==='"'){if(sink&&decoded)await sink(decoded);return;}
    if(match[0]!=='\\')fail('BUSINESS_REJECTED');
    const code=await this.next();
    if(code==='u'){
     let digits='';for(let i=0;i<4;i++)digits+=await this.next();
     if(!/^[\da-fA-F]{4}$/.test(digits))fail('BUSINESS_REJECTED');
     if(sink)decoded+=String.fromCharCode(parseInt(digits,16));
    }else{
     if(!Object.hasOwn(escaped,code))fail('BUSINESS_REJECTED');
     if(sink)decoded+=escaped[code]!;
    }
   }
   if(sink&&decoded.length>=8192){await sink(decoded);decoded='';}
  }
  fail('BUSINESS_REJECTED');
 }
 private async digits(){
  let found=false;
  while(await this.more()){
   const start=this.at;
   while(this.at<this.input.length&&/[0-9]/.test(this.input[this.at]!))this.at++;
   found||=this.at!==start;
   if(this.at<this.input.length)break;
  }
  return found;
 }
 private async number(){
  if(await this.peek()==='-')this.at++;
  if(await this.peek()==='0')this.at++;
  else if(!await this.digits())fail('BUSINESS_REJECTED');
  if(await this.peek()==='.'){this.at++;if(!await this.digits())fail('BUSINESS_REJECTED');}
  if(/^[eE]$/.test(await this.peek())){
   this.at++;if(/^[+-]$/.test(await this.peek()))this.at++;
   if(!await this.digits())fail('BUSINESS_REJECTED');
  }
 }
 private async skip(depth=0):Promise<void>{
  if(depth>128)fail('BUSINESS_REJECTED');await this.ws();
  const char=await this.peek();
  if(char==='"')return this.string();
  if(char==='t'||char==='f'||char==='n')return this.literal(char==='t'?'true':char==='f'?'false':'null');
  if(char!=='{'&&char!=='[')return this.number();
  this.at++;const end=char==='{'?'}':']';
  await this.ws();
  if(await this.peek()!==end)while(true){
   if(char==='{'){await this.string();await this.expect(':');}
   await this.skip(depth+1);await this.ws();
   if(await this.peek()===end)break;
   await this.expect(',');
  }
  this.at++;
 }
 async line():Promise<string>{
  let line='';
  while(await this.more()){
   const newline=this.input.indexOf('\n',this.at);
   const end=newline<0?this.input.length:newline;
   if(line.length+end-this.at>65536)fail('BUSINESS_REJECTED');
   line+=this.input.slice(this.at,end);this.at=end+(newline<0?0:1);
   if(newline>=0)return line;
  }
  return fail('BUSINESS_REJECTED');
 }
 async bookChapter(sink:(name:'contentHtml'|'contentText')=>TextSink):Promise<{chapterIndex:number;title:string;url:string;hasHtml:boolean}|undefined>{
  if(!await this.peek())return;
  await this.expect('{');await this.ws();
  const keys=new Set<string>();let title:string|undefined,url:string|undefined,index:number|undefined,hasHtml:boolean|undefined;
  while(await this.peek()!=='}'){
   let key='';
   await this.string(async value=>{if(key.length+value.length>128)fail('BUSINESS_REJECTED');key+=value;});
   if(keys.has(key)||keys.size>=32)fail('BUSINESS_REJECTED');
   keys.add(key);await this.expect(':');await this.ws();
   switch(key){
    case 'title':case 'url': {
     let text='';
     await this.string(async part=>{if(text.length+part.length>16384)fail('BUSINESS_REJECTED');text+=part;});
     if(key==='title')title=text;else url=text;
     break;
    }
    case 'chapterIndex': {
     let digits='';
     while(/[0-9]/.test(await this.peek())){
      if(digits.length===6)fail('BUSINESS_REJECTED');
      digits+=await this.next();
     }
     if(!/^[1-9][0-9]*$/.test(digits))fail('BUSINESS_REJECTED');
     index=Number(digits);break;
    }
    case 'contentHtml':
     hasHtml=await this.peek()!=='n';
     if(hasHtml)await this.string(sink(key));else await this.literal('null');
     break;
    case 'contentText':await this.string(sink(key));break;
    default:await this.skip();
   }
   await this.ws();
   if(await this.peek()==='}')break;
   await this.expect(',');await this.ws();
   if(await this.peek()==='}')fail('BUSINESS_REJECTED');
  }
  await this.expect('}');await this.ws();
  if(await this.next()!=='\n'||title===undefined||url===undefined||index===undefined||hasHtml===undefined||!keys.has('contentText'))fail('BUSINESS_REJECTED');
  return {chapterIndex:index,title,url,hasHtml};
 }
 async fields(sink:(name:'contentHtml'|'contentText')=>TextSink):Promise<{html:boolean;text:boolean}>{
  await this.expect('{');await this.ws();
  const seen=new Set<string>();let html=false,text=false;
  if(await this.peek()!=='}')while(true){
   let key='',known=true;
   await this.string(async value=>{if(key.length+value.length>11)known=false;else if(known)key+=value;});
   await this.expect(':');await this.ws();
   if(known&&(key==='contentHtml'||key==='contentText')){
    if(seen.has(key))fail('BUSINESS_REJECTED');seen.add(key);
    const present=await this.peek()!=='n';
    if(present)await this.string(sink(key));else await this.literal('null');
    if(key==='contentHtml')html=present;else text=present;
   }else await this.skip();
   await this.ws();if(await this.peek()==='}')break;await this.expect(',');
  }
  await this.expect('}');await this.ws();if(await this.peek()||!seen.has('contentText'))fail('BUSINESS_REJECTED');
  return {html,text};
 }
}

export class TextFile {
 private offset=0;
 private readonly buffer=new Uint8Array(65536);
 private buffered=0;
 private surrogate='';
 private meaningful=false;
 constructor(readonly path:string,private readonly files:BinaryAssetFiles,private readonly work:()=>void){}
 async append(value:string,done=false){
  this.meaningful||=nonblank.test(value);
  let text=this.surrogate+value;this.surrogate='';
  const tail=text.charCodeAt(text.length-1);
  if(!done&&tail>=0xd800&&tail<=0xdbff){this.surrogate=text.slice(-1);text=text.slice(0,-1);}
  // Write UTF-8 directly into the file buffer. Java's original body writer
  // substitutes '?' for an unpaired UTF-16 surrogate.
  for(let i=0;i<text.length;i++){
   let code=text.charCodeAt(i);
   if(code>=0xd800&&code<=0xdbff){
    const low=text.charCodeAt(i+1);
    if(low>=0xdc00&&low<=0xdfff){code=0x10000+((code-0xd800)<<10)+low-0xdc00;i++;}
    else code=63;
   }else if(code>=0xdc00&&code<=0xdfff)code=63;
   if(this.buffered+4>this.buffer.length)await this.flush();
   const bytes=this.buffer;
   if(code<0x80)bytes[this.buffered++]=code;
   else if(code<0x800){
    bytes[this.buffered++]=0xc0|(code>>6);
    bytes[this.buffered++]=0x80|(code&63);
   }else if(code<0x10000){
    bytes[this.buffered++]=0xe0|(code>>12);
    bytes[this.buffered++]=0x80|((code>>6)&63);
    bytes[this.buffered++]=0x80|(code&63);
   }else{
    bytes[this.buffered++]=0xf0|(code>>18);
    bytes[this.buffered++]=0x80|((code>>12)&63);
    bytes[this.buffered++]=0x80|((code>>6)&63);
    bytes[this.buffered++]=0x80|(code&63);
   }
  }
 }
 private async flush(){
  if(!this.buffered)return;
  const result=await this.files.appendBytes(this.path,this.buffer.subarray(0,this.buffered),this.offset);
  this.offset+=this.buffered;
  if(result.size!==this.offset)fail('LOCAL_IO');
  this.buffered=0;this.work();
 }
 async finish():Promise<number>{
  await this.append('',true);await this.flush();
  return this.offset;
 }
 async publish(key:string,commit?:(path:string,target:string,size:number,sha256:string)=>Promise<{path:string}>){
  await this.finish();
  if(!this.offset)return {value:'',bytes:0,meaningful:false};
  const verified=await this.files.hash(this.path);this.work();
  if(verified.size!==this.offset)fail('LOCAL_IO');
  const name='v2-'+hash(utf8(key))+'-'+verified.sha256+'.txt';
  const target='article_content/'+name;
  if((await (commit?commit(this.path,target,this.offset,verified.sha256):this.files.commit(this.path,target,this.offset,verified.sha256))).path!==target)fail('LOCAL_IO');
  this.work();
  return {value:'watchrss-watch-content:'+name,bytes:this.offset,meaningful:this.meaningful};
 }
}

export async function importArticleFile(files:BinaryArticleFiles,path:string,d:ObjectDescriptor,
 legacyHashes:readonly string[],work:()=>void):Promise<StagedArticleBody>{
 // Native finalize has already verified the outer full hash. The inherited
 // v14 index is independent and covers pairs of consecutive B2 blocks.
 const bytes=new Uint8Array(Math.min(131072,d.size));
 for(let offset=0,index=0;offset<d.size;offset+=131072,index++){
  const block=bytes.subarray(0,Math.min(131072,d.size-offset));
  for(let at=0;at<block.length;at+=65536){
   const size=Math.min(65536,block.length-at),read=await files.readBytes(path,offset+at,size);
   if(read.size!==d.size||read.bytes.length!==size)fail('HASH_MISMATCH');
   block.set(read.bytes,at);work();
  }
  if(hash(block)!==legacyHashes[index])fail('HASH_MISMATCH');
 }
 const decoded=await files.gunzip(path,MAX_BODY_JSON_BYTES,true);
 let reader:string|undefined;const temporary:string[]=[];
 try{
  work();
  if(decoded.size>MAX_BODY_JSON_BYTES)fail('BUSINESS_REJECTED');
  const create=async()=>{
   const file=(await files.createTemp('article_content')).path;temporary.push(file);
   return new TextFile(file,files,work);
  };
  const html=await create(),text=await create();
  reader=(await files.openText(decoded.path,{strictUtf8:true})).id;
  const json=new BodyJsonReader(async()=>{const part=await files.readTextChunk(reader!,16384);work();return part;});
  const fields=await json.fields(name=>value=>(name==='contentHtml'?html:text).append(value));
  const h=fields.html?await html.publish(d.businessId+'-html'):null;
  const t=fields.text?await text.publish(d.businessId+'-text'):null;
  const main=h?.meaningful?h:t?.meaningful?t:null;
  return {html:h?.value??null,text:t?.value??'',content:main?.value??null,contentBytes:main?.bytes??0};
 }finally{
  if(reader)await files.closeText(reader).catch(()=>{});
  for(const file of temporary)await files.remove(file).catch(()=>{});
  if(decoded.path!==path)await files.remove(decoded.path).catch(()=>{});
 }
}
