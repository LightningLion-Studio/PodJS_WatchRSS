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

export function searchHighlights(text:string,keyword:string):{start:number;end:number}[] {
 const query=keyword.trim(),found:{start:number;end:number}[]=[];if(!query||!text)return found;
 const lower=text.toLowerCase(),needle=query.toLowerCase();let at=lower.indexOf(needle);
 while(at>=0){found.push({start:at,end:at+query.length});at=lower.indexOf(needle,at+query.length);}
 return found;
}

export function searchHighlightSegments(line:string,keyword:string,measure:(text:string)=>number){
 return searchHighlights(line,keyword).map(({start,end})=>({
  text:line.slice(start,end),x:measure(line.slice(0,start)),width:measure(line.slice(start,end))
 }));
}

/** Highlight in the source before line wrapping, as native AnnotatedString does. */
export function searchHighlightLines(source:string,lines:readonly string[],keyword:string,measure:(text:string)=>number){
 const normalized=source.replace(/\r\n?/g,'\n'),matches=searchHighlights(normalized,keyword);
 let cursor=0;
 return lines.map(line=>{
  const visible=line.endsWith('…')?line.slice(0,-1):line;
  if(!visible){return [];}
  const start=normalized.indexOf(visible,cursor);
  if(start<0)return searchHighlightSegments(visible,keyword,measure);
  cursor=start+visible.length;
  return matches.flatMap(match=>{
   const from=Math.max(start,match.start),to=Math.min(cursor,match.end);
   if(from>=to)return [];
   const localStart=from-start,text=visible.slice(localStart,to-start);
   return [{text,x:measure(visible.slice(0,localStart)),width:measure(text)}];
  });
 });
}
