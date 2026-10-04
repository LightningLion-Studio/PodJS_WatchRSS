import {decodeHTML,decodeHTMLStrict} from 'entities';
// Kotlin Char.isWhitespace includes the four ASCII information separators,
// and does not include JavaScript's BOM whitespace.
const whitespace='[\\u0009-\\u000d\\u001c-\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const trim=(value:string)=>value.replace(new RegExp('^'+whitespace+'+|'+whitespace+'+$','g'),'');
function nativeEntities(value:string):string{
 // Jsoup consumes a whole named entity token before deciding whether it is
 // recognized; HTML's longest-prefix fallback would turn &notit; into ¬it;.
 return value.replace(/&(?:#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[A-Za-z]+[0-9]*;?)/g,token=>{
  if(token.startsWith('&#')){const hex=/^&#x/i.test(token),code=parseInt(token.slice(hex?3:2),hex?16:10);if(code===0||code>=0xd800&&code<=0xdfff)return String.fromCharCode(code);return decodeHTML(token);}
  if(token.endsWith(';'))return decodeHTMLStrict(token);
  const complete=decodeHTMLStrict(token+';'),legacy=decodeHTML(token);
  return complete===legacy?complete:token;
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
 return trim(markdown.split(/\r\n|\r|\n/).map(line=>line.replace(new RegExp(whitespace+'+$'),'')).filter(line=>trim(line)!=='').join('\n'));
}
export function memoTitle(markdown:string):string{return memoPlainText(markdown).split(/\r\n|\r|\n/)[0]?.slice(0,80)||'未命名笔记';}
