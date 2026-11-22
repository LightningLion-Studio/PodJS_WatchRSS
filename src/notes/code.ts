/** Shared lexical code boundaries for preview, table lookahead, editor and reader.
 * Container columns are removed only for code presentation; original source is
 * retained for storage/chunking and source anchors. This is not a full MD parser. */
type Container=number|'>';
interface Fence {marker:string;length:number;containers:Container[];indent:number}
export interface NoteCodeLine {line:string;sourceStart:number;text:string;offset:number;kind:'text'|'open'|'close'|'code';fenced:boolean;inheritsContainer:boolean}
export const noteCodeIndent=(line:string)=>/^ {4}/.test(line)?4:(/^ {0,3}\t/.exec(line)?.[0].length??0);
function strip(line:string,path:Container[]):number|null{
 let offset=0;
 for(const item of path){
  if(item==='>'){const m=/^ {0,3}>[ \t]?/.exec(line.slice(offset));if(!m)return null;offset+=m[0].length;}
  else{let columns=0;while(columns<item&&/[ \t]/.test(line[offset]??'!')){columns+=line[offset]==='\t'?4-columns%4:1;offset++;}if(columns<item&&line.slice(offset).trim())return null;}
 }
 return offset;
}
function context(line:string,path:Container[]=[]):{offset:number;path:Container[];inheritsContainer:boolean}{
 let offset=strip(line,path);
 const inheritsContainer=offset!==null&&path.length>0;
 if(offset===null){path=[];offset=0;}else path=path.slice();
 for(;;){
  const m=/^ {0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(line.slice(offset));if(!m)break;
  path.push(m[0].trimStart()[0]==='>'?'>':m[0].length);offset+=m[0].length;
 }
 return{offset,path,inheritsContainer};
}
function opener(line:string,ctx:ReturnType<typeof context>):Fence|null{
 const m=/^( {0,3})(`{3,}|~{3,})([^]*)$/.exec(line.slice(ctx.offset));
 return m&&!(m[2][0]==='`'&&m[3].includes('`'))?{marker:m[2][0],length:m[2].length,containers:ctx.path,indent:m[1].length}:null;
}
export function noteFence(line:string):Fence|null{return opener(line,context(line));}
export function noteFenceCloses(line:string,fence:Fence):boolean{
 const offset=strip(line,fence.containers);if(offset===null)return false;
 const m=/^ {0,3}(`+|~+)[ \t]*$/.exec(line.slice(offset));
 return !!m&&m[1][0]===fence.marker&&m[1].length>=fence.length;
}
export function* noteCodeLines(markup:string):Generator<NoteCodeLine>{
 let fence:Fence|null=null,path:Container[]=[];
 let nextStart=0;
 for(const line of markup.split(/\r\n?|\n/)){
  const sourceStart=nextStart,end=sourceStart+line.length;
  nextStart=end+(markup.startsWith('\r\n',end)?2:1);
  if(fence){
   const from=strip(line,fence.containers);
   if(from!==null){
    const close=noteFenceCloses(line,fence);let offset=from;
    for(let n=0;n<fence.indent&&line[offset]===' ';n++)offset++;
    yield{line,sourceStart,text:line.slice(offset),offset,kind:close?'close':'code',fenced:true,inheritsContainer:false};
    if(close)fence=null;continue;
   }
   fence=null;
  }
  const ctx=context(line,path);path=ctx.path;
  fence=opener(line,ctx);
  if(fence){yield{line,sourceStart,text:line.slice(ctx.offset),offset:ctx.offset,kind:'open',fenced:true,inheritsContainer:ctx.inheritsContainer};continue;}
  const indent=noteCodeIndent(line.slice(ctx.offset)),offset=ctx.offset+indent;
  yield{line,sourceStart,text:indent?line.slice(offset):line,offset:indent?offset:0,kind:indent?'code':'text',fenced:false,inheritsContainer:ctx.inheritsContainer};
 }
}
