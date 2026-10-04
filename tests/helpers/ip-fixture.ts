import {createHmac} from 'node:crypto';
import type {IpConnectionPorts} from '../../src/sync/ip-connection.ts';
import {parseIpDescriptor,ipDescriptorPayload,ipAckPayload,type IpDescriptor} from '../../src/sync/ip-protocol.ts';
import type {ForegroundTimer} from '../../src/sync/foreground.ts';
import {encodeFrame,type JsonObject} from '../../src/sync/protocol.ts';
export function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const result=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {result,resolve,reject};}
export const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
export class Clock {now=0;timers:{at:number;cancelled:boolean;finish:()=>void}[]=[];delay=(ms:number):ForegroundTimer=>{const d=deferred<void>(),entry={at:this.now+ms,cancelled:false,finish:()=>d.resolve()};this.timers.push(entry);return {result:d.result,cancel:()=>{entry.cancelled=true;d.reject(new Error('cancelled'));}};};async advance(ms:number){const end=this.now+ms;while(true){this.timers.sort((a,b)=>a.at-b.at);const next=this.timers.find(t=>!t.cancelled&&t.at<=end);if(!next)break;this.timers.splice(this.timers.indexOf(next),1);this.now=next.at;next.finish();await flush();}this.now=end;await flush();}}
export function ipFixture(){
 const clock=new Clock(),closed:string[]=[],opens:string[]=[],textWrites:string[]=[],writes:Uint8Array[]=[];const reads:{max:number;d:ReturnType<typeof deferred<{eof:boolean;dataBase64:string}>>}[]=[];let buffer=new Uint8Array(0),terminated=false;
 const mac=async(secret:string,payload:string)=>createHmac('sha256',Buffer.from(secret,'base64url')).update(payload).digest('base64').replace(/\+/g,'-').replace(/\//g,'_');
 const crypto={hmac:mac,nonce:async()=>'nonce'};
 const descriptor:IpDescriptor=parseIpDescriptor({version:2,serverDeviceId:'phone',epoch:1,expiresAt:2000000000000,port:8888,endpoints:[{endpointId:'wifi',address:'10.0.0.1',transportKind:'wifiLan'}],challengeId:'challenge',challengeSecret:'AAECAwQFBgcICQoLDA0ODw=='});
 const ack={serverDeviceId:'phone',sessionId:'session',routeKind:'wifiLan' as const,acceptedResumeSeq:0,serverNonce:'server',hmac:''};
 const op=<T>(value:T)=>({result:Promise.resolve(value),cancel:()=>{}});
 const drain=()=>{while(reads.length&&(buffer.length||terminated)){const {d,max}=reads.shift()!,bytes=buffer.slice(0,max);buffer=buffer.slice(bytes.length);d.resolve({eof:!bytes.length&&terminated,dataBase64:Buffer.from(bytes).toString('base64')});}};
 const close=async(id:string)=>{closed.push(id);terminated=true;drain();return {closed:true};};
 const ports:IpConnectionPorts={crypto,delay:clock.delay,sockets:{connect:url=>{opens.push(url);return op({id:'stream-1'});},writeText:(_id,text)=>{textWrites.push(text);return op({sent:true});},readText:()=>op({text:JSON.stringify({type:'helloAck',...ack})}),close},streams:{read:(_id,max)=>{const d=deferred<{eof:boolean;dataBase64:string}>();reads.push({max,d});drain();return {result:d.result,cancel:()=>{void close('stream-1');}};},write:(_id,bytes)=>{writes.push(bytes.slice());return op({written:bytes.length});},close}};
 return {clock,ports,descriptor,ack,closed,opens,textWrites,writes,sign:async()=>{descriptor.hmac=await mac(descriptor.challengeSecret,ipDescriptorPayload(descriptor));ack.hmac=await mac(descriptor.challengeSecret,ipAckPayload(ack));},feed:(frame:JsonObject)=>{const bytes=encodeFrame(frame),next=new Uint8Array(buffer.length+bytes.length);next.set(buffer);next.set(bytes,buffer.length);buffer=next;drain();}};
}
