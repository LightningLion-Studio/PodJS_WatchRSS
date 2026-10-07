import {delay} from '@podjs/framework/services';
import type {ContentLayout,ReaderRow} from './content-layout.ts';

export function readerRowKey(row:ReaderRow):string {
 return `${row.kind}:${row.blockIndex}:${row.sourceStart??0}`;
}
export interface LayoutSliceStats {turns:number;maxMs:number;rows:number}
/** Prepare both geometry and its window index before one atomic publication.
 * Half a millisecond on Linux leaves room for the estimated 5–10x armv7 cost.
 * The row cap also bounds work when the host clock has millisecond precision.
 */
export function prepareReaderLayout<T>(steps:Generator<ReaderRow,ContentLayout>,entry:(row:ReaderRow)=>T,
 publish:(value:{layout:ContentLayout;entries:T[];indices:ReadonlyMap<string,number>})=>void,
 options:{budgetMs?:number;rowLimit?:number;clock?:()=>number;yieldTurn?:()=>{result:Promise<unknown>;cancel():void};onSlice?:(ms:number,rows:number)=>void}={}) {
 const clock=options.clock??Date.now,yieldTurn=options.yieldTurn??(()=>delay(0));
 const budget=Math.max(.1,options.budgetMs??.5),limit=Math.max(1,options.rowLimit??16);
 const entries:T[]=[],indices=new Map<string,number>(),stats:LayoutSliceStats={turns:0,maxMs:0,rows:0};
 let cancelled=false,pending:ReturnType<typeof yieldTurn>|undefined;
 const done=(async()=>{
  // Even an already resolved text service must leave its completion turn.
  while(!cancelled){
   pending=yieldTurn();try{await pending.result;}catch(error){if(cancelled)return;throw error;}finally{pending=undefined;}
   if(cancelled)return;
   const began=clock();let count=0,finished:ContentLayout|undefined;
   while(!cancelled){
    const next=steps.next();if(next.done){finished=next.value;break;}
    indices.set(readerRowKey(next.value),entries.length);entries.push(entry(next.value));count++;stats.rows++;
    if(count>=limit||clock()-began>=budget)break;
   }
   const elapsed=clock()-began;stats.turns++;stats.maxMs=Math.max(stats.maxMs,elapsed);options.onSlice?.(elapsed,count);
   if(cancelled)return;
   if(finished){publish({layout:finished,entries,indices});return;}
  }
 })();
 return {done,stats,cancel(){cancelled=true;pending?.cancel();steps.return({rows:[],height:0,textLength:0});}};
}
