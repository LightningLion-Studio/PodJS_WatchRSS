import {routeRemoteHttp} from "../../../src/remote-input/http.ts";
import {View} from '@pocketjs/framework/components';
import {mount} from '@pocketjs/framework/solid';
import {createSignal,Show} from 'solid-js';
import {RemoteInputScreen,RemoteInputQr} from '../../../src/ui/RemoteInputScreen.tsx';
import {kv,getDisplayMetrics,__onHostEvent} from '@podjs/framework/watch';
import {delay,fileChunks} from '@podjs/framework/services';
const sleep=(ms:number)=>delay(ms).result;
const [visible,setVisible]=createSignal(true);const [showQr,setShowQr]=createSignal(false);
const qrValue="http://192.168.1.2:12345/#请将手机和手表连上同一个WiFi再扫码";
let port=0,received:string|undefined;
const before=JSON.stringify(kv.get('watchrss.settings'));
__onHostEvent(event=>{if(event.t==='service.result'&&event.ok&&event.value&&typeof event.value==='object'&&'port' in event.value){port=Number(event.value.port);kv.set('remote-input-endpoint',{port});}});
async function run(){
 const requests=[...['/','/health','/getCurrentActivationAbility','/getAbilities','/getFavorites','/getTtsConfig','/setLLMSummaryConfig'].map(target=>({target,body:'',headers:{}})),
 ...['{}','{"url":""}','{"url":null}','{"url":false}','{"url":123}','{"url":" https://example.invalid/中文 "}','https://example.invalid/feed','{"broken"','{"url":"\\ufeff"}','{"url":"\\u001c"}'].map(body=>({target:'/remoteEnterRSSURL',body,headers:{'content-type':'application/json'}}))];
 kv.set('remote-input-native-cases',requests.map(request=>({request,response:routeRemoteHttp(request)})));

 const end=Date.now()+30000;while(!port){if(Date.now()>end)throw Error('No TCP endpoint');await sleep(100);}await sleep(4500);
 kv.set('remote-input-result',{state:'running',stage:'ready',port});
 const cancelDeadline=Date.now()+30000;while(!(await fileChunks.stat('remote-input-reopen')).file){if(Date.now()>cancelDeadline)throw Error('Cancel stage timeout');await sleep(100);}
 setVisible(false);await sleep(500);kv.set('remote-input-result',{state:'running',stage:'closed',port});
 const reopenDeadline=Date.now()+15000;while(!(await fileChunks.stat('remote-input-open')).file){if(Date.now()>reopenDeadline)throw Error('Reopen stage timeout');await sleep(100);}
 port=0;setVisible(true);while(!port){if(Date.now()>reopenDeadline)throw Error('No reopened port');await sleep(100);}await sleep(500);kv.set('remote-input-result',{state:'running',stage:'reopened',port});
 const until=Date.now()+60000;while(received===undefined){if(Date.now()>until)throw Error('No submitted URL');await sleep(100);}
 setVisible(false);setShowQr(true);await sleep(1500);
 kv.set('remote-input-result',{state:'running',stage:'qr',port,received,qrValue});const qrDeadline=Date.now()+30000;while(!(await fileChunks.stat('qr-advance')).file){if(Date.now()>qrDeadline)throw Error('QR capture timeout');await sleep(100);}setShowQr(false);
 if(JSON.stringify(kv.get('watchrss.settings'))!==before)throw Error('Settings changed');
 kv.set('remote-input-result',{state:'passed',stage:'done',port,received,settingsUnchanged:true,subscriptionsNotCreated:true});
}
function App(){const m=getDisplayMetrics();return <><Show when={visible()}><RemoteInputScreen width={m.logicalWidth} height={m.logicalHeight} active={()=>true} onUrl={url=>{received=url;}} onDismiss={()=>setVisible(false)} onError={error=>kv.set('remote-input-result',{state:'failed',error})}/></Show><Show when={showQr()}><View class="absolute" style={{insetL:(m.logicalWidth-120)/2,insetT:(m.logicalHeight-120)/2}}><RemoteInputQr value={qrValue}/></View></Show></>;}
mount(App);void run().catch(error=>kv.set('remote-input-result',{state:'failed',error:String(error)}));
