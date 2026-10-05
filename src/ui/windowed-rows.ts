export interface WindowRow {top:number;height:number;retain?:boolean}

/** Keep the visible slice stable and a bounded history of opted-in rows.
 * Retained rows keep their original position under the viewport's clip.
 * A new source array invalidates the whole history (layout/font/document change).
 */
export function createWindowRows<T extends WindowRow>(extraRows=0) {
  const limit=Number.isFinite(extraRows)?Math.max(0,Math.floor(extraRows)):0;
  let source:readonly T[]|undefined,first=-1,end=-1,result:T[]=[];
  const recent=new Map<T,number>();
  return (rows:readonly T[],lower:number,upper:number):T[]=>{
    let lo=0,hi=rows.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].top+rows[mid].height<lower)lo=mid+1;else hi=mid;}
    const nextFirst=lo;hi=rows.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].top<=upper)lo=mid+1;else hi=mid;}
    const nextEnd=lo;
    if(source===rows&&first===nextFirst&&end===nextEnd)return result;
    if(source!==rows){recent.clear();result=[];source=rows;}
    first=nextFirst;end=nextEnd;
    const visible=rows.slice(first,end);
    if(limit){
      for(let i=first;i<end;i++)if(rows[i].retain){recent.delete(rows[i]);recent.set(rows[i],i);}
      let outside=0;for(const index of recent.values())if(index<first||index>=end)outside++;
      for(const [row,index] of recent){if(outside<=limit)break;if(index<first||index>=end){recent.delete(row);outside--;}}
      const kept=[...recent].filter(([,index])=>index<first||index>=end);
      for(let i=first;i<end;i++)kept.push([rows[i],i]);
      kept.sort((a,b)=>a[1]-b[1]);
      const next=kept.map(([row])=>row);
      if(result.length===next.length&&result.every((row,i)=>row===next[i]))return result;
      result=next;
    }else result=visible;
    return result;
  };
}
