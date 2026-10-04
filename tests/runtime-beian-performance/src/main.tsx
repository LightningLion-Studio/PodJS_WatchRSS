import {mount} from '@pocketjs/framework/solid';
import {getDisplayMetrics,kv,setNavigationState} from '@podjs/framework/watch';
import {delay,fileChunks} from '@podjs/framework/services';
import {createSignal,onCleanup,Show} from 'solid-js';
import {BeianScreen} from '../../../src/ui/BeianScreen.tsx';

// Separate package entry: no clock replacement, animation hooks, copied page,
// synthetic input or per-frame reporting. Each Activity owns one fresh guest.
const RESULT='beian-performance-result',COMMAND='beian-performance-command.json';

function PerformanceFixture(){
 const metrics=getDisplayMetrics(),runNonce=kv.get('beian-performance-run-nonce');
 const [mounted,setMounted]=createSignal(false);
 let disposed=false;
 onCleanup(()=>{disposed=true;});
 setNavigationState({canGoBack:false});
 const publish=(value:Record<string,unknown>)=>kv.set(RESULT,{...value,runNonce,metrics,
  clockMode:'unmodified Date.now and native timers',physicalInputInjected:false,
  physicalDisplayPresentVerified:false});
 void(async()=>{
  if(typeof runNonce!=='string'||runNonce.length<16)throw Error('Missing performance run nonce');
  if((await fileChunks.stat(COMMAND)).file)throw Error('Stale mount command at launch');
  publish({state:'waiting',clockTimestampMs:Date.now()});
  const deadline=Date.now()+60_000;
  while(!disposed){
   if((await fileChunks.stat(COMMAND)).file){
    const command=JSON.parse((await fileChunks.readText(COMMAND)).text) as Record<string,unknown>;
    if(command.runNonce!==runNonce||command.action!=='mount'||command.sequence!==1)
     throw Error('Invalid or stale performance mount command');
    const mountRequestWallMs=Date.now();
    setMounted(true);
    publish({state:'mounted',commandSequence:1,mountRequestWallMs,mountReturnWallMs:Date.now(),
     productionComponent:'BeianScreen',productionActiveDefault:true,
     animationOriginIsMountTime:false,animationPerformanceVerified:false});
    // No timer, filesystem polling or KV publication remains during animation.
    return;
   }
   if(Date.now()>deadline)throw Error('Performance mount command timed out');
   await delay(25).result;
  }
 })().catch(error=>{if(!disposed)publish({state:'failed',error:String(error)});});
 return <Show when={mounted()}><BeianScreen width={metrics.logicalWidth} height={metrics.logicalHeight}/></Show>;
}

mount(()=> <PerformanceFixture/>);
