import {mount} from '@pocketjs/framework/solid';
import {Text,View} from '@pocketjs/framework/components';
import {createSignal} from 'solid-js';
import {kv} from '@podjs/framework/watch';
import {secureStorage,debugExternal} from '@podjs/framework/services';
import {initializeDebugBuild,debugGate} from '../../../src/debug/host.ts';
import {credentialsBackup} from '../../../src/debug/credentials-host.ts';
import {ExternalDebugActions,DEBUG_ACTION} from '../../../src/debug/external.ts';
import {douyinDebug} from '../../../src/debug/douyin-host.ts';
import {debugLogBuffer} from '../../../src/debug/log-buffer.ts';
import {biliClient,douyinClient} from '../../../src/media-services.ts';
import {summaryAccountStore} from '../../../src/llm/runtime.ts';
import {startAppLogger} from '../../../src/logs/logger-host.ts';
const bili=JSON.stringify({cookies:{SESSDATA:'t21-fake-bili-cookie',DedeUserID:'21'},refreshToken:'t21-fake-bili-refresh',updatedAt:21});
const cookie='sessionid=t21-fake-douyin-cookie';
const account=JSON.stringify({userId:'21',watchDeviceToken:'t21-fake-account-token',watchRefreshToken:'t21-fake-account-refresh',tokenExpiresAtMillis:4133980800000});
const [status,setStatus]=createSignal('starting');
const actions=new ExternalDebugActions(debugGate,{credentials:credentialsBackup,douyin:douyinDebug,openDouyin(){},openSummary(){},applyCookie:raw=>douyinClient.applyCookie(raw),dumpLogs:()=>debugLogBuffer.dump(),clearLogs:()=>debugLogBuffer.clear()});
async function state(){const b=await biliClient.getSession(),d=await douyinClient.readCookie(),a=await summaryAccountStore.read();return {bili:!!b?.cookies.SESSDATA,douyin:!!d,account:!!a?.watchDeviceToken,biliEqual:JSON.stringify(b)===bili,douyinEqual:d===cookie,accountEqual:a?.watchDeviceToken==='t21-fake-account-token',refreshEqual:b?.refreshToken==='t21-fake-bili-refresh'};}
async function run(){
 if(!await initializeDebugBuild())throw Error('debug gate refused');
 startAppLogger();
 if(!kv.get<boolean>('t21.seeded')){await secureStorage.update({'watchrss.bili.session.v1':bili,'douyin.cookie':cookie,state_json:account});kv.set('t21.seeded',true);}
 await state();
 await debugExternal.listen(async event=>{
  if(event.action===DEBUG_ACTION+'REHEARSAL_CLEAR'){debugGate.require();await biliClient.clearSession();await douyinClient.clearCookie();await summaryAccountStore.clear();setStatus('cleared');return {code:0,data:JSON.stringify(await state())};}
  if(event.action===DEBUG_ACTION+'REHEARSAL_STATE'){debugGate.require();return {code:0,data:JSON.stringify(await state())};}
  const result=await actions.handle(event);if(event.action===DEBUG_ACTION+'IMPORT_CREDENTIALS'&&result.code===0)setStatus('restored');return result;
 });
 setStatus('ready');kv.set('t21.rehearsal',{state:'ready'});
}
mount(()=><View class="w-full h-full bg-black"><Text class="absolute left-[40] top-[80] text-base text-white">Credentials rehearsal</Text><Text class="absolute left-[80] top-[120] text-sm text-white">{status()}</Text></View>);
void run().catch(()=>{setStatus('failed');kv.set('t21.rehearsal',{state:'failed'});});
