import {memoPlainText} from './text.ts';
import {noteFence} from './preview.ts';
export interface NoteTextRow {text:string;role:'body'|'heading'|'quote'|'code';size:number;lineHeight:number;sourceMarkup:string;sourceStart:number;mappingText:string;mappingStart:number}
export function noteImageSource(path:string):{url:string;filePath?:string}{return path.startsWith('assets/')?{url:path,filePath:'notes/'+path}:{url:path};}
/** Compose Image uses the intrinsic aspect ratio within its 96–260 dp height bound. */
export function noteImageDisplayHeight(width:number,imageWidth:number,imageHeight:number):number {
 if(!Number.isFinite(width)||!Number.isFinite(imageWidth)||!Number.isFinite(imageHeight)||width<=0||imageWidth<=0||imageHeight<=0)return 260;
 return Math.max(96,Math.min(260,width*imageHeight/imageWidth));
}
/** Native table cells only unwrap inline-code delimiters; other Markdown stays literal. */
export function noteTableCellPresentation(markdown:string):{text:string;codes:{start:number;end:number}[]}{
 let text='',cursor=0;const codes:{start:number;end:number}[]=[];
 for(const match of markdown.matchAll(/`([^`\n]+)`/g)){
  text+=markdown.slice(cursor,match.index);
  const start=text.length;text+=match[1];codes.push({start,end:text.length});
  cursor=match.index!+match[0].length;
 }
 text+=markdown.slice(cursor);
 return {text,codes};
}
export function noteTableCellText(markdown:string):string{return noteTableCellPresentation(markdown).text;}
export function noteTableCodeFragments(lines:readonly string[],codes:readonly {start:number;end:number}[]):{line:number;start:number;text:string}[]{
 const fragments:{line:number;start:number;text:string}[]=[];let offset=0;
 lines.forEach((text,line)=>{
  for(const code of codes){
   const start=Math.max(offset,code.start),end=Math.min(offset+text.length,code.end);
   if(start<end)fragments.push({line,start:start-offset,text:text.slice(start-offset,end-offset)});
  }
  offset+=text.length;
 });
 return fragments;
}
/** Readable block typography; full native inline span styling is a separate layer. */
export function noteTextRows(markup:string,html:boolean):NoteTextRow[]{
 if(html){const plain=memoPlainText(markup);let start=0;return plain.split('\n').map(text=>{const row={text,role:'body' as const,size:14,lineHeight:20,sourceMarkup:markup,sourceStart:0,mappingText:plain,mappingStart:start};start+=text.length+1;return row;});}
 const result:NoteTextRow[]=[];let fence:ReturnType<typeof noteFence>=null,sourceStart=0;
 for(const line of markup.replace(/\r\n?/g,'\n').split('\n')){
  const start=sourceStart;sourceStart+=line.length+1;
  const marker=noteFence(line);if(fence){if(marker&&marker.marker===fence.marker&&marker.length>=fence.length){fence=null;continue;}result.push({text:line,role:'code',size:13,lineHeight:19,sourceMarkup:line,sourceStart:start,mappingText:line,mappingStart:0});continue;}if(marker){fence=marker;continue;}
  const heading=/^(#{1,6})[ \t]+(.*)$/.exec(line),quote=/^>[ \t]?(.*)$/.exec(line),bullet=/^\s*[-*+] (.*)$/.exec(line),ordered=/^\s*(\d+)\. (.*)$/.exec(line);
  const role=heading?'heading':quote?'quote':'body',size=heading?Math.max(15,23-heading[1].length*2):14;
  const text=heading?memoPlainText(heading[2]):quote?memoPlainText(quote[1]):bullet?'• '+memoPlainText(bullet[1]):ordered?ordered[1]+'. '+memoPlainText(ordered[2]):memoPlainText(line);
  result.push({text,role,size,lineHeight:size+6,sourceMarkup:line,sourceStart:start,mappingText:text,mappingStart:0});
 }
 return result;
}
