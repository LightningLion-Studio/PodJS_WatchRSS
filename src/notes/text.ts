import {noteHtmlEntities} from './html-entities';
import {deriveNoteTitle} from './title';
// Kotlin Char.isWhitespace includes the four ASCII information separators,
// and does not include JavaScript's BOM whitespace.
const whitespace='[\\u0009-\\u000d\\u001c-\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
export const trimNoteText=(value:string)=>value.replace(new RegExp('^'+whitespace+'+|'+whitespace+'+$','g'),'');
export function nativeEntities(value:string):string{
 // Jsoup consumes a whole named entity token before deciding whether it is
 // recognized; HTML's longest-prefix fallback would turn &notit; into ¬it;.
 return value.replace(/&(?:#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[A-Za-z]+[0-9]*;?)/g,token=>{
  if(token.startsWith('&#')){const hex=/^&#x/i.test(token),code=parseInt(token.slice(hex?3:2),hex?16:10);if(code===0||code>=0xd800&&code<=0xdfff)return String.fromCharCode(code);const c1:Record<number,number>={128:8364,130:8218,131:402,132:8222,133:8230,134:8224,135:8225,136:710,137:8240,138:352,139:8249,140:338,142:381,145:8216,146:8217,147:8220,148:8221,149:8226,150:8211,151:8212,152:732,153:8482,154:353,155:8250,156:339,158:382,159:376};return String.fromCodePoint(code>0x10ffff?0xfffd:c1[code]??code);}
  const key=token.slice(1);return Object.hasOwn(noteHtmlEntities,key)?noteHtmlEntities[key]:token;
 });
}
/** Native watchPlainText pipeline: selected HTML tags, HTML entities, Markdown. */
export function memoPlainText(value:string):string{return projectNoteText(value,false);}

export interface NoteHtmlPreviewContext {
 continuation?:boolean;
 list?:{numbers:ReadonlyMap<number,number>;sourceStart:number};
}

/** Preview keeps literal numbers and expands ordered HTML list markers. */
export function notePreviewPlainText(value:string,context?:NoteHtmlPreviewContext):string {
 let numbers=context?.list?.numbers;
 if(!numbers&&value.includes('<')&&/<ol\b/i.test(value)){
  const steps=noteHtmlListNumberSteps(value);
  let next=steps.next();
  while(!next.done)next=steps.next();
  numbers=next.value;
 }
 const sourceStart=context?.list?.sourceStart??0,ordinals=numbers;
 if(ordinals?.size){
  value=value.replace(listTags,(token,_closing,_name,index:number)=>{
   const number=ordinals.get(sourceStart+index);
   return number===undefined?token:`\n${number}. `;
  });
 }
 return projectNoteText(value,true,context?.continuation);
}

function listAttributes(tag:string):Map<string,string> {
 const attributes=new Map<string,string>();
 for(const [,name,doubleQuoted,singleQuoted,unquoted] of tag.slice(3,-1).matchAll(/[ \t\n\f\r]+([^ \t\n\f\r"'<>/=]+)(?:[ \t\n\f\r]*=[ \t\n\f\r]*(?:"([^"]*)"|'([^']*)'|([^ \t\n\f\r>]+)))?/g)){
  const key=name.toLowerCase();
  if(!attributes.has(key))attributes.set(key,doubleQuoted??singleQuoted??unquoted??'');
 }
 return attributes;
}

function listInteger(value:string|undefined):number|undefined {
 if(value===undefined||!/^[-+]?\d+$/.test(value))return undefined;
 const number=Number(value);
 return Number.isSafeInteger(number)?number:undefined;
}

const listTags=/<(\/?)(ol|ul|li)(?=[ \t\n\f\r/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;

/** Assign ordinals in the original source before images divide it into text fragments. */
export function* noteHtmlListNumberSteps(value:string):Generator<void,Map<number,number>> {
 interface List {step:number;start?:number;items:{index:number;value?:number}[]}
 const numbers=new Map<number,number>(),lists:(List|null)[]=[];
 const finish=function*(list:List|null|undefined){
  if(!list)return;
  let number=list.start??(list.step===-1?list.items.length:1);
  for(const item of list.items){
   number=item.value??number;
   numbers.set(item.index,number);
   number+=list.step;
   yield;
  }
 };
 for(const match of value.matchAll(listTags)){
  yield;
  const [,closing,name]=match,tag=name.toLowerCase();
  if(tag==='li'){
   if(!closing)lists.at(-1)?.items.push({index:match.index,value:listInteger(listAttributes(match[0]).get('value'))});
  }else if(closing){
   yield* finish(lists.pop());
  }else if(tag==='ul'){
   lists.push(null);
  }else{
   const attributes=listAttributes(match[0]);
   lists.push({start:listInteger(attributes.get('start')),step:attributes.has('reversed')?-1:1,items:[]});
  }
 }
 while(lists.length)yield* finish(lists.pop());
 return numbers;
}
// Title and preview projections retain ordered markers in the source.
function projectNoteText(value:string,preserveListNumbers:boolean,continuation=false):string{
 const html=value
  .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gis,'[图片：$1]')
  .replace(/<img\b[^>]*>/gis,'[图片]')
  .replace(/<br[ \t\n\v\f\r]*\/?>/gi,'\n')
  .replace(/<li(?:[ \t\n\v\f\r][^>]*)?>/gi,'- ')
  .replace(/<\/(?:p|div|h[1-6]|li|ul|ol|blockquote|table|tr)>/gi,'\n')
  .replace(/<\/?(?:p|div|span|b|strong|i|em|u|s|strike|del|ol|ul|li|br|h[1-6]|blockquote|code|a|img|mark|table|thead|tbody|tr|th|td)(?:[ \t\n\v\f\r][^>]*)?>/gi,'');
 const markdown=nativeEntities(html)
  .replace(/!\[([^\]]*)\]\([^)]*\)/g,'[图片：$1]')
  .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
  .replace(/^#{1,6}[ \t\n\v\f\r]+/gm,'')
  .replace(/^>[ \t\n\v\f\r]?/gm,'')
  .replace(preserveListNumbers?/^[ \t\n\v\f\r]*[-*+] /gm:/^[ \t\n\v\f\r]*(?:[-*+] |\d+\. )/gm,'')
  .replace(/\*\*|__|~~|`/g,'');
 const text=markdown.split(/\r\n|\r|\n/).map(line=>line.replace(new RegExp(whitespace+'+$'),'')).filter(line=>trimNoteText(line)!=='').join('\n');
 return continuation?text:trimNoteText(text);
}
export function memoTitle(markdown:string):string{return deriveNoteTitle(projectNoteText(markdown,true))||'未命名笔记';}
