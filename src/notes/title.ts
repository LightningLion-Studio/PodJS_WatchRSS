/** Phone NoteTitle rule, applied only to a locally derived title. */
export function deriveNoteTitle(plainText:string):string {
 const line=plainText.split(/\r\n|\r|\n/).map(s=>s.trim()).find(s=>s.length>0);
 if(!line)return '';
 let first=-1,last=0,count=0;
 for(const [from,to] of wordRanges(line)){
  if(first<0)first=from;
  last=to;
  if(++count===3)break;
 }
 // Count Unicode code points on every runtime, including the Intl fallback.
 return Array.from(first<0?line:line.slice(first,last)).slice(0,80).join('');
}

function* wordRanges(line:string):Generator<[number,number]> {
 let segments:Iterable<{segment:string;index:number}>|undefined;
 try{
  if(typeof Intl!=='undefined'&&typeof Intl.Segmenter==='function')segments=new Intl.Segmenter('zh',{granularity:'word'}).segment(line);
 }catch(_){/* A runtime without Chinese word segmentation uses Unicode runs. */}
 const tokens=segments??unicodeSegments(line);
 for(const {segment,index} of tokens){
  if(!/[\p{L}\p{N}]/u.test(segment))continue;
  const chars=Array.from(segment);
  if(chars.length>4&&/^\p{Script=Han}+$/u.test(segment)){
   let from=index;
   for(let i=0;i<chars.length;i+=2){const to=from+chars.slice(i,i+2).join('').length;yield [from,to];from=to;}
  }else yield [index,index+segment.length];
 }
}

function* unicodeSegments(line:string){
 for(const match of line.matchAll(/[\p{L}\p{N}]+/gu))yield {segment:match[0],index:match.index!};
}
