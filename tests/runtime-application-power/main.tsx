import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv,lifecycle,onLifecycleChange} from '@podjs/framework/watch';
import {rfcomm,byteStreams,displayPower,silencePlayback,delay} from '@podjs/framework/services';
import {ApplicationForegroundSync} from '../../src/sync/application-foreground.ts';
import {RfcommLibraryListener} from '../../src/sync/rfcomm.ts';
import {getLibrarySyncRepository,db} from '../../src/services.ts';
const key='application-power-result',uuid='27f8a669-027b-4c49-8023-f899420c38a9';
function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function run(){
 const started=Date.now(),listeners:string[]=[],errors:string[]=[];let completed=0,acknowledged=false;
 const runtime=new ApplicationForegroundSync({repository:getLibrarySyncRepository,createListener:repo=>new RfcommLibraryListener(repo,{radio:{...rfcomm,listen:()=>{const pending=rfcomm.listen('WatchRSS Power Verification',uuid);return {...pending,result:pending.result.then(value=>{listeners.push(value.id);return value;})};}},streams:byteStreams}),lifecycle,onLifecycle:onLifecycleChange,display:displayPower,radio:rfcomm,silence:silencePlayback,delay,onLibraryChanged:()=>completed++,onState:state=>kv.set(key,{state:'running',phase:state,uuid}),onError:error=>errors.push(String(error))},{responseAckTimeoutMs:30000,onActionCompleted:result=>{acknowledged=result.ack?.success===true&&result.ack?.applied===true;}});
 let active=false,background=false;
 try{
  runtime.setMediaEnabled(true);await runtime.ready;check((await db.query('SELECT count(*) n FROM articles'))[0]?.n===0,'Probe fixture must have no articles');
  const deadline=Date.now()+120000;
  while(!completed){
   if(Date.now()>deadline)throw new Error('Phone probe deadline expired: '+errors.join(';'));
   if(runtime.state==='transferring'){
    const screen=await displayPower.state(),audio=await silencePlayback.state();
    if(!active&&screen.applied&&screen.windowKeepScreenOn&&screen.owners.includes('rfcomm-bootstrap')&&audio.playing&&audio.owners.includes('rfcomm-bootstrap')){active=true;kv.set(key,{state:'running',phase:'resources-active',uuid});}
    if(!background&&!screen.resumed&&!screen.applied&&screen.owners.includes('rfcomm-bootstrap')&&audio.playing&&audio.owners.includes('rfcomm-bootstrap')){background=true;kv.set(key,{state:'running',phase:'background-transfer',uuid});}
   }
   await delay(40).result;
  }
  check(acknowledged,'Peer applied ACK was not received');check(active,'Real peer did not acquire display and audio resources');check(background,'Transfer was not verified in a paused activity');
  await delay(150).result;const screen=await displayPower.state(),audio=await silencePlayback.state();
  check(!screen.applied&&!screen.owners.includes('rfcomm-bootstrap'),'Screen lease remained after probe');check(audio.playing&&audio.owners.includes('rfcomm-bootstrap'),'Media handoff grace was lost');
 }finally{await runtime.dispose();}
 const screen=await displayPower.state(),audio=await silencePlayback.state();check(!screen.applied&&screen.owners.length===0,'Display not released');check(!audio.playing&&audio.owners.length===0&&!audio.enabled,'Media not released');
 check(listeners.length>0,'No listener was created');for(const id of listeners){let rejected=false;try{await rfcomm.accept(id,20).result;}catch(error){rejected=String(error).includes('Unknown listener');}check(rejected,'Listener remained open');}
 check((await db.query('SELECT count(*) n FROM articles'))[0]?.n===0,'Probe changed articles');
 kv.set(key,{state:'passed',realPeerProbe:true,appliedAckReceived:acknowledged,testResponseAckTimeoutMs:30000,activeDisplayAndAudio:true,backgroundTransfer:true,screenReleasedAfterProbe:true,mediaHandoffGrace:true,disposedResources:true,closedListeners:listeners.length,articleRowsUnchanged:true,completed,errors,elapsedMs:Date.now()-started});
}
mount(()=><Text>Application sync power verification</Text>);void run().catch(error=>kv.set(key,{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
