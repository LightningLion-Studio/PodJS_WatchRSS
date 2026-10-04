import {mount} from '@pocketjs/framework/solid';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {getDisplayMetrics,kv,setNavigationState} from '@podjs/framework/watch';
import {delay,fileChunks,textLayout} from '@podjs/framework/services';
import {systemTextResourceCounts,systemTextResourceStatus} from '@podjs/framework/text';
import {onCleanup} from 'solid-js';
import {BeianScreen} from '../../../src/ui/BeianScreen.tsx';

// This entry is built only into the isolated startup verification package.
// Freeze the production component's wall-clock input, without replacing its
// formulas, bitmap, MediaSurface, layout, native text or Android host timers.
const realNow=Date.now.bind(Date),originalNow=Date.now;
const clockOriginMs=realNow();
let elapsedMs=0;
const fixtureNow=()=>clockOriginMs+elapsedMs;
Date.now=fixtureNow;
const RESULT='beian-animation-result',COMMAND='beian-animation-command.json';
const sleep=(ms:number)=>delay(ms).result;

function AnimationFixture(){
 const metrics=getDisplayMetrics(),errors:string[]=[];
 let disposed=false,frameCount=0,commandSequence=0;
 const appliedCommandSequences:number[]=[];
 const runNonce=kv.get('beian-animation-run-nonce');
 const initialTextStatus=systemTextResourceStatus();
 setNavigationState({canGoBack:false});
 onFrame(()=>{frameCount++;});
 onCleanup(()=>{disposed=true;if(Date.now===fixtureNow)Date.now=originalNow;});
 const settle=async(minimumFrame:number)=>{
  const deadline=realNow()+60_000;
  let stable=0;
  while(!disposed){
   const text=systemTextResourceStatus();
   if(text.totals.failed||initialTextStatus.totals.failed)throw Error('Native text failed: '+JSON.stringify(text));
   const uploaded=text.cached===2&&text.ready===2&&!text.pending&&!text.failed&&!text.active&&!text.queued
    &&text.entries.every(entry=>entry.uploaded&&entry.readyListeners===entry.refs);
   stable=uploaded&&frameCount>=minimumFrame?stable+1:0;
   if(stable>=4)return;
   if(realNow()>deadline)throw Error('Native text/frame readiness timed out');
   await sleep(50);
  }
 };
 void(async()=>{
  if((await fileChunks.stat(COMMAND)).file)throw Error('Stale animation command at launch');
  const environment=await textLayout.environment({spValues:[12,21]});
  const publish=async()=>{
   await settle(frameCount+4);
   if(disposed)return;
   kv.set(RESULT,{state:'ready',commandSequence,elapsedMs,effectiveElapsedMs:Math.min(1650,elapsedMs),
    clockTimestampMs:Date.now(),clockOriginMs,frameCount,environment,metrics,runNonce,
    nativeTextStatus:systemTextResourceStatus(),resources:systemTextResourceCounts(),initialTextStatus,errors,
    appliedCommandSequences,clockMode:'fixture Date.now frozen; native host timers unchanged',
    qrReadinessVerifiedByFixture:false,animationPerformanceVerified:false,physicalInputInjected:false});
  };
  await publish();
  while(!disposed){
   if((await fileChunks.stat(COMMAND)).file){
    const command=JSON.parse((await fileChunks.readText(COMMAND)).text) as Record<string,unknown>;
    if(!Number.isSafeInteger(command.sequence)||Number(command.sequence)<1)throw Error('Invalid animation command sequence');
    const sequence=Number(command.sequence);
    if(sequence>commandSequence){
     if(sequence!==commandSequence+1)throw Error('Skipped animation command');
     if(typeof command.elapsedMs!=='number'||!Number.isFinite(command.elapsedMs)||command.elapsedMs<elapsedMs||command.elapsedMs>5000)
      throw Error('Animation phases must be finite, monotonic and at most 5000ms');
     commandSequence=sequence;elapsedMs=command.elapsedMs;appliedCommandSequences.push(sequence);
     kv.set(RESULT,{state:'loading',commandSequence,elapsedMs,runNonce});
     await publish();
    }
   }
   // Publish changing frame counters while a phase is frozen so the Android
   // probe can prove frames happened after the image really became ready.
   if(!disposed)await publish();
   await sleep(100);
  }
 })().catch(error=>{if(!disposed){errors.push(String(error));kv.set(RESULT,{state:'failed',commandSequence,elapsedMs,errors,runNonce});}});
 return <BeianScreen width={metrics.logicalWidth} height={metrics.logicalHeight}/>;
}

mount(()=> <AnimationFixture/>);
