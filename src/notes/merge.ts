/** Legacy note sync treats touching insertions as conflicts to preserve both edits. */
export function mergeNoteMarkdown(base:string,local:string,remote:string):string|null {
 return mergeMarkdown(base,local,remote,true);
}

/** Sync v2 §9.1 applies independent hunks in base coordinates. */
export function mergeSyncV2NoteMarkdown(base:string,local:string,remote:string):string|null {
 return mergeMarkdown(base,local,remote,false);
}

function mergeMarkdown(base:string,local:string,remote:string,rejectTouchingInsertions:boolean):string|null {
 if(local===remote)return local;
 if(local===base)return remote;
 if(remote===base)return local;
 if(!rejectTouchingInsertions&&base==='')return null;
 const lines=(s:string)=>s.split(/\r\n|\n|\r/),source=lines(base);
 const hunk=(changed:string[])=>{let start=0,suffix=0;while(start<source.length&&start<changed.length&&source[start]===changed[start])start++;while(suffix<source.length-start&&suffix<changed.length-start&&source[source.length-1-suffix]===changed[changed.length-1-suffix])suffix++;return {start,end:source.length-suffix,replacement:changed.slice(start,changed.length-suffix)};};
 const editedLines=(text:string)=>!rejectTouchingInsertions&&text===''?[]:lines(text);
 const a=hunk(editedLines(local)),b=hunk(editedLines(remote));
 if(a.end>b.start&&b.end>a.start)return null;
 if(!rejectTouchingInsertions){
  // At a shared start, emit the insertion before consuming source lines.
  const order=a.start-b.start||a.end-b.end||compareInsertions(a.replacement,b.replacement);
  const [first,second]=order<=0?[a,b]:[b,a];
  return source.slice(0,first.start).concat(
   first.replacement,source.slice(first.end,second.start),second.replacement,source.slice(second.end),
  ).join('\n');
 }
 if(
  a.start===a.end&&a.start>=b.start&&a.start<=b.end||
  b.start===b.end&&b.start>=a.start&&b.start<=a.end
 )return null;
 for(const h of [a,b].sort((a,b)=>b.start-a.start))source.splice(h.start,h.end-h.start,...h.replacement);
 return source.join('\n');
}

function compareInsertions(a: string[], b: string[]): number {
 for (let i = 0; i < Math.min(a.length, b.length); i++) {
  const left = a[i]!;
  const right = b[i]!;
  if (left !== right) return left < right ? 1 : -1;
 }
 return b.length - a.length;
}
