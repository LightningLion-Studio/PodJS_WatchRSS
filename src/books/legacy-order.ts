import {runWorkSteps,stableSortSteps,type WorkSliceOptions} from '@podjs/framework/async';
/** Match the historical numeric chapter / URL tie ordering; parse each key once.
 * Large directories must not monopolize a UI service-completion turn. */
export async function orderLegacyChapters<T extends {link?:unknown}>(input:readonly T[],check:(()=>void)|undefined,options:WorkSliceOptions) {
 function* keyed(){for(const row of input){const link=String(row.link??'');yield {row,link,ordinal:Number(/\/chapter\/(\d+)/.exec(link)?.[1]??-1)};}}
 function* steps(){
  const sorted=yield* stableSortSteps(keyed(),(a,b)=>a.ordinal-b.ordinal||(a.link<b.link?-1:a.link>b.link?1:0));
  const rows:T[]=[],ordinals:number[]=[];
  for(const entry of sorted){rows.push(entry.row);ordinals.push(entry.ordinal);yield;}
  return {rows,ordinals};
 }
 return runWorkSteps(steps(),{traceLabel:'books.legacySort',...options,check});
}
