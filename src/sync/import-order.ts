import {runWorkSteps,stableSortSteps,type WorkSliceOptions} from '@podjs/framework/async';
import {isImportedContentUrl} from '../core/imported-content';
/** The historical manifest ordering, with numeric columns parsed once and RSS
 * cache rows excluded before sorting. Caller still emits independent rows first. */
export async function orderImportedRows<T extends Record<string,unknown>>(input:readonly T[],options:WorkSliceOptions):Promise<T[]> {
 function* steps(){
  const candidates:{row:T;keys:number[]}[]=[];
  for(const row of input){const channel=String(row.channel_url??'');if(channel==='watchrss://phone-imports'||isImportedContentUrl(channel))candidates.push({row,keys:[row.channel_pinned,row.channel_sort,row.channel_created,row.channel_id,row.fetched_at,row.id].map(v=>Number(v??0))});yield;}
  const order=[-1,1,-1,1,-1,-1];
  const sorted=yield* stableSortSteps(candidates,(a,b)=>{for(let i=0;i<order.length;i++){const d=order[i]!*(a.keys[i]!-b.keys[i]!);if(d)return d;}return 0;});
  const out:T[]=[];for(const entry of sorted){out.push(entry.row);yield;}return out;
 }
 return runWorkSteps(steps(),{traceLabel:'sync.importOrder',...options});
}
