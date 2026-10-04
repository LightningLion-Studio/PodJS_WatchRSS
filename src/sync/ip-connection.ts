import type {webSockets,byteStreams,HostOperation} from '@podjs/framework/services';
import {HostSyncByteStream} from './rfcomm.ts';
import {StreamFrameConnection} from './stream.ts';
import {buildIpHello,parseIpHelloAck,verifyIpHelloAck,type IpCrypto,type IpDescriptor,type IpEndpoint,type IpHelloAck} from './ip-protocol.ts';
import type {ForegroundTimer} from './foreground.ts';
export interface IpConnectionPorts {sockets:typeof webSockets;streams:typeof byteStreams;crypto:IpCrypto;delay(ms:number):ForegroundTimer}
export interface OpenIpRoute {connection:StreamFrameConnection;endpoint:IpEndpoint;descriptorEpoch:number;ack:IpHelloAck}
/** One cancellable native-style hello probe. There are no hidden retries. */
export class IpConnectionProbe {
 private pending:HostOperation<unknown>|undefined;private streamId:string|undefined;private cancelled=false;private used=false;
 constructor(private readonly ports:IpConnectionPorts){}
 cancel(){this.cancelled=true;this.pending?.cancel();if(this.streamId)void this.ports.sockets.close(this.streamId).catch(()=>{});}
 private check(){if(this.cancelled)throw new Error('IP connection cancelled');}
 private async operation<T>(op:HostOperation<T>,received?:(value:T)=>void):Promise<T>{this.pending=op;try{const value=await op.result;received?.(value);this.check();return value;}finally{if(this.pending===op)this.pending=undefined;}}
 async connect(descriptor:IpDescriptor,endpoint:IpEndpoint,watchDeviceId:string,resumeSessionId:string|null,lastAckSeq:number):Promise<OpenIpRoute>{
  if(this.used)throw new Error('IP probe already started');this.used=true;this.check();
  const hello=await buildIpHello(descriptor,watchDeviceId,await this.ports.crypto.nonce(),resumeSessionId,lastAckSeq,this.ports.crypto);this.check();
  const timeoutMs=endpoint.transportKind==='wifiLan'?1000:4000,timer=this.ports.delay(timeoutMs);
  const open=async()=>{
   const opened=await this.operation(this.ports.sockets.connect(`ws://${endpoint.address}:${descriptor.port}/sync`,{headers:{'X-WatchRSS-Protocol':'2'},timeoutMs,bindLocalWifi:true,initialTextHandshake:true}),value=>{this.streamId=value.id;});this.check();
   await this.operation(this.ports.sockets.writeText(opened.id,JSON.stringify(hello)));
   const raw=JSON.parse((await this.operation(this.ports.sockets.readText(opened.id,timeoutMs))).text);if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid IP handshake');
   if(raw.type==='error')throw new Error(String(raw.message||'手机拒绝 IP 连接'));if(raw.type!=='helloAck')throw new Error('手机未返回 HELLO_ACK');
   const ack=parseIpHelloAck(raw);if(!await verifyIpHelloAck(descriptor,ack,this.ports.crypto))throw new Error('HELLO_ACK 认证失败');if(ack.acceptedResumeSeq!==lastAckSeq)throw new Error('手机续传序号不一致');this.check();
   return {connection:new StreamFrameConnection(new HostSyncByteStream(opened.id,this.ports.streams)),endpoint,descriptorEpoch:descriptor.epoch,ack};
  };
  try{return await Promise.race([open(),timer.result.then(()=>{this.cancel();throw new Error('IP handshake timed out');})]);}
  catch(error){this.cancel();throw error;}finally{timer.cancel();}
 }
}
