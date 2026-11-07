/** Real loopback byte streams for host-only acceptance. No device/API access. */
import {createServer,connect,type Socket} from 'node:net';
import type {FrameByteStream} from '@podjs/framework/frame-stream';
export class TcpStream implements FrameByteStream {
 writeBytes=0;
 private chunks:Uint8Array[]=[];private buffered=0;private ended=false;private failure?:Error;private wake?:()=>void;
 constructor(readonly socket:Socket){socket.setNoDelay(true);socket.on('data',chunk=>{if(typeof chunk==='string'){this.failure=Error('unexpected_socket_encoding');this.wake?.();return;}const bytes=new Uint8Array(chunk);this.chunks.push(bytes);this.buffered+=bytes.length;if(this.buffered>=262144)socket.pause();this.wake?.();});socket.on('error',e=>{this.failure=e;this.wake?.();});for(const event of ['end','close'])socket.on(event,()=>{this.ended=true;this.wake?.();});}
 async read(max:number,timeoutMs:number):Promise<Uint8Array|null>{
  for(;;){const first=this.chunks[0];if(first){const n=Math.min(max,first.length),part=first.slice(0,n);if(n===first.length)this.chunks.shift();else this.chunks[0]=first.subarray(n);this.buffered-=n;if(this.buffered<65536)this.socket.resume();return part;}if(this.failure)throw this.failure;if(this.ended||this.socket.destroyed)return null;
   await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{this.wake=undefined;reject(Error('frame_timeout'));},timeoutMs);this.wake=()=>{clearTimeout(timer);this.wake=undefined;resolve();};});
  }
 }
 async write(bytes:Uint8Array){if(this.socket.destroyed)throw Error('socket_closed');await new Promise<void>((resolve,reject)=>this.socket.write(bytes,e=>e?reject(e):resolve()));this.writeBytes+=bytes.length;}
 async close(){if(!this.socket.destroyed){const closed=new Promise<void>(r=>this.socket.once('close',()=>r()));this.socket.destroy();await closed;}}
}
export async function tcpStreams(){
 const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});const address=server.address();if(!address||typeof address==='string')throw Error('loopback_port_missing');
 const accepted=new Promise<Socket>(r=>server.once('connection',r)),client=connect(address.port,'127.0.0.1');await new Promise<void>((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});const peer=await accepted;
 return {client:new TcpStream(client),server:new TcpStream(peer),async close(){client.destroy();peer.destroy();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
