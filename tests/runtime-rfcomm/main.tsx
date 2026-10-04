import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {capabilities,kv} from '@podjs/framework/watch';
import {rfcomm,byteStreams,sqlite,delay} from '@podjs/framework/services';
const key='rfcomm-guest-result';
function check(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(message);}
async function run(){
 kv.set(key,{state:'running'});const started=Date.now();
 check(capabilities().includes('net.rfcomm')&&capabilities().includes('net.stream'),'Capabilities missing from boot');
 const before=await rfcomm.status();check(before.permission==='granted','Permission dialog requires separate user verification');
 check(await rfcomm.requestPermission().result==='granted','Permission result');
 check(before.available&&before.enabled,'Bluetooth unavailable');
 const name='PodJS Guest Verification',uuid='7aeb311c-c79a-407d-b00a-f45176779cb8';let id:string|undefined;
 try{
  id=(await rfcomm.listen(name,uuid).result).id;
  const accept=rfcomm.accept(id,5000);const caught=accept.result.then(()=>{throw new Error('Unexpected remote client');},e=>e.code);
  await delay(100).result;
  const rows=await sqlite.query('SELECT 7 AS value');check(rows[0]?.value===7,'SQL blocked by accept');
  accept.cancel();check(await caught==='cancelled','Cancel not acknowledged');
  await rfcomm.close(id);id=undefined;
  id=(await rfcomm.listen(name,uuid).result).id;
  let acceptFailure:unknown;const acceptingAt=Date.now();try{await rfcomm.accept(id,40).result;}catch(e){acceptFailure={code:(e as {code?:string}).code,message:String(e)};}
  check(acceptFailure&&Date.now()-acceptingAt<3000,'Timed accept did not finish');await rfcomm.close(id);id=undefined;
  let missing=false;try{await byteStreams.read('not-open',1,40).result;}catch(e){missing=(e as {code?:string}).code==='invalid_argument';}check(missing,'Stream capability dispatch');
  kv.set(key,{state:'passed',bootCapabilities:true,permissionAlreadyGranted:true,status:before,listen:true,cancel:true,reopen:true,boundedAcceptFailure:acceptFailure,sqlDuringAccept:true,streamDispatch:true,elapsedMs:Date.now()-started});
 }finally{if(id)await rfcomm.close(id).catch(()=>{});}
}
mount(()=><Text>RFCOMM guest verification</Text>);
void run().catch(e=>kv.set(key,{state:'failed',error:String(e),stack:e instanceof Error?e.stack:''}));
