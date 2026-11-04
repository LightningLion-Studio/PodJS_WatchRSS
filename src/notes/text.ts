import {noteHtmlEntities} from './html-entities';
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
export function memoPlainText(value:string):string{
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
  .replace(/^[ \t\n\v\f\r]*(?:[-*+] |\d+\. )/gm,'')
  .replace(/\*\*|__|~~|`/g,'');
 return trimNoteText(markdown.split(/\r\n|\r|\n/).map(line=>line.replace(new RegExp(whitespace+'+$'),'')).filter(line=>trimNoteText(line)!=='').join('\n'));
}
export function memoTitle(markdown:string):string{return memoPlainText(markdown).split(/\r\n|\r|\n/)[0]?.slice(0,80)||'未命名笔记';}
