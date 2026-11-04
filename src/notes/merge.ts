/** Literal port of the phone's conservative MarkdownThreeWayMerge. */
export function mergeNoteMarkdown(base:string,local:string,remote:string):string|null {
 if(local===remote)return local;
 if(local===base)return remote;
 if(remote===base)return local;
 const lines=(s:string)=>s.split(/\r\n|\n|\r/),source=lines(base);
 const hunk=(changed:string[])=>{let start=0,suffix=0;while(start<source.length&&start<changed.length&&source[start]===changed[start])start++;while(suffix<source.length-start&&suffix<changed.length-start&&source[source.length-1-suffix]===changed[changed.length-1-suffix])suffix++;return {start,end:source.length-suffix,replacement:changed.slice(start,changed.length-suffix)};};
 const a=hunk(lines(local)),b=hunk(lines(remote));
 if(a.end>b.start&&b.end>a.start)return null;
 for(const h of [a,b].sort((a,b)=>b.start-a.start))source.splice(h.start,h.end-h.start,...h.replacement);
 return source.join('\n');
}
