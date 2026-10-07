import type {DebugGate} from './gate.ts';
import type {SummarySession,SummaryState} from '../llm/summary.ts';
export type SummaryFactory=(id:string,preset:()=>number,changed:(state:SummaryState)=>void)=>SummarySession;
/** Mirrors the hidden activity's positive item_id trigger; no normal-menu entry. */
export class DebugSummary {
 private session?:SummarySession;
 constructor(private gate:DebugGate,private create:SummaryFactory){}
 open(itemId:string,preset:()=>number,changed:(state:SummaryState)=>void){
  this.gate.require();this.dispose();
  if(!/^[1-9][0-9]*$/.test(itemId)||!Number.isSafeInteger(Number(itemId)))return;
  this.session=this.create(itemId,preset,changed);void this.session.start();
 }
 retry(){this.gate.require();return this.session?.start();}
 dispose(){this.session?.dispose();this.session=undefined;}
}
