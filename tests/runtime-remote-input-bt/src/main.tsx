import {mount} from '@pocketjs/framework/solid';
import {createSignal,Show} from 'solid-js';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {rfcomm,byteStreams,delay} from '@podjs/framework/services';
import {services,getLibrarySyncRepository,memoRepository,db} from '../../../src/services.ts';
import WatchRSS from '../../../src/ui/screen.tsx';
import {RfcommLibraryListener} from '../../../src/sync/rfcomm.ts';
import {createApplicationActionHandler} from '../../../src/sync/application-actions.ts';
import {completeRemoteInput,clearRemoteInput} from '../../../src/remote-input/inbox.ts';
const [visible,setVisible]=createSignal(false);const prompts:{title:string;value:string|undefined}[]=[];let adds=0;
const uuid='912fb445-c99f-4b81-938a-ecfd527bc6a4',key='remote-input-bt-result';
const appServices={...services,input:async(title:string,value?:string)=>{prompts.push({title,value});return null;},addChannel:async()=>{adds++;throw Error('Unconfirmed subscription attempt');}};
function check(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
async function run(){const repository=await getLibrarySyncRepository();const before=await db.query('SELECT * FROM channels ORDER BY id');clearRemoteInput();setVisible(true);await delay(1500).result;
 let listener:RfcommLibraryListener|undefined;
 try{
  const watchId=await repository.deviceId();const results:import('../../../src/sync/session.ts').SessionActionResult[]=[];for(let connection=0;connection<2;connection++){listener=new RfcommLibraryListener(repository,{radio:{...rfcomm,listen:()=>rfcomm.listen('Remote Input Bluetooth Verification',uuid)},streams:byteStreams});results.push(...await listener.start({handleAction:createApplicationActionHandler({notes:memoRepository,deviceId:()=>repository.deviceId(),notesChanged:()=>{throw Error('Unexpected notes change');}}),onActionCompleted:completeRemoteInput,onListening:()=>kv.set(key,{state:'running',stage:connection===0?'listening':'listening-second',watchId,uuid})}));}
  const end=Date.now()+10000;while(prompts.length<2){if(Date.now()>end)throw Error('UI did not receive both URLs');await delay(100).result;}
  check(prompts.length===2,'Unexpected confirmation count');check(prompts[0].value==='https://example.invalid/中文.xml?one=1&two=2','First URL changed');check(prompts[1].value==='https://example.invalid/cancel.xml','Second URL changed');check(prompts.every(p=>p.title==='添加 RSS 地址'),'Confirmation title');check(adds===0,'URL was added without confirmation');check(JSON.stringify(before)===JSON.stringify(await db.query('SELECT * FROM channels ORDER BY id')),'Subscriptions changed');
  check(results.filter(r=>r.request.action==='remoteInput'&&r.response.success===true).length===2,'Remote successes');check(results.filter(r=>r.request.action==='remoteInput'&&r.response.success===false).length===1,'Empty URL rejection');check(results.every(r=>r.ack?.success),'Missing ACK');
  kv.set(key,{state:'passed',stage:'done',watchId,uuid,prompts,adds,subscriptionsUnchanged:true,actions:results.length,connections:2,legacyRemoteInputVerified:true,transport:'bonded-bluetooth',nativePhoneUiVerified:false,physicalInputSimulated:false});
 }finally{listener?.stop();setVisible(false);clearRemoteInput();}
}
mount(()=><Show when={visible()} fallback={<Text>Remote input verification</Text>}><WatchRSS services={appServices}/></Show>);void run().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
