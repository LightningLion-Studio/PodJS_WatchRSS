import {readerRowKey,type ReaderRow,type ReaderRows} from './content-layout.ts';

/** Window selection probes geometry by index. Keep a bounded set of entries
 * for repeated probes and redraws without retaining every row scrolled past. */
export function readerWindowEntries<T>(rows:ReaderRows,make:(row:ReaderRow)=>T,scope:unknown){
 const cache=new Map<number,T>();
 const entries={length:rows.length,at(index:number){
  index=Math.trunc(index)||0;if(index<0)index+=rows.length;
  if(index<0||index>=rows.length)return;
  const hit=cache.get(index);
  if(hit!==undefined)return hit;
  const value=make(rows.at(index)!);
  if(cache.size>=128)cache.delete(cache.keys().next().value!);
  cache.set(index,value);return value;
 }};
 // Source block and raw offset are ordered across both loaded rows and placeholders.
 // Preserve the last matching index when measured text contains an empty boundary.
 const indices={get(key:unknown):number|undefined{
  if(typeof key!=='string')return;
  const match=/^(text|image|video):(\d+):(\d+)$/.exec(key);
  if(!match)return;
  const block=Number(match[2]),offset=Number(match[3]);
  let low=0,high=rows.length;
  while(low<high){
   const mid=(low+high)>>>1,row=rows.at(mid)!;
   if(row.blockIndex<block||row.blockIndex===block&&(row.sourceStart??0)<=offset)low=mid+1;else high=mid;
  }
  for(let i=low-1;i>=0;i--){
   const row=rows.at(i)!;
   if(row.blockIndex!==block||(row.sourceStart??0)!==offset)break;
   if(readerRowKey(row)===key)return i;
  }
 }};
 return {entries,indices,scope};
}
