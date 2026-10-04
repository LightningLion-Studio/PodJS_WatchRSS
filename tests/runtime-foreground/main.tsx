import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {onFrame} from '@pocketjs/framework/lifecycle';
import {kv,onLifecycleChange,lifecycle} from '@podjs/framework/watch';
import {rfcomm,sqlite,delay} from '@podjs/framework/services';
let frames=0;
const key='foreground-guest-result';
function check(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(message);}
async function run(){
 kv.set(key,{state:'running'});const status=await rfcomm.status();check(status.permission==='granted'&&status.enabled,'Bluetooth unavailable');
 let complete!:()=>void;const background=new Promise<void>(resolve=>complete=resolve);const unsubscribe=onLifecycleChange(state=>{if(state==='background')complete();});
 const listener=await rfcomm.listen('PodJS Background Verification','1178596f-2da4-40cf-b2a4-785e4e2f4e90').result;
 const accept=rfcomm.accept(listener.id,120000);const stopped=accept.result.then(()=>{throw new Error('Unexpected peer');},e=>e.code);
 try{
  kv.set(key,{state:'ready',frames,lifecycle:lifecycle()});await background;const before=frames;
  const row=(await sqlite.query('SELECT 19 AS value'))[0];check(row?.value===19,'SQL completion stalled');
  await delay(40).result;accept.cancel();check(await stopped==='cancelled','Cancel completion stalled');
  await rfcomm.close(listener.id);await delay(40).result;
  check(lifecycle()==='background','Fixture returned to foreground');check(frames===before,'Visual frame advanced in background');
  kv.set(key,{state:'passed',backgroundLifecycle:true,sql:true,timer:true,acceptCancelled:true,listenerClosed:true,visualFramesBefore:before,visualFramesAfter:frames});
 }finally{unsubscribe();accept.cancel();await rfcomm.close(listener.id).catch(()=>{});}
}
mount(()=>{onFrame(()=>{frames++;});return <Text>Foreground service verification</Text>;});
void run().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
