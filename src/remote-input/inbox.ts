import {wireFields} from "../sync/article-batches.ts";
export function remoteInputUrl(value:unknown):string {return wireFields.trim(wireFields.string(value));}
/** Volatile input handoff: only the UI's existing confirmation flow adds a feed. */
const pending:string[]=[];
const observers=new Set<(url:string)=>void>();
/** Observe future deliveries without consuming/replaying the application queue. */
export function subscribeRemoteInput(observer:(url:string)=>void):()=>void {observers.add(observer);return ()=>{observers.delete(observer);};}
export function enqueueRemoteInput(url:string):void {if(wireFields.trim(url)){pending.push(url);for(const observer of [...observers])try{observer(url);}catch{}}}
export function takeRemoteInput():string|undefined {return pending.shift();}
export function clearRemoteInput():void {pending.length=0;}

export function completeRemoteInput(result:{request:Record<string,unknown>;response:Record<string,unknown>}):void {if(result.request.action==='remoteInput'&&result.response.success===true)enqueueRemoteInput(remoteInputUrl(result.request.url));}
