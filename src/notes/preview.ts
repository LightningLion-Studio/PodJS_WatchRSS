export type NoteAlignment='Start'|'Center'|'End';
export type NotePreviewBlock={kind:'rich';markup:string;html:boolean}|{kind:'image';path:string;description:string}|{kind:'table';rows:string[][];headerRows:number;alignments:NoteAlignment[]};
const trim=(s:string)=>s.replace(/^[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'');
const rich=(markup:string,html=false):NotePreviewBlock=>({kind:'rich',markup,html});
const pad=(row:string[],n:number)=>row.slice(0,n).concat(Array(Math.max(0,n-row.length)).fill(''));
import {noteCodeIndent,noteCodeLines,type NoteCodeLine} from './code';
import {notePreviewPlainText} from './text';
export {noteFence,noteFenceCloses,noteCodeIndent} from './code';
export function isNoteRichHtml(markup:string){
 return (markup.includes('<')&&/^(?:[ \t]*[\r\n])* {0,3}<(?:p|div|ol|ul|h[1-6]|blockquote)(?=[\s>])/i.test(markup))
  || ['color:','background:','text-align:','<img','<sub>','<sup>'].some(s=>markup.includes(s));
}
function pipeRow(line:string):string[]|null{if(noteCodeIndent(line))return null;let s=trim(line);if(!s.includes('|'))return null;s=s.replace(/^\|/,'').replace(/\|$/,'');const cells:string[]=[];let cell='',escaped=false;for(const c of s){if(escaped){cell+=c;escaped=false;}else if(c==='\\')escaped=true;else if(c==='|'){cells.push(trim(cell));cell='';}else cell+=c;}if(escaped)cell+='\\';cells.push(trim(cell));return cells.length>=2?cells:null;}
const tabRow=(line:string)=>!line.includes('\t')||noteCodeIndent(line)?null:line.split('\t').map(trim);
function alignedRow(line:string):string[]|null{if(noteCodeIndent(line)||line.includes('\t'))return null;const s=trim(line);if(!s.includes('  '))return null;const cells=s.split(/ {2,}/).map(trim);return cells.length>=2&&cells.every(Boolean)?cells:null;}
function degradedRow(line:string,header:string[]):string[]|null{
 if(!trim(line)||noteCodeIndent(line)||line.includes('\t'))return null;const h=header.map(s=>trim(s).toLowerCase()),s=trim(line);let m:RegExpExecArray|null=null;
 if(h.slice(0,3).join('|')==='option|type|default')m=/^(`[^`]+`)[ \t\n\v\f\r]+([^ \t\n\v\f\r]+)[ \t\n\v\f\r]+(`[^`]+`|empty|[^ \t\n\v\f\r]+)[ \t\n\v\f\r]+(.+)$/.exec(s);
 else if(h[0]==='lua function'&&h[1]==='legacy dispatcher')m=/^(`[^`]+`)[ \t\n\v\f\r]+(`[^`]+`)[ \t\n\v\f\r]+(.+)$/.exec(s);
 else if(h.join('|')==='argument|accepted by|meaning')m=/^(`[^`]+`|No argument)[ \t\n\v\f\r]+((?:`[^`]+`(?:,[ \t\n\v\f\r]*)?)+(?:[ \t\n\v\f\r]+only)?)[ \t\n\v\f\r]+(.+)$/.exec(s);
 return m?pad(m.slice(1),header.length):null;
}
interface TableResult {block:Extract<NotePreviewBlock,{kind:'table'}>;next:number}
function table(rows:string[][],next:number,alignments?:NoteAlignment[]):TableResult{const n=Math.max(...rows.map(r=>r.length));return {block:{kind:'table',rows:rows.map(r=>pad(r,n)),headerRows:1,alignments:alignments??Array(n).fill('Start')},next};}
function parseTable(lines:string[],start:number,code:readonly {kind:string}[]):TableResult|null{
 const read=(i:number,fn:(line:string)=>string[]|null)=>i<lines.length&&code[i].kind==='text'?fn(lines[i]):null;
 const header=read(start,pipeRow),sep=start+1<lines.length?read(start+1,pipeRow):null;
 if(header&&sep&&header.length===sep.length&&sep.every(s=>/^:?-{3,}:?$/.test(s))){const rows=[header];let index=start+2;for(;index<lines.length;index++){const row=read(index,pipeRow);if(!row)break;rows.push(pad(row,header.length));}return table(rows,index,sep.map(s=>s.startsWith(':')&&s.endsWith(':')?'Center':s.endsWith(':')?'End':'Start'));}
 const first=read(start,tabRow);if(first){const rows=[first];let index=start+1;for(;index<lines.length;index++){const row=read(index,tabRow);if(!row)break;rows.push(row);}if(rows.length>=2||first.length>=3)return table(rows,index);}
 const aligned=read(start,alignedRow);if(!aligned||aligned.some(s=>s.length>64))return null;let index=start+1;if(index<lines.length&&!trim(lines[index]))index++;const rows=[aligned];
 for(;index<lines.length;index++){const next=read(index,alignedRow);const row=next?.length===aligned.length?next:read(index,line=>degradedRow(line,aligned))??next;if(!row)break;rows.push(row);}
 return rows.length>=2&&(aligned.length!==2||rows.length>=3)?table(rows,index):null;
}
function* tableBlockSteps(markup:string):Generator<void,NotePreviewBlock[]>{
 const code:NoteCodeLine[]=[];
 for(const row of noteCodeLines(markup)){yield;code.push(row);}
 const lines=code.map(row=>row.line),out:NotePreviewBlock[]=[];
 let start:number|undefined,end=0;
 const flush=()=>{if(start!==undefined){out.push(rich(markup.slice(start,end)));start=undefined;}};
 for(let i=0;i<lines.length;){
  yield;
  const row=code[i],found=row.kind==='text'?parseTable(lines,i,code):null;
  if(found){flush();out.push(found.block);i=found.next;continue;}
  if(start!==undefined||row.line){start??=row.sourceStart;end=row.sourceStart+row.line.length;}
  i++;
 }
 flush();return out;
}
// Keep HTML containers intact and bound the work in the first layout slice.
function* htmlPreviewChunks(markup:string,max:number):Generator<string|undefined> {
 const paragraphTags=/^(?:p|div|h[1-6]|blockquote|ol|ul|table|pre|section|article)$/i;
 const containers:string[]=[];
 let start=0,paragraphStart=0,length=0,paragraphs=0;
 for(const match of markup.matchAll(/<!--[^]*?-->|<(\/?)([a-z][a-z0-9-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)){
  yield;
  const [,closing,tag]=match;
  if(!tag||!paragraphTags.test(tag))continue;
  const name=tag.toLowerCase();
  if(!closing){
   if(!match[0].endsWith('/>'))containers.push(name);
   continue;
  }
  if(containers.at(-1)!==name)continue;
  containers.pop();
  if(containers.length)continue;

  const end=match.index+match[0].length;
  const visible=notePreviewPlainText(markup.slice(paragraphStart,end)).length;
  if(visible){
   if(paragraphs&&(length+visible>max||paragraphs===4)){
    yield markup.slice(start,paragraphStart);
    start=paragraphStart;length=0;paragraphs=0;
   }
   length+=visible;paragraphs++;
  }
  paragraphStart=end;
 }
 if(trim(markup.slice(start)))yield markup.slice(start);
}

function* parseHtmlSteps(markup:string,max:number,append:(block:NotePreviewBlock)=>void):Generator<void>{
 const appendText=function*(source:string){
  for(const chunk of htmlPreviewChunks(source,max)){
   if(chunk!==undefined)append(rich(chunk,true));
   yield;
  }
 };
 let cursor=0;
 for(const image of markup.matchAll(/<img\b[^>]*>(?:[ \t\n\v\f\r]*<\/img>)?/gis)){
  yield* appendText(markup.slice(cursor,image.index));
  const attr=(name:string)=>new RegExp('\\b'+name+'[ \\t\\n\\v\\f\\r]*=[ \\t\\n\\v\\f\\r]*["\x27]([^"\x27]*)["\x27]','is').exec(image[0])?.[1];
  const src=attr('src');
  append(src&&trim(src)?{kind:'image',path:src,description:attr('alt')??''}:rich(image[0],true));
  cursor=image.index+image[0].length;
  yield;
 }
 yield* appendText(markup.slice(cursor));
}

function* parseMarkdownSteps(markup:string,append:(block:NotePreviewBlock)=>void):Generator<void>{
 // Without a table or image marker, keep the source slice for editor anchors.
 if(!markup.includes('![')&&!/[|\t]| {2,}/.test(markup)){
  const source=markup.replace(/^(?:\r\n?|\n)+/,'');
  if(source)append(rich(source));
  return;
 }
 let buffer='',previousEnd=0;
 const flush=function*():Generator<void,void>{if(buffer){for(const block of yield* tableBlockSteps(buffer))append(block);buffer='';}};
 for(const row of noteCodeLines(markup)){
  yield;
  const line=row.line,lineBreak=markup.slice(previousEnd,row.sourceStart);
  previousEnd=row.sourceStart+line.length;
  const images=row.kind==='text'?[...line.matchAll(/!\[([^\]]*)\]\(([^) \t\n\v\f\r]+)(?:[ \t\n\v\f\r]+["'][^"']*["'])?\)/g)]:[];
  if(!images.length){if(buffer)buffer+=lineBreak;buffer+=line;continue;}
  let cursor=0;
  for(const image of images){
   buffer+=line.slice(cursor,image.index);yield* flush();
   append({kind:'image',path:image[2].replace(/%20/g,' '),description:image[1]});
   cursor=image.index!+image[0].length;
  }
  buffer+=line.slice(cursor);
 }
 yield* flush();
}
// Split fenced source before the rich-HTML detector can interpret its tags.
function* parseBlockSteps(markup:string,max:number,emit:(block:NotePreviewBlock)=>void):Generator<void>{
 if(!isNoteRichHtml(markup))return yield* parseMarkdownSteps(markup,emit);
 const flush=function*(start:number,end:number,literal:boolean):Generator<void,void>{
  const source=markup.slice(start,end);
  if(literal){emit(rich(source));return;}
  if(isNoteRichHtml(source))yield* parseHtmlSteps(source,max,emit);
  else yield* parseMarkdownSteps(source,emit);
 };
 let start=0,end=0,literal=false;
 for(const row of noteCodeLines(markup)){
  yield;
  const code=row.kind!=='text';
  if(code!==literal){if(start<end)yield* flush(start,end,literal);start=row.sourceStart;literal=code;}
  end=row.sourceStart+row.line.length;
  const cursor=end+(markup.startsWith('\r\n',end)?2:1);
  if(row.kind==='close'||code&&!row.fenced){yield* flush(start,end,true);start=cursor;literal=false;}
 }
 if(start<=end)yield* flush(start,end,literal);
}
function chunkMarkdown(markup:string,max:number):string[]{
 const out:string[]=[];
 let start=0,end=0,length=0,breakAfterBlank=false;
 for(const row of noteCodeLines(markup)){
  const line=row.line,blank=!trim(line);
  const insideFence=row.fenced&&row.kind!=='open';
  const visible=row.kind==='text'&&line.includes('<')?notePreviewPlainText(line).length:line.length;
  // Keep blank rows with the preceding chunk. A new chunk resets the code parser.
  if(row.sourceStart>start&&!blank&&!insideFence&&!row.inheritsContainer&&(breakAfterBlank||length+visible+1>max)){
   out.push(markup.slice(start,end));
   start=row.sourceStart;length=0;breakAfterBlank=false;
  }
  length+=visible+(row.sourceStart>start?1:0);
  end=row.sourceStart+line.length;
  if(blank&&!row.fenced&&length>=Math.trunc(max/2))breakAfterBlank=true;
 }
 out.push(markup.slice(start,end));
 return out;
}
export function* prepareNotePreviewSteps(markup:string,max=1200,onPrefix?:(blocks:NotePreviewBlock[])=>void):Generator<void,NotePreviewBlock[]>{
 if(max<=0)throw new Error('Invalid note chunk size');
 const expand=(b:NotePreviewBlock)=>b.kind==='rich'&&!b.html&&b.markup.length>max?chunkMarkdown(b.markup,max).map(s=>rich(s)):[b];
 const result:NotePreviewBlock[]=[];let published=false;
 yield* parseBlockSteps(markup,max,block=>{
  result.push(...expand(block));
  if(onPrefix&&!published&&result.length>=2){published=true;onPrefix(result.slice());}
 });
 return result;
}
export function prepareNotePreview(markup:string,max=1200):NotePreviewBlock[]{const steps=prepareNotePreviewSteps(markup,max);for(;;){const next=steps.next();if(next.done)return next.value;}}
export function noteBlockSourceOffsets(markup:string,blocks:readonly NotePreviewBlock[]):(number|null)[]{let from=0;return blocks.map(b=>{if(b.kind!=='rich')return null;const offset=markup.indexOf(b.markup,from);if(offset>=0)from=offset+b.markup.length;return offset>=0?offset:null;});}
