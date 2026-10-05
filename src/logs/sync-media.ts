import {appLogger} from './app-logger.ts';
/** Log actual host playback transitions, not requested leases: several owners
 * can share the track, or the user may have disabled silence playback. */
export function loggedSyncSilence<T>(port:{setEnabled(enabled:boolean):Promise<T>;lease(owner:string,active:boolean):Promise<T>}){
 let playing=false;
 const run=async(operation:()=>Promise<T>,starting:boolean):Promise<T>=>{
  try{
   const value=await operation();
   if(value&&typeof value==='object'&&typeof (value as {playing?:unknown}).playing==='boolean'){
    const next=(value as {playing?:unknown}).playing as boolean;
    if(next!==playing){playing=next;appLogger.i('WatchRSS_SyncMediaKeepAlive',next?'同步媒体保活已启动':'同步媒体保活已停止');}
   }
   return value;
  }catch(error){if(starting)appLogger.w('WatchRSS_SyncMediaKeepAlive','同步媒体保活启动失败');throw error;}
 };
 return {setEnabled:(enabled:boolean)=>run(()=>port.setEnabled(enabled),enabled),lease:(owner:string,active:boolean)=>run(()=>port.lease(owner,active),active)};
}
