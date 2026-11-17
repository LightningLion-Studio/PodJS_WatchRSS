export type NoteAlignment='Start'|'Center'|'End';
export type NotePreviewBlock={kind:'rich';markup:string;html:boolean}|{kind:'image';path:string;description:string}|{kind:'table';rows:string[][];headerRows:number;alignments:NoteAlignment[]};
const trim=(s:string)=>s.replace(/^[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'');
const rich=(markup:string,html=false):NotePreviewBlock=>({kind:'rich',markup,html});
const pad=(row:string[],n:number)=>row.slice(0,n).concat(Array(Math.max(0,n-row.length)).fill(''));
import {noteCodeIndent,noteCodeLines} from './code';
export {noteFence,noteFenceCloses,noteCodeIndent} from './code';
export function isNoteRichHtml(markup:string){return ['color:','background:','text-align:','<img','<sub>','<sup>'].some(s=>markup.includes(s));}
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
function* tableBlockSteps(markup:string):Generator<void,NotePreviewBlock[]>{const code:Array<{kind:string;line:string}>=[];for(const row of noteCodeLines(markup)){yield;code.push(row);}const lines=code.map(r=>r.line),out:NotePreviewBlock[]=[];let buffer='';const append=(line:string)=>{if(buffer)buffer+='\n';buffer+=line;};const flush=()=>{if(buffer){out.push(rich(buffer));buffer='';}};
 for(let i=0;i<lines.length;){yield;const line=lines[i];if(code[i].kind!=='text'){append(line);i++;continue;}const found=parseTable(lines,i,code);if(found){flush();out.push(found.block);i=found.next;}else{append(line);i++;}}flush();return out;}
function* parseContentBlockSteps(markup:string,onBlock?:(block:NotePreviewBlock)=>void):Generator<void,NotePreviewBlock[]>{
 if(isNoteRichHtml(markup)){const out:NotePreviewBlock[]=[];let cursor=0;for(const m of markup.matchAll(/<img\b[^>]*>(?:[ \t\n\v\f\r]*<\/img>)?/gis)){yield;const before=markup.slice(cursor,m.index);if(trim(before))out.push(rich(before,true));const attr=(name:string)=>new RegExp('\\b'+name+'[ \\t\\n\\v\\f\\r]*=[ \\t\\n\\v\\f\\r]*["\x27]([^"\x27]*)["\x27]','is').exec(m[0])?.[1];const src=attr('src');out.push(src&&trim(src)?{kind:'image',path:src,description:attr('alt')??''}:rich(m[0],true));cursor=m.index!+m[0].length;}const tail=markup.slice(cursor);if(trim(tail))out.push(rich(tail,true));return out.length?out:[rich(markup,true)];}
 const out:NotePreviewBlock[]=[];let buffer='';const append=(block:NotePreviewBlock)=>{out.push(block);onBlock?.(block);};const flush=function*():Generator<void,void>{if(buffer){for(const block of yield* tableBlockSteps(buffer))append(block);buffer='';}};
 for(const row of noteCodeLines(markup)){yield;const line=row.line;if(row.kind!=='text'){if(buffer)buffer+='\n';buffer+=line;continue;}const images=[...line.matchAll(/!\[([^\]]*)\]\(([^) \t\n\v\f\r]+)(?:[ \t\n\v\f\r]+["'][^"']*["'])?\)/g)];if(!images.length){if(buffer)buffer+='\n';buffer+=line;continue;}let cursor=0;for(const image of images){buffer+=line.slice(cursor,image.index);yield* flush();append({kind:'image',path:image[2].replace(/%20/g,' '),description:image[1]});cursor=image.index!+image[0].length;}buffer+=line.slice(cursor);}yield* flush();return out;
}
// Split fenced source before the rich-HTML detector can interpret its tags.
function* parseBlockSteps(markup:string,onBlock?:(block:NotePreviewBlock)=>void):Generator<void,NotePreviewBlock[]>{
 if(!isNoteRichHtml(markup))return yield* parseContentBlockSteps(markup,onBlock);
 const out:NotePreviewBlock[]=[];let lines:string[]=[],literal=false;
 const emit=(block:NotePreviewBlock)=>{out.push(block);onBlock?.(block);};
 const flush=function*(literal:boolean):Generator<void,void>{
  if(!lines.length)return;
  const source=lines.join('\n');lines=[];
  if(literal)emit(rich(source));
  else for(const block of yield* parseContentBlockSteps(source))emit(block);
 };
 for(const row of noteCodeLines(markup)){
  yield;const code=row.kind!=='text';
  if(code!==literal){yield* flush(literal);literal=code;}
  lines.push(row.line);
  if(row.kind==='close'||code&&!row.fenced){yield* flush(true);literal=false;}
 }
 yield* flush(literal);return out;
}
function chunkMarkdown(markup:string,max:number):string[]{const out:string[]=[];let buffer='';const flush=()=>{if(buffer){out.push(buffer.replace(/\n+$/,''));buffer='';}};for(const row of noteCodeLines(markup)){const line=row.line,inside=row.fenced&&row.kind!=='open',len=line.length+(buffer?1:0);if(!inside&&buffer&&buffer.length+len>max)flush();if(buffer)buffer+='\n';buffer+=line;if((!row.fenced||row.kind==='close')&&!trim(line)&&buffer.length>=Math.trunc(max/2))flush();}flush();return out.length?out:[markup];}
export function* prepareNotePreviewSteps(markup:string,max=1200,onPrefix?:(blocks:NotePreviewBlock[])=>void):Generator<void,NotePreviewBlock[]>{
 if(max<=0)throw new Error('Invalid note chunk size');
 const expand=(b:NotePreviewBlock)=>b.kind==='rich'&&!b.html&&b.markup.length>max?chunkMarkdown(b.markup,max).map(s=>rich(s)):[b];
 const prefix:NotePreviewBlock[]=[];let published=false;
 const blocks=yield* parseBlockSteps(markup,onPrefix?block=>{if(published)return;prefix.push(...expand(block));if(prefix.length>=2){published=true;onPrefix(prefix.slice());}}:undefined),result:NotePreviewBlock[]=[];
 for(const b of blocks){yield;result.push(...expand(b));}return result;
}
export function prepareNotePreview(markup:string,max=1200):NotePreviewBlock[]{const steps=prepareNotePreviewSteps(markup,max);for(;;){const next=steps.next();if(next.done)return next.value;}}
export function noteBlockSourceOffsets(markup:string,blocks:readonly NotePreviewBlock[]):(number|null)[]{let from=0;return blocks.map(b=>{if(b.kind!=='rich')return null;const offset=markup.indexOf(b.markup,from);if(offset>=0)from=offset+b.markup.length;return offset>=0?offset:null;});}
