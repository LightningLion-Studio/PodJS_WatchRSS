import {watchTitleMeasurements} from './measured-text.ts';
export interface TitleMeasureOperation {result:Promise<{widthPx:number}>;cancel():void}
/** Use the existing native-title line planning with the same font as the rasterizer. */
export function requestWatchTitleLines(title:string,width:number,pixelScale:number,measure:(text:string)=>TitleMeasureOperation,update:(lines:string[])=>void,onError:(error:unknown)=>void){
 let cancelled=false,current:TitleMeasureOperation|undefined;
 const done=(async()=>{
  try{
   const plan=watchTitleMeasurements(title,width),cache=new Map<string,number>();let step=plan.next();
   while(!step.done){
    if(cancelled)return;const text=step.value;let value=cache.get(text);
    if(value===undefined){current=measure(text);const result=await current.result;if(cancelled)return;current=undefined;if(!Number.isFinite(result.widthPx)||result.widthPx<0)throw Error('Invalid font measurement');value=result.widthPx/pixelScale;cache.set(text,value);}
    step=plan.next(value);
   }
   if(!cancelled)update(step.value);
  }catch(error){if(!cancelled)onError(error);}
 })();
 return {done,cancel(){cancelled=true;current?.cancel();}};
}
