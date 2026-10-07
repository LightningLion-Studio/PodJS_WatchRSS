const MAX_SNIPPET_LENGTH=140;

/** Mirrors the native search card's text cleanup and candidate order. */
export function normalizeSearchText(value:string):string {
 return value.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
}
function compact(value:string):string{return value.trim().replace(/\s+/g,' ');}
function sanitize(value:string):string {const text=compact(value);return text.length>MAX_SNIPPET_LENGTH?text.slice(0,MAX_SNIPPET_LENGTH)+'...':text;}
export function searchSnippet(keyword:string,description:string|null|undefined,content:string|null|undefined,summary:string|null|undefined):string {
 const query=keyword.trim(),candidates=[description,content,summary];
 if(query){for(const candidate of candidates){if(!candidate?.trim())continue;const text=compact(normalizeSearchText(candidate)),index=text.toLowerCase().indexOf(query.toLowerCase());if(index<0)continue;
  const context=Math.min(35,index);let start=Math.max(0,index-context),end=Math.min(text.length,start+MAX_SNIPPET_LENGTH);
  if(end-start<MAX_SNIPPET_LENGTH&&start>0)start=Math.max(0,end-MAX_SNIPPET_LENGTH);
  return (start>0?'...':'')+text.slice(start,end)+(end<text.length?'...':'');
 }}
 const fallback=candidates.find(value=>!!value?.trim());return fallback?sanitize(normalizeSearchText(fallback)):'暂无摘要';
}

export {textMatches as searchHighlights,matchSegments as searchHighlightSegments,matchLines as searchHighlightLines} from '@podjs/framework/text-match';
