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

/** Preview keeps literal numbers and expands ordered HTML list markers. */
export function notePreviewPlainText(value:string):string {
 return projectNoteText(value.includes('<')&&/<ol\b/i.test(value)?numberHtmlListItems(value):value,true);
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

function numberHtmlListItems(value:string):string {
 interface List {ordered:boolean;step:number;start?:number;items:{index:number;value?:number}[]}
 const parts:string[]=[],lists:List[]=[];
 const finish=(list:List|undefined)=>{
  if(!list?.ordered)return;
  let number=list.start??(list.step===-1?list.items.length:1);
  for(const item of list.items){
   number=item.value??number;
   parts[item.index]=`\n${number}. `;
   number+=list.step;
  }
 };
 let cursor=0;
 for(const match of value.matchAll(/<(\/?)(ol|ul|li)(?=[ \t\n\f\r/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)){
  parts.push(value.slice(cursor,match.index));
  cursor=match.index+match[0].length;
  const [,closing,name]=match,tag=name.toLowerCase();
  if(tag==='li'&&!closing&&lists.at(-1)?.ordered){
   lists.at(-1)!.items.push({index:parts.length,value:listInteger(listAttributes(match[0]).get('value'))});
   parts.push('');
  }else{
   parts.push(match[0]);
   if(tag!=='li'){
    if(closing)finish(lists.pop());
    else {
     const attributes=tag==='ol'?listAttributes(match[0]):undefined;
     lists.push({ordered:tag==='ol',start:listInteger(attributes?.get('start')),step:attributes?.has('reversed')?-1:1,items:[]});
    }
   }
  }
 }
 while(lists.length)finish(lists.pop());
 parts.push(value.slice(cursor));
 return parts.join('');
}
// Title and preview projections retain ordered markers in the source.
function projectNoteText(value:string,preserveListNumbers:boolean):string{
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
 return trimNoteText(markdown.split(/\r\n|\r|\n/).map(line=>line.replace(new RegExp(whitespace+'+$'),'')).filter(line=>trimNoteText(line)!=='').join('\n'));
}
export function memoTitle(markdown:string):string{return deriveNoteTitle(projectNoteText(markdown,true))||'未命名笔记';}
