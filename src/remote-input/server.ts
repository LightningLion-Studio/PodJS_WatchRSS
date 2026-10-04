import type {tcp,byteStreams,HostOperation} from '@podjs/framework/services';
import {base64ToBytes} from '@podjs/framework/bytes';
import {serveRemoteHttp} from './http.ts';
import type {SyncByteStream} from '../sync/stream.ts';
export interface RemoteInputServerPorts { tcp:typeof tcp; streams:typeof byteStreams }
/** An explicit, page-owned listener. It never writes subscriptions or opens input itself. */
export class RemoteInputServer {
 private stopped=false;
 private delivered=false;
 private listener?:string;
 private stream?:string;
 private pending?:HostOperation<unknown>;
 private closing?:Promise<void>;
 readonly ready:Promise<{port:number;addresses:string[]}>;
 private running:Promise<void>=Promise.resolve();
 constructor(private readonly onUrl:(url:string)=>void,private readonly onError:(error:unknown)=>void,
  private readonly ports:RemoteInputServerPorts,address:'0.0.0.0'|'127.0.0.1'='0.0.0.0',
  private readonly serve?:(stream:SyncByteStream,isActive:()=>boolean)=>Promise<void>){
  this.ready=this.start(address);void this.ready.catch(()=>{});
 }
 private async start(address:'0.0.0.0'|'127.0.0.1'){
  const operation=this.ports.tcp.listen(0,address);this.pending=operation;
  try{
   const result=await operation.result;this.listener=result.id;
   if(this.stopped){await this.ports.tcp.close(result.id);this.listener=undefined;throw new Error('Remote input closed');}
   this.pending=undefined;
   const {addresses}=await this.ports.tcp.addresses();
   if(this.stopped)throw new Error('Remote input closed');
   this.running=this.accept();void this.running.catch(error=>{if(!this.stopped)this.onError(error);});
   return {port:result.port,addresses};
  }catch(error){if(this.listener){const id=this.listener;this.listener=undefined;await this.ports.tcp.close(id).catch(()=>{});}throw error;}
  finally{if(this.pending===operation)this.pending=undefined;}
 }
 private async accept(){
  try{while(!this.stopped&&!this.delivered&&this.listener){
   const accept=this.ports.tcp.accept(this.listener,120000);this.pending=accept;let id:string;
   try{id=(await accept.result).id;}catch(error){if(this.stopped)return;if(/timed out|timeout/i.test(String(error)))continue;throw error;}
   finally{if(this.pending===accept)this.pending=undefined;}
   this.stream=id;
   if(this.stopped){await this.ports.streams.close(id);this.stream=undefined;return;}
   const stream:SyncByteStream={
    read:async(max,timeout)=>{const operation=this.ports.streams.read(id,max,timeout);this.pending=operation;try{const value=await operation.result;return value.eof?null:base64ToBytes(value.dataBase64);}finally{if(this.pending===operation)this.pending=undefined;}},
    write:async(bytes)=>{const operation=this.ports.streams.write(id,bytes,15000);this.pending=operation;try{await operation.result;}finally{if(this.pending===operation)this.pending=undefined;}},
    close:async()=>{await this.ports.streams.close(id);if(this.stream===id)this.stream=undefined;},
   };
   try{if(this.serve)await this.serve(stream,()=>!this.stopped);else await serveRemoteHttp(stream,()=>!this.stopped,url=>{if(!this.stopped&&!this.delivered){this.delivered=true;this.onUrl(url);}});}
   catch(error){if(!this.stopped)console.warn('Remote input connection: '+String(error));}
   finally{await stream.close().catch(()=>{});}
  }}finally{if(this.listener){const id=this.listener;this.listener=undefined;await this.ports.tcp.close(id).catch(()=>{});}}
 }
 dispose():Promise<void>{
  if(this.closing)return this.closing;this.stopped=true;this.pending?.cancel();
  this.closing=(async()=>{const listener=this.listener,stream=this.stream;await Promise.all([listener?this.ports.tcp.close(listener):undefined,stream?this.ports.streams.close(stream):undefined].map(p=>p?.catch(()=>{})));await this.ready.catch(()=>{});await this.running.catch(()=>{});})();
  return this.closing;
 }
}
