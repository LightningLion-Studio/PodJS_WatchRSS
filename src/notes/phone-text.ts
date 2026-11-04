import {nativeEntities,trimNoteText} from './text';
/** Phone MarkdownNoteCodec.toPlainText differs from watch preview whitespace. */
export function phoneNotePlainText(markdown:string):string {
 const tags=/<\/?(?:p|div|span|b|strong|i|em|u|s|strike|del|ol|ul|li|br|h[1-6]|blockquote|code|a|img|mark)(?:[ \t\n\v\f\r][^>]*)?>/gi,hasHtml=tags.test(markdown);tags.lastIndex=0;
 const input=hasHtml?nativeEntities(markdown.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gis,'[图片：$1]').replace(/<img\b[^>]*>/gis,'[图片]').replace(/<br\s*\/?>/gi,'\n').replace(/<li(?:\s[^>]*)?>/gi,'- ').replace(/<\/(?:p|div|h[1-6]|li|ul|ol|blockquote)>/gi,'\n').replace(tags,'')):markdown;
 const plain=input.replace(/!\[([^\]]*)\]\([^)]*\)/g,'[图片：$1]').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/^#{1,6}[ \t\n\v\f\r]+/gm,'').replace(/^>[ \t\n\v\f\r]?/gm,'').replace(/^[ \t\n\v\f\r]*(?:[-*+] |\d+\. )/gm,'').replace(/\*\*|__|~~|`/g,'');
 return hasHtml?trimNoteText(plain.split(/\r\n|\r|\n/).map(s=>s.replace(/[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'')).filter(s=>trimNoteText(s)!=='').join('\n')):trimNoteText(plain);
}
