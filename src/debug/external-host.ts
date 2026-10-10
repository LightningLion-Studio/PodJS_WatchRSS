import {credentialsBackup} from './credentials-host.ts';
import {managedCache} from '../cache/host.ts';
import {debugExternal} from '@podjs/framework/services';
import {debugGate} from './host.ts';
import {douyinDebug} from './douyin-host.ts';
import {douyinClient,biliPreviewCache} from '../media-services.ts';
import {ExternalDebugActions} from './external.ts';
import {debugLogBuffer} from './log-buffer.ts';
export function startExternalDebug(openDouyin:(resumeAwemeId?:string)=>void,openSummary:(id:string)=>void):()=>void {
 if(!debugGate.allowed)return ()=>{};
 const actions=new ExternalDebugActions(debugGate,{credentials:credentialsBackup,douyin:douyinDebug,playbackDiagnostics:async()=>({managed:await managedCache.stats().catch(()=>undefined),preview:biliPreviewCache.diagnostics()}),openDouyin,openSummary,applyCookie:raw=>douyinClient.applyCookie(raw),dumpLogs:()=>debugLogBuffer.dump(),clearLogs:()=>debugLogBuffer.clear()});
 let closed=false,stop:(()=>void)|undefined;
 void debugExternal.listen(event=>{if(closed)throw Error('closed');return actions.handle(event);}).then(value=>{if(closed)value();else stop=value;}).catch(()=>{});
 return ()=>{closed=true;stop?.();};
}
