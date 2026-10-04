/** Actual viewport intersection, excluding the renderer's overscan rows. End edges are exclusive. */
export function visibleEntryRange(rows:readonly {top:number;height:number}[],offset:number,height:number):{first:number;last:number}|null {
  if(height<=0||!rows.length)return null;
  let low=0,high=rows.length;
  while(low<high){const mid=(low+high)>>>1;if(rows[mid].top+rows[mid].height<=offset)low=mid+1;else high=mid;}
  const first=low;high=rows.length;
  while(low<high){const mid=(low+high)>>>1;if(rows[mid].top<offset+height)low=mid+1;else high=mid;}
  return first<low?{first,last:low-1}:null;
}
