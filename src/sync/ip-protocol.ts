import {wireFields} from './article-batches.ts';
import type {JsonObject} from './protocol.ts';
import {javaUtf8Chunks} from '../reader/imported-text-writer.ts';
const {string,optLong,optInt,object}=wireFields;
export const IP_PROTOCOL_VERSION=2;
export type IpTransportKind='wifiLan'|'phoneHotspot'|'bluetoothBridge'|'unknownLocal';
const priorities:Record<IpTransportKind,number>={wifiLan:300,phoneHotspot:250,bluetoothBridge:100,unknownLocal:50};
const kind=(v:unknown):IpTransportKind=>Object.hasOwn(priorities,string(v))?string(v) as IpTransportKind:'unknownLocal';
export interface IpEndpoint {endpointId:string;address:string;family:string;transportKind:IpTransportKind;priority:number}
export interface IpDescriptor {version:number;serverDeviceId:string;epoch:number;expiresAt:number;port:number;endpoints:IpEndpoint[];challengeId:string;challengeSecret:string;hmac:string}
export interface IpHelloAck {serverDeviceId:string;sessionId:string;routeKind:IpTransportKind;acceptedResumeSeq:number;serverNonce:string;hmac:string}
export interface IpCrypto {hmac(secret:string,payload:string):Promise<string>;nonce():Promise<string>}
const str=(o:JsonObject,name:string,fallback='')=>name in o?string(o[name]):fallback;
/** Accept native full and BLE compact descriptor representations. */
export function parseIpDescriptor(o:JsonObject):IpDescriptor {
 const raw=Array.isArray(o.endpoints)?o.endpoints:Array.isArray(o.a)?o.a:[],endpoints:IpEndpoint[]=[];
 for(const candidate of raw){const c=object(candidate);if(c){if(typeof c.endpointId!=='string'||typeof c.address!=='string')continue;const transportKind=kind(c.transportKind);endpoints.push({endpointId:c.endpointId,address:c.address,family:str(c,'family','ipv4'),transportKind,priority:optInt(c,"priority",priorities[transportKind])});}
  else if(Array.isArray(candidate)&&candidate.length>=4){const transportKind=kind(candidate[2]);endpoints.push({endpointId:string(candidate[0]),address:string(candidate[1]),family:'ipv4',transportKind,priority:optInt({priority:candidate[3]},"priority",priorities[transportKind])});}
 }
 const number=(full:string,short:string)=>optLong(o[full],optLong(o[short]));
 return {version:optInt(o,'version',optInt(o,'v')),serverDeviceId:str(o,'serverDeviceId',str(o,'id')),epoch:number('epoch','e'),expiresAt:number('expiresAt','x'),port:optInt(o,'port',optInt(o,'p')),endpoints,challengeId:str(o,'challengeId',str(o,'c')),challengeSecret:str(o,'challengeSecret',str(o,'k')),hmac:str(o,'hmac',str(o,'h'))};
}
export function ipDescriptorPayload(d:IpDescriptor):string {
 const endpoints=[...d.endpoints].sort((a,b)=>b.priority-a.priority||(a.endpointId<b.endpointId?-1:a.endpointId>b.endpointId?1:0));
 return `${d.version}|${d.serverDeviceId}|${d.epoch}|${d.expiresAt}|${d.port}|${endpoints.map(e=>`${e.endpointId},${e.address},${e.family},${e.transportKind},${e.priority};`).join('')}|${d.challengeId}|${d.challengeSecret}`;
}
export function equalIpMac(a:string,b:string):boolean {let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;}
export async function verifyIpDescriptor(d:IpDescriptor,crypto:IpCrypto,now=Date.now()):Promise<boolean>{
 if(d.version!==IP_PROTOCOL_VERSION||d.port<1||d.port>65535||d.expiresAt<now||!d.endpoints.length)return false;
 try{return equalIpMac(await crypto.hmac(d.challengeSecret,ipDescriptorPayload(d)),d.hmac);}catch{return false;}
}
export async function buildIpHello(d:IpDescriptor,watchDeviceId:string,clientNonce:string,resumeSessionId:string|null,lastAckSeq:number,crypto:IpCrypto):Promise<JsonObject>{
 if(!Number.isSafeInteger(lastAckSeq)||lastAckSeq<0)throw new Error('Invalid IP resume sequence');
 const payload=[IP_PROTOCOL_VERSION,watchDeviceId,d.challengeId,d.epoch,clientNonce,resumeSessionId??'',lastAckSeq].join('|');
 return {type:'hello',version:IP_PROTOCOL_VERSION,watchDeviceId,challengeId:d.challengeId,endpointEpoch:d.epoch,clientNonce,...(resumeSessionId!==null?{resumeSessionId}:{}),lastAckSeq,hmac:await crypto.hmac(d.challengeSecret,payload)};
}
export function parseIpHelloAck(o:JsonObject):IpHelloAck {return {serverDeviceId:str(o,'serverDeviceId'),sessionId:str(o,'sessionId'),routeKind:kind(o.routeKind),acceptedResumeSeq:optLong(o.acceptedResumeSeq),serverNonce:str(o,'serverNonce'),hmac:str(o,'hmac')};}
export function ipAckPayload(a:IpHelloAck){return [IP_PROTOCOL_VERSION,a.serverDeviceId,a.sessionId,a.routeKind,a.acceptedResumeSeq,a.serverNonce].join('|');}
export async function verifyIpHelloAck(d:IpDescriptor,a:IpHelloAck,crypto:IpCrypto){return a.serverDeviceId===d.serverDeviceId&&!!a.sessionId.trim()&&equalIpMac(await crypto.hmac(d.challengeSecret,ipAckPayload(a)),a.hmac);}
export function ipUtf8(value:string):Uint8Array {const chunks=[...javaUtf8Chunks(value)],bytes=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}return bytes;}
/** Standard HMAC-SHA256, with host hashing and no dependency on browser WebCrypto. */
export async function ipHmac(key:Uint8Array,payload:string,sha256:(bytes:Uint8Array)=>Promise<Uint8Array>):Promise<Uint8Array>{
 if(!key.length)throw new Error('Empty HMAC key');if(key.length>64)key=await sha256(key);const text=ipUtf8(payload),inner=new Uint8Array(64+text.length),outer=new Uint8Array(96);inner.fill(0x36,0,64);outer.fill(0x5c,0,64);for(let i=0;i<key.length;i++){inner[i]!^=key[i]!;outer[i]!^=key[i]!;}inner.set(text,64);outer.set(await sha256(inner),64);return sha256(outer);
}
